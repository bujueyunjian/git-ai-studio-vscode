/**
 * 状态栏「AI 占比」widget（移植自 AiShareStatusBarWidget.kt）：
 * 切换编辑器即对当前文件跑 `git-ai blame --json` 求 AI%；点击打开 panel 下钻。
 */
import * as vscode from "vscode";
import { fileShare } from "./attribution";
import { gitAiFor, resolveFileContext } from "./gitAiActionSupport";

const DEFAULT_TEXT = "Git AI";

export class AiShareStatusBar {
  private readonly item: vscode.StatusBarItem;
  /** 最近一次解析的仓库相对路径（点击跳转用）。 */
  currentRel: string | null = null;
  private generation = 0;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem("gitAiStudio.aiShare", vscode.StatusBarAlignment.Right, 50);
    this.item.name = "Git AI: AI Share";
    this.item.text = DEFAULT_TEXT;
    this.item.tooltip = "Git AI · AI authorship of the current file";
    this.item.command = "gitAiStudio.statusBarClick";
    this.item.show();
    context.subscriptions.push(this.item);

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => void this.refresh(editor)),
    );
    void this.refresh(vscode.window.activeTextEditor);
  }

  private setDefault(tooltip: string): void {
    this.currentRel = null;
    this.item.text = DEFAULT_TEXT;
    this.item.tooltip = `Git AI · ${tooltip}`;
  }

  async refresh(editor: vscode.TextEditor | undefined): Promise<void> {
    const gen = ++this.generation;
    if (!editor || editor.document.uri.scheme !== "file") {
      this.setDefault("open a file to see its AI share");
      return;
    }
    const fileName = editor.document.uri.fsPath.split(/[\\/]/).pop() ?? "";
    const ctx = resolveFileContext(editor.document.uri.fsPath);
    if (!ctx) {
      this.setDefault("file not in a git-ai repository");
      return;
    }
    const cli = gitAiFor(ctx.repoDir);
    if (!cli) {
      this.setDefault("git-ai not found on PATH");
      return;
    }
    const totalLines = editor.document.lineCount;
    const r = await cli.blameJson(ctx.relPath, []);
    if (gen !== this.generation) return; // 已切换到其它文件，丢弃过期结果
    if (!r.ok) {
      this.setDefault("attribution unavailable");
      return;
    }
    const share = fileShare(r.stdout, totalLines);
    if (share.total === 0) {
      this.currentRel = ctx.relPath;
      this.item.text = DEFAULT_TEXT;
      this.item.tooltip = `Git AI · no attributed lines in ${fileName}`;
      return;
    }
    this.currentRel = ctx.relPath;
    this.item.text = `AI ${share.pct}%`;
    this.item.tooltip = `Git AI · ${fileName}: AI ${share.ai} · You ${share.total - share.ai} (of ${share.total} attributed lines) — click to open`;
  }
}
