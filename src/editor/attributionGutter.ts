/**
 * 行级 AI 归因装饰（对应 IDEA 的 AnnotateAttributionAction + AiAttributionGutter）。
 *
 * VSCode 没有「行号槽文本注解」API，用 before 装饰列等价呈现：
 * 每行行首一列固定宽度文本 —— AI 行 = 短模型名（紫），人工行 = "·"（蓝），
 * hover 显示完整 agent。与 IDEA 版一致：一次性快照、toggle 关闭、未提交行视为人工。
 */
import * as vscode from "vscode";
import { fileShare, parseLineAttributions, shortModelName } from "./attribution";
import { ATTRIBUTION_COLORS, gitAiFor, resolveFileContext } from "./gitAiActionSupport";

const COLUMN_WIDTH = 20;

export class AttributionGutterController {
  private readonly decoration: vscode.TextEditorDecorationType;
  /** 已激活归因的文档（document.uri.toString()）。 */
  private readonly active = new Set<string>();

  constructor(context: vscode.ExtensionContext) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      before: {
        margin: "0 1em 0 0",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });
    context.subscriptions.push(this.decoration);

    // 文档关闭时清状态
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => this.active.delete(doc.uri.toString())),
    );
  }

  async toggle(editor: vscode.TextEditor): Promise<void> {
    const key = editor.document.uri.toString();
    if (this.active.has(key)) {
      this.active.delete(key);
      editor.setDecorations(this.decoration, []);
      return;
    }

    const ctx = resolveFileContext(editor.document.uri.fsPath);
    if (!ctx) {
      void vscode.window.showWarningMessage("The current file is not inside a git repository tracked by git-ai.");
      return;
    }
    const cli = gitAiFor(ctx.repoDir);
    if (!cli) {
      void vscode.window.showWarningMessage("git-ai not found on PATH.");
      return;
    }

    const totalLines = editor.document.lineCount;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Analyzing AI attribution…" },
      async () => {
        const r = await cli.blameJson(ctx.relPath, []);
        if (!r.ok) {
          const reason = r.timedOut ? "git-ai blame timed out" : r.stderr || `exit ${r.exitCode}`;
          void vscode.window.showWarningMessage(`AI attribution failed: ${reason}`);
          return;
        }
        const byLine = parseLineAttributions(r.stdout, totalLines);
        const options: vscode.DecorationOptions[] = [];
        for (let line = 0; line < totalLines; line++) {
          const a = byLine.get(line);
          if (!a) continue;
          const text = a.isAi ? shortModelName(a.agent) : "·";
          const padded = text.length > COLUMN_WIDTH ? text.slice(0, COLUMN_WIDTH) : text.padEnd(COLUMN_WIDTH, " ");
          options.push({
            range: new vscode.Range(line, 0, line, 0),
            hoverMessage: a.isAi ? `AI-authored — agent: ${a.agent ?? "AI"}` : "Human-authored",
            renderOptions: {
              light: { before: { contentText: padded, color: a.isAi ? ATTRIBUTION_COLORS.aiLight : ATTRIBUTION_COLORS.youLight } },
              dark: { before: { contentText: padded, color: a.isAi ? ATTRIBUTION_COLORS.aiDark : ATTRIBUTION_COLORS.youDark } },
            },
          });
        }
        editor.setDecorations(this.decoration, options);
        this.active.add(key);
      },
    );
  }
}

export interface FileSummary {
  /** blame 失败时为 null（对齐 IDEA：静默视为"暂无归因"，仍展示工作树部分）。 */
  committed: { ai: number; total: number; pct: number } | null;
  working: { ai: number; human: number; unknown: number } | null;
}

/** 文件 AI 占比汇总（对应 FileAiSummaryAction 的两条命令）。 */
export async function computeFileSummary(editor: vscode.TextEditor): Promise<FileSummary | string> {
  const ctx = resolveFileContext(editor.document.uri.fsPath);
  if (!ctx) return "本文件不在 git-ai 跟踪的仓库内。";
  const cli = gitAiFor(ctx.repoDir);
  if (!cli) return "git-ai 未找到（请确认已安装且在 PATH）。";

  const totalLines = editor.document.lineCount;
  const blameR = await cli.blameJson(ctx.relPath, []);
  const committed = blameR.ok ? fileShare(blameR.stdout, totalLines) : null;

  let working: FileSummary["working"] = null;
  const statusR = await cli.status();
  if (statusR.ok && statusR.stdout.trim().length > 0) {
    try {
      const parsed = JSON.parse(statusR.stdout) as Record<string, unknown>;
      const stats = (typeof parsed.stats === "object" && parsed.stats !== null ? parsed.stats : {}) as Record<
        string,
        unknown
      >;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const w = {
        ai: num(stats.ai_additions),
        human: num(stats.human_additions),
        unknown: num(stats.unknown_additions),
      };
      if (w.ai + w.human + w.unknown > 0) working = w;
    } catch {
      working = null;
    }
  }
  return { committed, working };
}
