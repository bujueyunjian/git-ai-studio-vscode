/** git 子命令封装（移植自 GitCli.kt：argv、超时一致；工作目录=仓库根）。 */
import { find } from "./executableLocator";
import { run, type ProcResult } from "./processRunner";

export class GitCli {
  private readonly exe: string;

  constructor(private readonly repoDir: string) {
    this.exe = find("git") ?? "git";
  }

  private git(args: string[], timeoutMs: number): Promise<ProcResult> {
    return run(this.exe, args, this.repoDir, timeoutMs);
  }

  revParseHead() {
    return this.git(["rev-parse", "HEAD"], 5000);
  }
  revParseAbbrevHead() {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"], 5000);
  }
  revParseVerifyCommit(ref: string) {
    return this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000);
  }
  notesRefOid() {
    return this.git(["rev-parse", "--verify", "--quiet", "refs/notes/ai"], 5000);
  }
  notesList() {
    return this.git(["notes", "--ref", "refs/notes/ai", "list"], 10000);
  }
  notesShow(sha: string) {
    return this.git(["notes", "--ref", "refs/notes/ai", "show", sha], 10000);
  }
  logRecent(maxCount: number, format: string) {
    return this.git(["log", `-n${maxCount}`, `--format=${format}`, "HEAD"], 15000);
  }
  logNoWalk(format: string, shas: string[]) {
    return this.git(["log", "--no-walk", `--format=${format}`, ...shas], 15000);
  }
  diffTreeNameStatus(sha: string) {
    return this.git(["diff-tree", "--name-status", "-r", "-m", "--no-commit-id", sha], 15000);
  }
  diffTreeNumStat(sha: string) {
    return this.git(["diff-tree", "--numstat", "-r", "-m", "--no-commit-id", sha], 15000);
  }
  lsTreeFiles(ref: string) {
    return this.git(["ls-tree", "-r", "--name-only", ref], 15000);
  }
  showFileAtRef(ref: string, file: string) {
    return this.git(["show", `${ref}:${file}`], 15000);
  }
  catFileExists(ref: string, file: string) {
    return this.git(["cat-file", "-e", `${ref}:${file}`], 5000);
  }
  statusPorcelainZ() {
    return this.git(["status", "--porcelain=v1", "-z"], 10000);
  }
  branchList() {
    return this.git(["branch", "--format=%(HEAD)%09%(refname:short)%09%(objectname)"], 10000);
  }
  checkout(name: string) {
    return this.git(["checkout", name], 30000);
  }
  configUserEmail() {
    return this.git(["config", "user.email"], 5000);
  }
}
