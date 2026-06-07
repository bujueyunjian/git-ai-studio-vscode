/**
 * 编辑器原生功能的公共支撑（移植自 GitAiActionSupport.kt）：
 * 仓库根 + 仓库相对 POSIX 路径解析、git-ai 调用入口。
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { GitAiCli } from "../cli/gitAiCli";
import { findGitRoot } from "../services/repoService";

/** 锁死的展示常量（对齐桌面墨宠 ADR-011：紫永远=AI、蓝永远=你）。 */
export const ATTRIBUTION_COLORS = {
  aiLight: "#7C6BD6",
  aiDark: "#9C8CF0",
  youLight: "#3A8FB7",
  youDark: "#5BB0D8",
} as const;

export interface FileContext {
  repoDir: string;
  /** 仓库相对 POSIX 路径（传给 git-ai blame）。 */
  relPath: string;
}

/** 文件不在 git 仓库内返回 null。 */
export function resolveFileContext(fsPath: string): FileContext | null {
  const repoDir = findGitRoot(path.dirname(fsPath));
  if (!repoDir) return null;
  const repoAbs = path.resolve(repoDir);
  const fileAbs = path.resolve(fsPath);
  if (!fileAbs.startsWith(repoAbs + path.sep)) return null;
  return {
    repoDir: repoAbs,
    relPath: path.relative(repoAbs, fileAbs).split(path.sep).join("/"),
  };
}

export function gitAiFor(repoDir: string): GitAiCli | null {
  const explicit = vscode.workspace.getConfiguration("gitAiStudio").get<string>("gitAiPath") ?? "";
  return GitAiCli.resolve(repoDir, explicit.trim().length > 0 ? explicit : null);
}
