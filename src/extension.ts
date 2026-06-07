/**
 * Git AI Studio for VS Code —— 扩展主入口。
 *
 * 对应 IDEA 插件的 plugin.xml 装配：webview panel（总览 UI）、4 个右键命令、
 * 状态栏 AI 占比、行级归因装饰；外加对齐桌面版的 notes 变更事件
 * （FileSystemWatcher → "git-ai-studio://notes-updated"，驱动前端自动刷新）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { CommandDispatcher, type HostAdapter } from "./bridge/dispatcher";
import { AppSettings, type SettingsStore } from "./services/settings";
import { RepoService } from "./services/repoService";
import { StatsCache } from "./services/statsCache";
import { GitAiPanelHost } from "./webview/panelHost";
import { AttributionGutterController, computeFileSummary } from "./editor/attributionGutter";
import { AiShareStatusBar } from "./editor/statusBar";
import { resolveFileContext } from "./editor/gitAiActionSupport";

const APP_SETTINGS_KEY = "gitAiStudio.appSettingsJson";
const NOTES_UPDATED_EVENT = "git-ai-studio://notes-updated";

class VsCodeSettingsStore implements SettingsStore {
  constructor(private readonly state: vscode.Memento) {}
  getGitAiPath(): string | null {
    const p = vscode.workspace.getConfiguration("gitAiStudio").get<string>("gitAiPath") ?? "";
    return p.trim().length > 0 ? p : null;
  }
  getAppSettingsJson(): string | null {
    return this.state.get<string>(APP_SETTINGS_KEY) ?? null;
  }
  setAppSettingsJson(json: string): void {
    void this.state.update(APP_SETTINGS_KEY, json);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const settings = new AppSettings(new VsCodeSettingsStore(context.globalState));
  const repo = new RepoService(settings, () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null);
  const cache = new StatsCache();

  const host: HostAdapter = {
    async pickDirectory(title) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: title ?? undefined,
      });
      return picked?.[0]?.fsPath ?? null;
    },
    notify(title, body) {
      void vscode.window.showInformationMessage(body.length > 0 ? `${title}: ${body}` : title);
    },
    openInExplorer(p) {
      void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(p));
    },
  };

  // dispatcher.emit → panel（panel 持 dispatcher，dispatcher 持 emit，经转发函数解环）
  let panelHost: GitAiPanelHost | null = null;
  const dispatcher = new CommandDispatcher({
    settings,
    repo,
    cache,
    host,
    emit: (channel, payload) => panelHost?.pushEvent(channel, payload),
  });
  panelHost = new GitAiPanelHost(context, dispatcher);

  const gutter = new AttributionGutterController(context);
  const statusBar = new AiShareStatusBar(context);

  // ---- 命令（与 IDEA 4 个 action 对齐） ----
  context.subscriptions.push(
    vscode.commands.registerCommand("gitAiStudio.openPanel", () => panelHost?.openAt(null)),

    vscode.commands.registerCommand("gitAiStudio.viewProjectMetrics", () => panelHost?.openAt("#/dashboard")),

    vscode.commands.registerCommand("gitAiStudio.viewFileAttribution", (resource?: vscode.Uri) => {
      const fsPath = resource?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!fsPath) {
        void vscode.window.showWarningMessage("No file open in the editor.");
        return;
      }
      const ctx = resolveFileContext(fsPath);
      if (!ctx) {
        void vscode.window.showWarningMessage("The current file is not inside a git repository tracked by git-ai.");
        return;
      }
      panelHost?.openAt(`#/stats/HEAD?file=${encodeURIComponent(ctx.relPath)}`);
    }),

    vscode.commands.registerCommand("gitAiStudio.toggleAttribution", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("No file open in the editor.");
        return;
      }
      void gutter.toggle(editor);
    }),

    vscode.commands.registerCommand("gitAiStudio.fileAiSummary", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("No file open in the editor.");
        return;
      }
      const fileName = editor.document.uri.fsPath.split(/[\\/]/).pop() ?? "";
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Computing AI share…" },
        () => computeFileSummary(editor),
      );
      if (typeof result === "string") {
        void vscode.window.showWarningMessage(result);
        return;
      }
      const parts: string[] = [];
      parts.push(
        result.committed && result.committed.total > 0
          ? `已提交(HEAD)：AI ${result.committed.pct}%（AI ${result.committed.ai} / 共 ${result.committed.total} 行）`
          : "已提交(HEAD)：本文件暂无 AI 归因",
      );
      if (result.working) {
        parts.push(
          `未提交(工作树·整库)：AI ${result.working.ai} · 人工 ${result.working.human} · 未知 ${result.working.unknown}`,
        );
      }
      const open = "Blame in Panel";
      const choice = await vscode.window.showInformationMessage(`${fileName} · AI 占比 — ${parts.join("；")}`, open);
      if (choice === open) {
        void vscode.commands.executeCommand("gitAiStudio.viewFileAttribution", editor.document.uri);
      }
    }),

    vscode.commands.registerCommand("gitAiStudio.statusBarClick", () => {
      if (statusBar.currentRel) {
        panelHost?.openAt(`#/stats/HEAD?file=${encodeURIComponent(statusBar.currentRel)}`);
      } else {
        panelHost?.openAt("#/dashboard");
      }
    }),
  );

  // ---- notes 变更 watcher（对齐桌面版 repo_notes_watcher，commit 后驱动前端刷新） ----
  setupNotesWatcher(context, repo, (repoPath) =>
    panelHost?.pushEvent(NOTES_UPDATED_EVENT, { repo_path: repoPath }),
  );
}

/**
 * 监听 <repo>/.git/refs/notes/ 与 .git/packed-refs，去抖后发 notes-updated 事件。
 * v1 只监听工作区仓库（webview 内切到其它仓库时退回前端轮询/手动刷新）。
 */
function setupNotesWatcher(
  context: vscode.ExtensionContext,
  repo: RepoService,
  onUpdate: (repoPath: string) => void,
): void {
  const repoDir = repo.currentRepoDir();
  if (!repoDir) return;
  const gitDir = path.join(repoDir, ".git");
  if (!fs.existsSync(gitDir)) return;

  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onUpdate(path.resolve(repoDir)), 1000);
  };

  const watchers: fs.FSWatcher[] = [];
  const tryWatch = (target: string) => {
    try {
      if (!fs.existsSync(target)) return;
      watchers.push(fs.watch(target, fire));
    } catch {
      // 监听失败不致命：前端仍可手动刷新
    }
  };
  // refs/notes 目录可能尚不存在：退一级监听 refs/，note 首次写入时也能感知
  tryWatch(path.join(gitDir, "refs", "notes"));
  tryWatch(path.join(gitDir, "refs"));
  tryWatch(path.join(gitDir, "packed-refs"));

  context.subscriptions.push({
    dispose() {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  });
}

export function deactivate(): void {}
