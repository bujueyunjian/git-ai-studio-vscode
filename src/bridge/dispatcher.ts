/**
 * 命令分发器（1:1 移植 IDEA 插件 CommandDispatcher.kt）。
 *
 * 契约要点（与 IDEA / 桌面端一致，前端 React 代码零改动复用）：
 * - 入参 args 为 camelCase（maxCount/maxDepth/onlyMine/jobId），例外：blame 系列的 `ref`。
 * - 「无仓库 / 无 git-ai」等预期空态返回 degraded 包络（不是异常）；
 *   真正的故障抛 DispatchError，由桥层编码为 {ok:false, error:<message>}。
 * - 不依赖 vscode 模块：宿主能力（目录选择/通知/文件管理器）经 HostAdapter 注入，
 *   因此可以在纯 Node 冒烟脚本里对真实仓库验证全部命令。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { find as findExecutable } from "../cli/executableLocator";
import { run, runStreaming } from "../cli/processRunner";
import { GitAiCli } from "../cli/gitAiCli";
import { GitCli } from "../cli/gitCli";
import { detectAll, claudeHookMode } from "../agents/agentHookDetector";
import type { AppSettings } from "../services/settings";
import type { RepoService } from "../services/repoService";
import { StatsCache } from "../services/statsCache";
import {
  AiStats,
  DispatchError,
  FILES_CAP,
  HARD_CAP,
  Json,
  LOG_FORMAT,
  MAX_FILE_BYTES,
  VERSION_REGEX,
  argBool,
  argInt,
  argStr,
  argStrArray,
  commitBrief,
  degraded,
  deriveNoteKind,
  errText,
  expandLineRanges,
  localDateKey,
  normalizeAiStats,
  parseAiNote,
  parseLogLines,
  resolveWindow,
  statsView,
  totalAdditions,
  transformBlame,
} from "./protocol";

export interface HostAdapter {
  pickDirectory(title: string | null): Promise<string | null>;
  notify(title: string, body: string): void | Promise<void>;
  openInExplorer(p: string): void | Promise<void>;
}

export type EmitFn = (channel: string, payload: unknown) => void;

export interface DispatcherDeps {
  settings: AppSettings;
  repo: RepoService;
  cache: StatsCache;
  host: HostAdapter;
  emit: EmitFn;
}

interface CommitStatsOutcome {
  stats: AiStats;
  cached: boolean;
  ok: boolean;
}

export class CommandDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  private gitAiOrNull(repoDir: string | null): GitAiCli | null {
    return GitAiCli.resolve(repoDir, this.deps.settings.gitAiPath());
  }

  async dispatch(cmd: string, args: Json): Promise<unknown> {
    switch (cmd) {
      // ---- 基础 / 探针 ----
      case "ping":
        return "pong";
      case "resolve_git_ai_path": {
        const p = findExecutable("git-ai", this.deps.settings.gitAiPath());
        return p ? [true, p] : [false, ""];
      }
      case "get_installed_version":
        return this.getInstalledVersion();

      // ---- AI 编码工具（Claude Code / Codex）npm 装卸 ----
      case "refresh_path_env":
        return null; // 可执行解析每次实时扫描，无缓存可刷；no-op 即可触发前端重探
      case "detect_npm":
        return this.detectNpm();
      case "detect_agent_cli": {
        const agent = argStr(args, "agent");
        if (!agent) throw new DispatchError("missing agent");
        return this.detectAgentCli(agent);
      }
      case "install_agent_cli": {
        const jobId = argStr(args, "jobId");
        const agent = argStr(args, "agent");
        if (!jobId) throw new DispatchError("missing jobId");
        if (!agent) throw new DispatchError("missing agent");
        return this.installAgentCli(jobId, agent, argStr(args, "version"));
      }
      case "uninstall_agent_cli": {
        const jobId = argStr(args, "jobId");
        const agent = argStr(args, "agent");
        const confirmToken = argStr(args, "confirmToken");
        if (!jobId) throw new DispatchError("missing jobId");
        if (!agent) throw new DispatchError("missing agent");
        if (confirmToken === null) throw new DispatchError("missing confirmToken");
        return this.uninstallAgentCli(jobId, agent, confirmToken);
      }

      // ---- 应用设置 ----
      case "get_app_settings": {
        const s = this.deps.settings.appSettings();
        if (s.last_repo === null || s.last_repo === undefined) {
          const dir = this.deps.repo.currentRepoDir();
          if (dir) s.last_repo = dir; // 仅本次 payload 合成，不持久化
        }
        return s;
      }
      case "set_app_settings":
        return this.deps.settings.applySettingsPatch(args);
      case "get_auto_launch_status":
        return false;
      case "set_auto_launch":
        return argBool(args, "enabled", false);

      // ---- 仓库管理 ----
      case "current_repo":
      case "restore_last_repo":
        return this.deps.repo.currentRepoEntry();
      case "select_repo": {
        const p = argStr(args, "path");
        if (!p) throw new DispatchError("missing path");
        if (!isDirectory(p)) throw new DispatchError(`Not a directory: ${p}`);
        const root = this.deps.repo.selectRepo(p);
        if (!root) throw new DispatchError(`Not a directory: ${p}`);
        return this.deps.repo.repoEntry(root);
      }
      case "current_git_user_email": {
        const dir = this.deps.repo.currentRepoDir();
        if (!dir) return null;
        const r = await new GitCli(dir).configUserEmail();
        const email = r.ok ? r.stdout.trim() : "";
        return email.length > 0 ? email : null;
      }
      case "detect_dirty": {
        const p = argStr(args, "path");
        if (!p) return null;
        const r = await new GitCli(p).statusPorcelainZ();
        return r.ok ? r.stdout.trim().length > 0 : null;
      }
      case "list_recent_repos":
        return this.deps.settings.appSettings().recent_repos;
      case "list_scan_roots":
        return this.deps.settings.appSettings().scan_roots;
      case "set_scan_roots": {
        const s = this.deps.settings.appSettings();
        s.scan_roots = argStrArray(args, "roots");
        this.deps.settings.saveAppSettings(s);
        return null;
      }
      case "discover_repos":
        return this.discoverRepos(argStrArray(args, "roots"), argInt(args, "maxDepth", 2));
      case "open_in_explorer": {
        const p = argStr(args, "path");
        if (!p) throw new DispatchError("missing path");
        await this.deps.host.openInExplorer(p);
        return null;
      }
      case "get_aggregate_repos": {
        const out: Json[] = [];
        for (const p of this.deps.repo.aggregateRepoPaths()) {
          const valid = isDirectory(p) && fs.existsSync(path.join(p, ".git"));
          out.push({
            path: p,
            valid,
            entry: valid ? await this.deps.repo.repoEntry(p) : null,
          });
        }
        return out;
      }
      case "set_aggregate_repos": {
        const s = this.deps.settings.appSettings();
        s.aggregate_repos = argStrArray(args, "repos");
        s.aggregate_repos_explicit = true;
        this.deps.settings.saveAppSettings(s);
        return null;
      }

      // ---- 提交列表 / 单提交归因 ----
      case "list_recent_commits": {
        const dir = this.deps.repo.currentRepoDir();
        if (!dir) return [];
        const r = await new GitCli(dir).logRecent(argInt(args, "maxCount", 50), LOG_FORMAT);
        return parseLogLines(r.ok ? r.stdout : "").map(commitBrief);
      }
      case "list_recent_commits_with_stats":
        return this.listRecentCommitsWithStats(argInt(args, "maxCount", 50));
      case "get_commit_stats":
        return this.getCommitStats(argStr(args, "sha"));
      case "get_commit_status":
        return this.getCommitStatus();

      // ---- 历史 / 聚合 / 人员 ----
      case "get_history":
        return this.getHistory(rangeOf(args));
      case "get_aggregate_history":
        return this.getAggregateHistory(rangeOf(args), argBool(args, "onlyMine", false));
      case "get_aggregate_working_status":
        return this.getAggregateWorkingStatus();
      case "get_people_breakdown":
        return this.getPeopleBreakdown(rangeOf(args));
      case "get_range_summary":
        return this.getRangeSummary(rangeOf(args));

      // ---- AI Notes / Diff ----
      case "list_ai_notes":
        return this.listAiNotes();
      case "show_ai_note": {
        const sha = argStr(args, "sha");
        if (!sha) throw new DispatchError("missing sha");
        return this.showAiNote(sha);
      }
      case "list_changed_files_in_commit": {
        const sha = argStr(args, "sha");
        if (!sha) throw new DispatchError("missing sha");
        return this.listChangedFilesInCommit(sha);
      }
      case "list_ai_lines_in_commit": {
        const sha = argStr(args, "sha");
        if (!sha) throw new DispatchError("missing sha");
        return this.listAiLinesInCommit(sha);
      }

      // ---- 分支 / 文件 ----
      case "list_branches":
        return this.listBranches();
      case "checkout_branch": {
        const name = argStr(args, "name");
        if (!name) throw new DispatchError("missing name");
        const dir = this.deps.repo.currentRepoDir();
        if (!dir) throw new DispatchError("No repository");
        const r = await new GitCli(dir).checkout(name);
        return r.ok
          ? { status: "ok", branch: name }
          : { status: "error", message: r.stderr.trim().length > 0 ? r.stderr : "checkout failed" };
      }
      case "list_files_at_head":
        return this.listFilesAtRef(headRef(argStr(args, "sha")));
      case "list_files_at_ref":
        return this.listFilesAtRef(argStr(args, "ref") ?? "HEAD");
      case "read_file_at_head": {
        const file = argStr(args, "file");
        if (!file) throw new DispatchError("missing file");
        return this.readFileAtRef(headRef(argStr(args, "sha")), file);
      }
      case "read_file_at_ref": {
        const file = argStr(args, "file");
        if (!file) throw new DispatchError("missing file");
        return this.readFileAtRef(argStr(args, "ref") ?? "HEAD", file);
      }

      // ---- Blame ----
      case "get_blame": {
        const file = argStr(args, "file");
        if (!file) throw new DispatchError("missing file");
        return this.getBlame(headRef(argStr(args, "sha")), file, rangesOf(args));
      }
      case "get_blame_at_ref": {
        const file = argStr(args, "file");
        if (!file) throw new DispatchError("missing file");
        return this.getBlame(argStr(args, "ref") ?? "HEAD", file, rangesOf(args));
      }

      // ---- whoami / show / ignore ----
      case "get_whoami":
        return this.getWhoami();
      case "get_show_raw": {
        const sha = argStr(args, "sha");
        if (!sha) throw new DispatchError("missing sha");
        const dir = this.deps.repo.currentRepoDir();
        if (!dir) throw new DispatchError("No repository");
        const cli = this.gitAiOrNull(dir);
        if (!cli) throw new DispatchError("git-ai not found");
        const r = await cli.show(sha);
        if (!r.ok) throw new DispatchError(`git-ai show failed: ${errText(r)}`);
        return { sha, raw: r.stdout };
      }
      case "list_effective_ignore_patterns":
        return this.listEffectiveIgnorePatterns();

      // ---- 系统 / 杂项 / 诊断 ----
      case "pick_directory":
        return this.deps.host.pickDirectory(argStr(args, "title"));
      case "notify":
        await this.deps.host.notify(argStr(args, "title") ?? "", argStr(args, "body") ?? "");
        return null;
      case "clear_stats_cache":
        return this.deps.cache.clear();
      case "invalidate_diagnostic_cache":
        return null;
      case "run_git_ai_debug_report": {
        const jobId = argStr(args, "jobId");
        if (!jobId) throw new DispatchError("missing jobId");
        return this.streamGitAi(`logs://debug/${jobId}`, "debug");
      }
      case "install_hooks_official":
      case "install_hooks_for_agent": {
        const jobId = argStr(args, "jobId");
        if (!jobId) throw new DispatchError("missing jobId");
        return this.streamGitAi(`hooks://${jobId}/log`, "install");
      }
      case "diagnose_environment":
        return this.diagnoseEnvironment();
      case "check_agent_hooks":
        return null;
      case "get_hooks_status":
        return { mode: claudeHookMode() };
      case "read_claude_settings":
        return this.readClaudeSettings();
      case "list_settings_backups":
        return this.listSettingsBackups();
      case "get_git_ai_config":
        return this.getGitAiConfig();
      case "diagnose_git_ai_daemon":
        return { kind: "idle" };

      default:
        throw new DispatchError(`Command not implemented in plugin v1: ${cmd}`);
    }
  }

  // ---------- 实现细节 ----------

  private async getInstalledVersion(): Promise<Json> {
    const exe = findExecutable("git-ai", this.deps.settings.gitAiPath());
    if (!exe) return { installed: false, version: null, binary_path: null };
    const cli = this.gitAiOrNull(null)!;
    const r = await cli.version();
    // 对齐 Kotlin：不看退出码，直接从 stdout 抽版本串
    const version = VERSION_REGEX.exec(r.stdout)?.[0] ?? null;
    return { installed: true, version, binary_path: exe };
  }

  private async discoverRepos(roots: string[], maxDepth: number): Promise<Json[]> {
    const found = new Set<string>(); // 按绝对路径去重（roots 重叠时不重复收录）
    const walk = (dir: string, depthLeft: number) => {
      if (fs.existsSync(path.join(dir, ".git"))) {
        found.add(path.resolve(dir));
        return; // 收录即停止下钻
      }
      if (depthLeft <= 0) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith(".")) continue;
        walk(path.join(dir, e.name), depthLeft - 1);
      }
    };
    for (const root of roots) {
      if (isDirectory(root)) walk(path.resolve(root), maxDepth);
    }
    const out: Json[] = [];
    for (const dir of found) {
      try {
        out.push((await this.deps.repo.repoEntry(dir)) as unknown as Json);
      } catch {
        // 构造失败的跳过
      }
    }
    return out;
  }

  /** notes ref OID（缓存 key 第三段）；取不到用 "no-notes"。 */
  private async notesOid(git: GitCli): Promise<string> {
    const r = await git.notesRefOid();
    return r.ok && r.stdout.trim().length > 0 ? r.stdout.trim() : "no-notes";
  }

  /** 单 commit stats（带会话缓存；失败/超时不缓存，返回空 stats + ok=false）。 */
  private async commitStats(
    repoDir: string,
    gitAi: GitAiCli,
    sha: string,
    notesOid: string,
  ): Promise<CommitStatsOutcome> {
    const key = StatsCache.key(path.resolve(repoDir), sha, notesOid);
    const hit = this.deps.cache.get(key);
    if (hit !== null) {
      return { stats: normalizeAiStats(hit), cached: true, ok: true };
    }
    const r = await gitAi.stats(sha);
    if (r.timedOut || (r.exitCode !== 0 && r.stdout.trim().length === 0)) {
      return { stats: normalizeAiStats({}), cached: false, ok: false };
    }
    // 非法 JSON 与 Kotlin parseJsonObjectOrEmpty 一致：按空对象归一化，视为成功并缓存
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = {};
    }
    const stats = normalizeAiStats(parsed);
    this.deps.cache.put(key, stats);
    return { stats, cached: false, ok: true };
  }

  private async listRecentCommitsWithStats(maxCount: number): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) return degraded("git_ai_missing");
    const git = new GitCli(dir);
    const log = await git.logRecent(maxCount, LOG_FORMAT);
    const metas = parseLogLines(log.ok ? log.stdout : "");
    const oid = await this.notesOid(git);

    const commits: Json[] = [];
    const failedShas: string[] = [];
    let cacheHits = 0;
    for (const m of metas) {
      const outcome = await this.commitStats(dir, gitAi, m.sha, oid);
      if (!outcome.ok) failedShas.push(m.sha);
      if (outcome.cached) cacheHits++;
      const total = totalAdditions(outcome.stats);
      commits.push({
        sha: m.sha,
        short: m.short,
        authored_at: m.authoredAt,
        author_name: m.authorName,
        author_email: m.authorEmail,
        subject: m.subject,
        is_merge: m.isMerge,
        stats: outcome.stats,
        note_kind: deriveNoteKind(outcome.stats, total, m.isMerge),
      });
    }
    return {
      status: "ok",
      payload: {
        commits,
        failed_shas: failedShas,
        truncated: metas.length >= maxCount,
        cache_hits: cacheHits,
      },
    };
  }

  private async getCommitStats(sha: string | null): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) return degraded("git_ai_missing");
    const git = new GitCli(dir);

    let target = sha?.trim() ?? "";
    if (target.length === 0) {
      const head = await git.revParseHead();
      if (!head.ok) return degraded("no_head");
      target = head.stdout.trim();
    }

    const r = await gitAi.stats(target);
    if (r.timedOut) throw new DispatchError("git-ai stats timed out");
    let stats = normalizeAiStats({});
    if (r.ok || r.stdout.trim().length > 0) {
      try {
        stats = normalizeAiStats(JSON.parse(r.stdout));
      } catch {
        stats = normalizeAiStats({});
      }
    }

    const parentsR = await git.logNoWalk("%P", [target]);
    const isMerge = parentsR.ok && parentsR.stdout.trim().split(/\s+/).filter((s) => s.length > 0).length > 1;

    return { status: "ok", view: statsView("commit", target, isMerge, stats) };
  }

  private async getCommitStatus(): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) return degraded("git_ai_missing");
    const r = await gitAi.status();
    if (r.timedOut) throw new DispatchError("git-ai status timed out");
    let stats = normalizeAiStats({});
    if (r.stdout.trim().length > 0) {
      try {
        const parsed = JSON.parse(r.stdout) as Json;
        stats = normalizeAiStats(parsed.stats);
      } catch {
        stats = normalizeAiStats({});
      }
    }
    return { status: "ok", view: statsView("working", null, false, stats) };
  }

  private async getHistory(range: Json | null): Promise<Json> {
    const t0 = Date.now();
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) return degraded("git_ai_missing");
    const git = new GitCli(dir);
    const { startMs, endMs } = resolveWindow(range);

    const log = await git.logRecent(HARD_CAP, LOG_FORMAT);
    const all = parseLogLines(log.ok ? log.stdout : "");
    const inWindow = all.filter((m) => m.committerMs >= startMs && m.committerMs <= endMs);
    const oid = await this.notesOid(git);

    const perCommit: Json[] = [];
    const failedShas: string[] = [];
    let cacheHits = 0;
    const buckets = new Map<string, { human: number; unknown: number; ai: number; commits: number }>();

    for (const m of inWindow) {
      const outcome = await this.commitStats(dir, gitAi, m.sha, oid);
      if (!outcome.ok) failedShas.push(m.sha);
      if (outcome.cached) cacheHits++;
      perCommit.push({
        sha: m.sha,
        short: m.short,
        authored_at: m.authoredAt,
        is_merge: m.isMerge,
        stats: outcome.stats,
      });
      const key = localDateKey(m.committerMs);
      const b = buckets.get(key) ?? { human: 0, unknown: 0, ai: 0, commits: 0 };
      b.human += outcome.stats.human_additions;
      b.unknown += outcome.stats.unknown_additions;
      b.ai += outcome.stats.ai_additions;
      b.commits += 1;
      buckets.set(key, b);
    }

    return {
      status: "ok",
      payload: {
        range,
        range_start_unix_ms: startMs,
        range_end_unix_ms: endMs,
        total_commits_in_window: inWindow.length,
        per_commit: perCommit,
        daily_buckets: dailyBuckets(buckets),
        cache_hits: cacheHits,
        cached_repo_total: all.length,
        failed_shas: failedShas,
        truncated: all.length >= HARD_CAP,
        took_ms: Date.now() - t0,
      },
    };
  }

  private async getAggregateHistory(range: Json | null, onlyMine: boolean): Promise<Json> {
    const t0 = Date.now();
    const repoPaths = this.deps.repo.aggregateRepoPaths().filter((p) => isDirectory(p));
    if (repoPaths.length === 0) return degraded("no_repos_selected");
    const { startMs, endMs } = resolveWindow(range);

    let myEmail: string | null = null;
    if (onlyMine) {
      const dir = this.deps.repo.currentRepoDir();
      if (dir) {
        const r = await new GitCli(dir).configUserEmail();
        // 对齐 Kotlin：仅按 ok 判定，空串也是有效过滤值（未配置邮箱时窗口近乎为空）
        myEmail = r.ok ? r.stdout.trim().toLowerCase() : null;
      }
    }

    const perCommit: Json[] = [];
    const failedRepos: Json[] = [];
    const failedShas: Json[] = [];
    const truncatedRepos: string[] = [];
    let cacheHits = 0;
    const buckets = new Map<string, { human: number; unknown: number; ai: number; commits: number }>();

    for (const repoPath of repoPaths) {
      const gitAi = this.gitAiOrNull(repoPath);
      if (!gitAi) {
        failedRepos.push({ repo_path: repoPath, reason: "git-ai not found" });
        continue;
      }
      const git = new GitCli(repoPath);
      const log = await git.logRecent(HARD_CAP, LOG_FORMAT);
      const all = parseLogLines(log.ok ? log.stdout : "");
      if (all.length >= HARD_CAP) truncatedRepos.push(repoPath);
      const oid = await this.notesOid(git);

      for (const m of all) {
        if (m.committerMs < startMs || m.committerMs > endMs) continue;
        if (myEmail && m.authorEmail.toLowerCase() !== myEmail) continue;
        const outcome = await this.commitStats(repoPath, gitAi, m.sha, oid);
        if (!outcome.ok) failedShas.push({ repo_path: repoPath, sha: m.sha });
        if (outcome.cached) cacheHits++;
        perCommit.push({
          repo_path: repoPath,
          sha: m.sha,
          short: m.short,
          authored_at: m.authoredAt,
          is_merge: m.isMerge,
          stats: outcome.stats,
        });
        const key = localDateKey(m.committerMs);
        const b = buckets.get(key) ?? { human: 0, unknown: 0, ai: 0, commits: 0 };
        b.human += outcome.stats.human_additions;
        b.unknown += outcome.stats.unknown_additions;
        b.ai += outcome.stats.ai_additions;
        b.commits += 1;
        buckets.set(key, b);
      }
    }

    return {
      status: "ok",
      payload: {
        range,
        range_start_unix_ms: startMs,
        range_end_unix_ms: endMs,
        total_commits_in_window: perCommit.length,
        per_commit: perCommit,
        daily_buckets: dailyBuckets(buckets),
        cache_hits: cacheHits,
        failed_repos: failedRepos,
        failed_shas: failedShas,
        truncated_repos: truncatedRepos,
        took_ms: Date.now() - t0,
      },
    };
  }

  private async getAggregateWorkingStatus(): Promise<Json> {
    const t0 = Date.now();
    const repoPaths = this.deps.repo.aggregateRepoPaths().filter((p) => isDirectory(p));

    let human = 0;
    let unknown = 0;
    let ai = 0;
    const perRepo: Json[] = [];
    const failedRepos: Json[] = [];

    for (const repoPath of repoPaths) {
      const gitAi = this.gitAiOrNull(repoPath);
      if (!gitAi) {
        failedRepos.push({ repo_path: repoPath, reason: "git-ai not found" });
        continue;
      }
      const r = await gitAi.status();
      if (r.timedOut) {
        failedRepos.push({ repo_path: repoPath, reason: "git-ai status timed out" });
        continue;
      }
      let stats = normalizeAiStats({});
      if (r.stdout.trim().length > 0) {
        try {
          stats = normalizeAiStats((JSON.parse(r.stdout) as Json).stats);
        } catch {
          stats = normalizeAiStats({});
        }
      }
      const total = totalAdditions(stats);
      if (total > 0) {
        perRepo.push({
          repo_path: repoPath,
          human_additions: stats.human_additions,
          unknown_additions: stats.unknown_additions,
          ai_additions: stats.ai_additions,
        });
        human += stats.human_additions;
        unknown += stats.unknown_additions;
        ai += stats.ai_additions;
      }
    }

    return {
      repos_with_changes: perRepo.length,
      human_additions: human,
      unknown_additions: unknown,
      ai_additions: ai,
      per_repo: perRepo,
      failed_repos: failedRepos,
      took_ms: Date.now() - t0,
    };
  }

  private async getPeopleBreakdown(range: Json | null): Promise<Json> {
    const t0 = Date.now();
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) return degraded("git_ai_missing");
    const git = new GitCli(dir);
    const { startMs, endMs } = resolveWindow(range);

    const log = await git.logRecent(HARD_CAP, LOG_FORMAT);
    const all = parseLogLines(log.ok ? log.stdout : "");
    const inWindow = all.filter((m) => m.committerMs >= startMs && m.committerMs <= endMs);
    const oid = await this.notesOid(git);

    interface Row {
      authorName: string;
      authorEmail: string;
      latestMs: number;
      commits: number;
      human: number;
      unknown: number;
      ai: number;
      refs: Json[];
    }
    const rows = new Map<string, Row>();
    const failedShas: string[] = [];
    let cacheHits = 0;
    let grandCommits = 0;

    for (const m of inWindow) {
      const outcome = await this.commitStats(dir, gitAi, m.sha, oid);
      if (!outcome.ok) failedShas.push(m.sha);
      if (outcome.cached) cacheHits++;
      const key = m.authorEmail.toLowerCase();
      let row = rows.get(key);
      if (!row) {
        row = { authorName: m.authorName, authorEmail: m.authorEmail, latestMs: m.committerMs, commits: 0, human: 0, unknown: 0, ai: 0, refs: [] };
        rows.set(key, row);
      }
      if (m.committerMs >= row.latestMs) {
        row.latestMs = m.committerMs;
        row.authorName = m.authorName; // 最近 commit 的 %an
        row.authorEmail = m.authorEmail;
      }
      row.commits += 1;
      row.human += outcome.stats.human_additions;
      row.unknown += outcome.stats.unknown_additions;
      row.ai += outcome.stats.ai_additions;
      row.refs.push({
        sha: m.sha,
        short: m.short,
        authored_at: m.authoredAt,
        subject: m.subject,
        is_merge: m.isMerge,
        ai_additions: outcome.stats.ai_additions,
        human_additions: outcome.stats.human_additions,
        unknown_additions: outcome.stats.unknown_additions,
      });
      grandCommits += 1;
    }

    let gHuman = 0;
    let gUnknown = 0;
    let gAi = 0;
    const outRows = [...rows.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([identityKey, r]) => {
        gHuman += r.human;
        gUnknown += r.unknown;
        gAi += r.ai;
        return {
          identity_key: identityKey,
          author_name: r.authorName,
          author_email: r.authorEmail,
          commits: r.commits,
          human_additions: r.human,
          unknown_additions: r.unknown,
          ai_additions: r.ai,
          total_additions: r.human + r.unknown + r.ai,
          commit_refs: r.refs,
        };
      });

    return {
      status: "ok",
      payload: {
        range,
        range_start_unix_ms: startMs,
        range_end_unix_ms: endMs,
        rows: outRows,
        grand_total: {
          commits: grandCommits,
          human_additions: gHuman,
          unknown_additions: gUnknown,
          ai_additions: gAi,
          total_additions: gHuman + gUnknown + gAi,
        },
        failed_shas: failedShas,
        truncated: all.length >= HARD_CAP,
        cache_hits: cacheHits,
        took_ms: Date.now() - t0,
      },
    };
  }

  private async getRangeSummary(range: Json | null): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) return degraded("git_ai_missing");
    const git = new GitCli(dir);
    const { startMs, endMs } = resolveWindow(range);

    const log = await git.logRecent(HARD_CAP, LOG_FORMAT);
    const inWindow = parseLogLines(log.ok ? log.stdout : "").filter(
      (m) => m.committerMs >= startMs && m.committerMs <= endMs,
    );
    if (inWindow.length === 0) return degraded("repo_missing"); // 窗口为空时复用该 kind（对齐 Kotlin）

    const newest = inWindow[0].sha;
    const oldest = inWindow[inWindow.length - 1].sha;
    const r = await gitAi.statsRange(`${oldest}^`, newest);
    if (r.timedOut) throw new DispatchError("git-ai stats (range) timed out");
    let out: Json = {};
    if (r.stdout.trim().length > 0) {
      try {
        out = JSON.parse(r.stdout) as Json;
      } catch {
        out = {};
      }
    }
    const authorship = out.authorship_stats;
    return {
      status: "ok",
      range_summary: {
        authorship_stats:
          typeof authorship === "object" && authorship !== null && !Array.isArray(authorship) ? authorship : {},
        range_stats: normalizeAiStats(out.range_stats),
      },
    };
  }

  private async listAiNotes(): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const git = new GitCli(dir);
    const listR = await git.notesList();
    if (!listR.ok || listR.stdout.trim().length === 0) return degraded("no_notes_in_repo");

    // 每行 "<note_oid> <commit_sha>"，同 commit 只取首个 note oid
    const noteBySha = new Map<string, string>();
    for (const line of listR.stdout.split("\n")) {
      const t = line.trim();
      if (t.length === 0) continue;
      const sp = t.indexOf(" ");
      if (sp <= 0) continue;
      const noteOid = t.slice(0, sp);
      const sha = t.slice(sp + 1).trim();
      if (!noteBySha.has(sha)) noteBySha.set(sha, noteOid);
    }
    if (noteBySha.size === 0) return degraded("no_notes_in_repo");

    const notes: Json[] = [];
    const unreachable: string[] = [];
    for (const [sha, noteOid] of noteBySha) {
      const metaR = await git.logNoWalk(LOG_FORMAT, [sha]);
      const metas = parseLogLines(metaR.ok ? metaR.stdout : "");
      if (metas.length === 0) {
        unreachable.push(sha);
        continue;
      }
      const m = metas[0];
      notes.push({
        commit_sha: m.sha,
        short_sha: m.short,
        note_oid: noteOid,
        committed_at: m.authoredAt,
        subject: m.subject,
      });
    }

    const headR = await git.revParseHead();
    const headSha = headR.ok && headR.stdout.trim().length > 0 ? headR.stdout.trim() : null;
    return {
      status: "ok",
      payload: {
        repo_path: path.resolve(dir),
        head_sha: headSha,
        notes,
        unreachable_shas: unreachable,
      },
    };
  }

  private async showAiNote(sha: string): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const git = new GitCli(dir);
    const verify = await git.revParseVerifyCommit(sha);
    if (!verify.ok) return degraded("no_notes_in_repo");
    const r = await git.notesShow(sha);
    if (!r.ok) {
      if (r.stderr.toLowerCase().includes("no note") || r.stdout.trim().length === 0) {
        return degraded("no_notes_in_repo");
      }
      throw new DispatchError(`git notes show failed: ${errText(r)}`);
    }
    const { attestations, metadata } = parseAiNote(r.stdout);
    const meta: Json = { ...metadata };
    if (!("schema_version" in meta)) meta.schema_version = "";
    if (!("git_ai_version" in meta)) meta.git_ai_version = null;
    if (!("base_commit_sha" in meta)) meta.base_commit_sha = sha;
    if (!("prompts" in meta)) meta.prompts = {};
    if (!("humans" in meta)) meta.humans = {};
    if (!("sessions" in meta)) meta.sessions = {};
    return {
      status: "ok",
      payload: { commit_sha: sha, log: { attestations, metadata: meta } },
    };
  }

  private async listChangedFilesInCommit(sha: string): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) throw new DispatchError("No repository");
    const r = await new GitCli(dir).diffTreeNameStatus(sha);
    if (!r.ok) throw new DispatchError(`git diff-tree failed: ${errText(r)}`);
    const seen = new Set<string>();
    const files: Json[] = [];
    for (const line of r.stdout.split("\n")) {
      const cols = line.trim().split("\t");
      if (cols.length < 2) continue;
      const status = cols[0].charAt(0) || "M";
      const p = cols[cols.length - 1]; // 末列：rename/copy 行（R100\told\tnew）取新路径
      if (seen.has(p)) continue;
      seen.add(p);
      files.push({ path: p, status });
    }
    return { files };
  }

  private async listAiLinesInCommit(sha: string): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const git = new GitCli(dir);
    const verify = await git.revParseVerifyCommit(sha);
    if (!verify.ok) return { status: "degraded", reason: { kind: "invalid_sha", sha } };
    const r = await git.notesShow(sha);
    const lines: Json[] = [];
    if (r.ok) {
      const { attestations } = parseAiNote(r.stdout);
      for (const att of attestations) {
        for (const entry of att.entries) {
          for (const [start, end] of expandLineRanges(entry.line_ranges)) {
            lines.push({ file: att.file_path, line_start: start, line_end: end });
          }
        }
      }
    }
    return { status: "ok", lines };
  }

  private async listBranches(): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return { branches: [], current: null };
    const r = await new GitCli(dir).branchList();
    const branches: Json[] = [];
    let current: string | null = null;
    if (r.ok) {
      for (const line of r.stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const cols = line.split("\t");
        if (cols.length < 3) continue;
        const isCurrent = cols[0].trim() === "*";
        const name = cols[1];
        branches.push({ name, sha: cols[2], is_current: isCurrent });
        if (isCurrent) current = name;
      }
    }
    return { branches, current };
  }

  private async listFilesAtRef(ref: string): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return { files: [], truncated: false };
    const r = await new GitCli(dir).lsTreeFiles(ref);
    if (!r.ok) throw new DispatchError(`git ls-tree failed: ${errText(r)}`);
    const all = r.stdout.split("\n").filter((l) => l.length > 0);
    return { files: all.slice(0, FILES_CAP), truncated: all.length > FILES_CAP };
  }

  private async readFileAtRef(ref: string, file: string): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const r = await new GitCli(dir).showFileAtRef(ref, file);
    if (!r.ok) return degraded("file_not_in_head", { file });
    const text = r.stdout;
    if (text.slice(0, 8000).includes("\u0000")) return degraded("file_binary");
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_FILE_BYTES) return degraded("file_too_large", { size, limit: MAX_FILE_BYTES });
    return { status: "ok", text, size };
  }

  private async getBlame(ref: string, file: string, ranges: Array<[number, number]>): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) return degraded("git_ai_missing");
    const git = new GitCli(dir);
    if (ref !== "HEAD") {
      const verify = await git.revParseVerifyCommit(ref);
      if (!verify.ok) return degraded("ref_not_found", { ref });
    }
    const exists = await git.catFileExists(ref, file);
    if (!exists.ok) return degraded("file_not_in_head", { file });

    const r = await gitAi.blameAnalysisJson(file, ranges, ref);
    if (r.timedOut) throw new DispatchError("git-ai blame-analysis timed out");
    if (!r.ok) throw new DispatchError(`git-ai blame-analysis failed: ${errText(r)}`);
    let analysis: Json;
    try {
      analysis = JSON.parse(r.stdout) as Json;
    } catch {
      throw new DispatchError("git-ai blame-analysis returned invalid JSON");
    }
    return { status: "ok", payload: transformBlame(analysis) };
  }

  private async getWhoami(): Promise<Json> {
    const cli = this.gitAiOrNull(null);
    if (!cli) return { authenticated: false, raw: "" };
    const r = await cli.whoami();
    const fields: Json = {};
    for (const line of r.stdout.split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      // 对齐 Kotlin replace(' ', '_')：仅逐个替换空格，不折叠其它空白
      const key = line.slice(0, idx).trim().toLowerCase().replace(/ /g, "_");
      fields[key] = line.slice(idx + 1).trim();
    }
    return { authenticated: r.ok, fields, raw: r.stdout };
  }

  private async listEffectiveIgnorePatterns(): Promise<Json> {
    const dir = this.deps.repo.currentRepoDir();
    if (!dir) return degraded("repo_missing");
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) return degraded("git_ai_missing");
    const r = await gitAi.effectiveIgnorePatterns();
    if (!r.ok) throw new DispatchError(`git-ai effective-ignore-patterns failed: ${errText(r)}`);
    let patterns: unknown[] = [];
    try {
      const parsed = JSON.parse(r.stdout) as Json;
      if (Array.isArray(parsed.patterns)) patterns = parsed.patterns;
    } catch {
      patterns = [];
    }
    return { status: "ok", payload: { repo_path: path.resolve(dir), patterns } };
  }

  private async streamGitAi(channel: string, mode: "debug" | "install"): Promise<number> {
    const dir = this.deps.repo.currentRepoDir();
    const cli = this.gitAiOrNull(dir);
    if (!cli) throw new DispatchError("git-ai not found on PATH");
    const onLine = (line: string) =>
      this.deps.emit(channel, { stream: "stdout", line, ts: Date.now() });
    const code = mode === "debug" ? await cli.debugStreaming(onLine) : await cli.installStreaming(onLine);
    const exitPayload: Json = { stream: "exit", code, ts: Date.now() };
    if (code === -1) exitPayload.timeout = true;
    this.deps.emit(channel, exitPayload);
    return code;
  }

  // ---------- AI 编码工具（Claude Code / Codex）npm 装卸 ----------

  /** npm 探测：available=false 是预期空态（未装 Node），绝不抛错。 */
  private async detectNpm(): Promise<Json> {
    const npm = findExecutable("npm");
    if (!npm) return { available: false, version: null, path: null };
    const r = await run(npm, ["--version"], null, 5000);
    const version = r.ok ? (r.stdout.trim().length > 0 ? r.stdout.trim() : null) : null;
    return { available: true, version, path: npm };
  }

  /** CLI 探测：跑 `<bin> --version`，从输出抠 semver。未装返回 installed=false（预期空态，不抛错）。 */
  private async detectAgentCli(agent: string): Promise<Json> {
    const meta = agentCliMeta(agent);
    if (!meta) throw new DispatchError(`unknown agent: ${agent}`);
    const bin = findExecutable(meta.bin);
    if (!bin) return { installed: false, version: null, binary_path: null };
    const r = await run(bin, ["--version"], null, 5000);
    const version = r.ok ? (extractVersion(r.stdout) ?? extractVersion(r.stderr)) : null;
    return { installed: true, version, binary_path: bin };
  }

  private async installAgentCli(jobId: string, agent: string, version: string | null): Promise<number> {
    const meta = agentCliMeta(agent);
    if (!meta) throw new DispatchError(`unknown agent: ${agent}`);
    const npm = findExecutable("npm");
    if (!npm) throw new DispatchError("未找到 npm,请先安装 Node.js(https://nodejs.org)后重试");
    acquireInstallLock(jobId);
    try {
      const code = await this.streamNpm(jobId, npm, ["install", "-g", buildInstallSpec(meta.pkg, version)]);
      if (code === -1) throw new DispatchError("命令执行超时(300s)");
      if (code !== 0) throw new DispatchError(`${meta.label} 安装失败(npm 退出码 ${code}),详见日志`);
      return code;
    } finally {
      releaseInstallLock();
    }
  }

  private async uninstallAgentCli(jobId: string, agent: string, confirmToken: string): Promise<null> {
    if (confirmToken !== "uninstall") throw new DispatchError("二次确认 token 错误");
    const meta = agentCliMeta(agent);
    if (!meta) throw new DispatchError(`unknown agent: ${agent}`);
    const npm = findExecutable("npm");
    if (!npm) throw new DispatchError("未找到 npm,请先安装 Node.js(https://nodejs.org)后重试");
    acquireInstallLock(jobId);
    try {
      // 只移除 npm 全局包，绝不动 ~/.claude、~/.codex 配置目录。
      const code = await this.streamNpm(jobId, npm, ["uninstall", "-g", meta.pkg]);
      if (code === -1) throw new DispatchError("命令执行超时(300s)");
      if (code !== 0) throw new DispatchError(`${meta.label} 卸载失败(npm 退出码 ${code}),详见日志`);
      return null;
    } finally {
      releaseInstallLock();
    }
  }

  /** 流式跑 npm，逐行推 install://<jobId>/log，结束推 exit（超时 code=-1 + timeout:true），返回退出码。 */
  private async streamNpm(jobId: string, npm: string, args: string[]): Promise<number> {
    const channel = `install://${jobId}/log`;
    const code = await runStreaming(npm, args, null, 300_000, (line) =>
      this.deps.emit(channel, { stream: "stdout", line, ts: Date.now() }),
    );
    const exitPayload: Json = { stream: "exit", code, ts: Date.now() };
    if (code === -1) exitPayload.timeout = true;
    this.deps.emit(channel, exitPayload);
    return code;
  }

  private async diagnoseEnvironment(): Promise<Json> {
    const t0 = Date.now();
    const dir = this.deps.repo.currentRepoDir();
    const repo = dir ? await this.deps.repo.repoEntry(dir) : null;
    const gitAi = this.gitAiOrNull(dir);
    if (!gitAi) {
      return {
        generated_at_unix_ms: t0,
        took_ms: Date.now() - t0,
        repo: repo as unknown as Json | null,
        report: { ok: false, sections: [], raw: "" },
        agents: [],
        degraded: { reason: "git_ai_missing" },
      };
    }
    const dbg = await gitAi.debug();
    const ver = await gitAi.version();
    const agents = detectAll();
    return {
      generated_at_unix_ms: t0,
      took_ms: Date.now() - t0,
      repo: repo as unknown as Json | null,
      report: {
        ok: dbg.ok,
        git_ai_version: VERSION_REGEX.exec(ver.stdout)?.[0] ?? "",
        sections: [],
        raw: dbg.stdout.length > 0 ? dbg.stdout : dbg.stderr,
      },
      agents,
      degraded: null,
    };
  }

  private readClaudeSettings(): Json {
    const p = path.join(os.homedir(), ".claude", "settings.json");
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      raw = null;
    }
    return {
      path: p,
      exists: raw !== null,
      raw_size: raw !== null ? Buffer.byteLength(raw, "utf8") : 0,
      raw,
      mode: claudeHookMode(),
    };
  }

  private listSettingsBackups(): Json[] {
    const dir = path.join(os.homedir(), ".git-ai-studio", "backups");
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter((n) => n.startsWith("claude-settings-") && n.endsWith(".json"))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // 文件名倒序
      .map((n) => {
        const p = path.join(dir, n);
        const middle = n.slice("claude-settings-".length, n.length - ".json".length);
        let at = /^\d+$/.test(middle) ? parseInt(middle, 10) : NaN;
        if (!Number.isFinite(at)) {
          try {
            at = fs.statSync(p).mtimeMs;
          } catch {
            at = 0;
          }
        }
        return { path: p, at_unix_ms: at };
      });
  }

  private getGitAiConfig(): Json {
    const p = path.join(os.homedir(), ".git-ai", "config.json");
    let cfg: Json = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) cfg = parsed as Json;
    } catch {
      cfg = {};
    }
    if (!("disable_auto_updates" in cfg)) cfg.disable_auto_updates = false;
    if (!("update_channel" in cfg) || cfg.update_channel === null) cfg.update_channel = "stable";
    return cfg;
  }
}

// ---------- AI 编码工具装卸：元数据 / 版本提取 / 进程级互斥锁 ----------

interface AgentCliMeta {
  label: string;
  pkg: string;
  bin: string;
}

function agentCliMeta(agent: string): AgentCliMeta | null {
  switch (agent) {
    case "ClaudeCode":
      return { label: "Claude Code", pkg: "@anthropic-ai/claude-code", bin: "claude" };
    case "Codex":
      return { label: "Codex", pkg: "@openai/codex", bin: "codex" };
    default:
      return null;
  }
}

/** 与后端 build_install_args 一致：version 为空/latest → 裸包名；否则 pkg@version（原样透传，合法性交 npm）。 */
function buildInstallSpec(pkg: string, version: string | null): string {
  const v = (version ?? "").trim();
  return v.length === 0 || v === "latest" ? pkg : `${pkg}@${v}`;
}

const AGENT_VERSION_RE = /\b(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\b/;
/** 从 `--version` 输出抠 semver（claude/codex 输出不纯净）；抠不到返回 null（前端显示「版本未知」）。 */
function extractVersion(s: string): string | null {
  return AGENT_VERSION_RE.exec(s)?.[1] ?? null;
}

/**
 * 进程级安装互斥锁（对齐桌面版 install_lock）：同一时刻只跑一个 agent CLI 装/卸任务。
 * 模块级单例 → 跨 panel 共享。值为持锁任务的 jobId。
 */
let installLock: string | null = null;
function acquireInstallLock(jobId: string): void {
  if (installLock !== null) throw new DispatchError("已有一个安装 / 卸载任务在运行,请等待完成");
  installLock = jobId;
}
function releaseInstallLock(): void {
  installLock = null;
}

// ---------- 模块内工具 ----------

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function headRef(sha: string | null): string {
  return sha && sha.trim().length > 0 ? sha : "HEAD";
}

function rangeOf(args: Json): Json | null {
  const v = args.range;
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function rangesOf(args: Json): Array<[number, number]> {
  const v = args.ranges;
  if (!Array.isArray(v)) return [];
  const out: Array<[number, number]> = [];
  for (const item of v) {
    if (Array.isArray(item) && item.length >= 2 && typeof item[0] === "number" && typeof item[1] === "number") {
      out.push([Math.trunc(item[0]), Math.trunc(item[1])]);
    }
  }
  return out;
}

function dailyBuckets(
  buckets: Map<string, { human: number; unknown: number; ai: number; commits: number }>,
): Json[] {
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, b]) => ({
      date,
      human_additions: b.human,
      unknown_additions: b.unknown,
      ai_additions: b.ai,
      commit_count: b.commits,
    }));
}

// 冒烟测试入口复用：把内部依赖也导出
export { DispatchError } from "./protocol";
export { AppSettings, InMemorySettingsStore } from "../services/settings";
export { RepoService } from "../services/repoService";
export { StatsCache } from "../services/statsCache";
