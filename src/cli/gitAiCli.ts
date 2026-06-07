/** git-ai 子命令封装（移植自 GitAiCli.kt：argv、超时一致）。 */
import { find } from "./executableLocator";
import { run, runStreaming, type ProcResult } from "./processRunner";

export class GitAiNotFound extends Error {
  constructor() {
    super("git-ai not found on PATH");
  }
}

export class GitAiCli {
  private constructor(
    readonly exePath: string,
    private readonly repoDir: string | null,
  ) {}

  /** 解析 git-ai；找不到返回 null（上层据此走 degraded 或抛错）。 */
  static resolve(repoDir: string | null, explicitPath: string | null): GitAiCli | null {
    const exe = find("git-ai", explicitPath);
    return exe ? new GitAiCli(exe, repoDir) : null;
  }

  private gitAi(args: string[], timeoutMs: number, cwd: string | null = this.repoDir): Promise<ProcResult> {
    return run(this.exePath, args, cwd, timeoutMs);
  }

  /** `git-ai stats [<sha>] --json`；sha 空白则省略（= HEAD）。 */
  stats(sha: string | null) {
    const args = sha && sha.trim().length > 0 ? ["stats", sha, "--json"] : ["stats", "--json"];
    return this.gitAi(args, 15000);
  }
  status() {
    return this.gitAi(["status", "--json"], 15000);
  }
  /** 区间分析慢，大超时。 */
  statsRange(start: string, end: string) {
    return this.gitAi(["stats", `${start}..${end}`, "--json"], 180000);
  }
  /** `git-ai blame --json [-L start,end ...] <file>`（HEAD 视角，编辑器原生功能用）。 */
  blameJson(file: string, ranges: Array<[number, number]>) {
    const args = ["blame", "--json"];
    for (const [s, e] of ranges) args.push("-L", `${s},${e}`);
    args.push(file);
    return this.gitAi(args, 45000);
  }
  /** `git-ai blame-analysis --json '<payload>'`（webview blame 用，支持任意 ref）。 */
  blameAnalysisJson(file: string, ranges: Array<[number, number]>, newestCommit: string) {
    const payload = JSON.stringify({
      file_path: file,
      options: {
        line_ranges: ranges,
        newest_commit: newestCommit,
        return_human_authors_as_human: true,
        split_hunks_by_ai_author: false,
        // 必须 true：否则 line_authors 的 value 是作者名而非 prompt hash，AI 行全部对不上。
        use_prompt_hashes_as_names: true,
      },
    });
    return this.gitAi(["blame-analysis", "--json", payload], 45000);
  }
  show(sha: string) {
    return this.gitAi(["show", sha.trim()], 15000);
  }
  whoami() {
    return this.gitAi(["whoami"], 10000, null);
  }
  version() {
    return this.gitAi(["--version"], 5000, null);
  }
  debug() {
    return this.gitAi(["debug"], 30000);
  }
  effectiveIgnorePatterns() {
    // 上游 deny_unknown_fields：两个空数组必须给。
    return this.gitAi(
      ["effective-ignore-patterns", "--json", JSON.stringify({ user_patterns: [], extra_patterns: [] })],
      5000,
    );
  }
  debugStreaming(onLine: (line: string) => void) {
    return runStreaming(this.exePath, ["debug"], this.repoDir, 15000, onLine);
  }
  installStreaming(onLine: (line: string) => void) {
    return runStreaming(this.exePath, ["install"], this.repoDir, 120000, onLine);
  }
}
