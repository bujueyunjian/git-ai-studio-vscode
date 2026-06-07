/**
 * 当前仓库解析 + recent 维护（移植自 RepoService.kt）：
 * - 解析顺序：显式选中 > 工作区根向上找 .git。
 * - rememberRecent：队首去重最多 20 条，并写 last_repo。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { GitCli } from "../cli/gitCli";
import type { AppSettings, Json } from "./settings";

export interface RepoEntry {
  path: string;
  name: string;
  head_branch: string;
  head_sha: string;
  dirty: boolean | null;
  has_git_ai_dir: boolean;
  working_logs_count: number;
}

export function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export class RepoService {
  private selectedPath: string | null = null;

  /**
   * @param basePathProvider VSCode 侧返回第一个 workspace folder；冒烟测试注入固定目录。
   */
  constructor(
    private readonly settings: AppSettings,
    private readonly basePathProvider: () => string | null,
  ) {}

  currentRepoDir(): string | null {
    if (this.selectedPath && isDirectory(this.selectedPath)) return this.selectedPath;
    const base = this.basePathProvider();
    if (base) {
      const root = findGitRoot(base);
      if (root) return root;
    }
    return null;
  }

  selectRepo(p: string): string | null {
    if (!isDirectory(p)) return null;
    const root = findGitRoot(p) ?? p;
    this.selectedPath = root;
    this.rememberRecent(root);
    return root;
  }

  rememberRecent(p: string): void {
    const s = this.settings.appSettings();
    const recent = (Array.isArray(s.recent_repos) ? (s.recent_repos as string[]) : []).filter((r) => r !== p);
    s.recent_repos = [p, ...recent.slice(0, 19)];
    s.last_repo = p;
    this.settings.saveAppSettings(s);
  }

  async repoEntry(dir: string): Promise<RepoEntry> {
    const git = new GitCli(dir);
    const [branch, sha, status] = await Promise.all([
      git.revParseAbbrevHead(),
      git.revParseHead(),
      git.statusPorcelainZ(),
    ]);
    const hasGitAiDir =
      fs.existsSync(path.join(dir, ".git", "git-ai")) || fs.existsSync(path.join(dir, ".git-ai"));
    return {
      path: path.resolve(dir),
      name: path.basename(path.resolve(dir)),
      head_branch: branch.ok ? branch.stdout.trim() : "",
      head_sha: sha.ok ? sha.stdout.trim() : "",
      dirty: status.ok ? status.stdout.trim().length > 0 : null,
      has_git_ai_dir: hasGitAiDir,
      working_logs_count: 0,
    };
  }

  async currentRepoEntry(): Promise<RepoEntry | null> {
    const dir = this.currentRepoDir();
    return dir ? this.repoEntry(dir) : null;
  }

  /** 聚合仓库集：explicit 或非空时尊重设置，否则退化为当前仓库。 */
  aggregateRepoPaths(): string[] {
    const s = this.settings.appSettings() as Json;
    const repos = Array.isArray(s.aggregate_repos) ? (s.aggregate_repos as string[]) : [];
    if (s.aggregate_repos_explicit === true || repos.length > 0) return repos;
    const current = this.currentRepoDir();
    return current ? [path.resolve(current)] : [];
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
