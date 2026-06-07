/**
 * 命令层冒烟测试：不经 VSCode，纯 Node 实例化 CommandDispatcher，
 * 对一个真实 git-ai 仓库跑通核心命令并检查返回形状。
 *
 * 用法：node scripts/smoke.mjs [repoPath]
 *   repoPath 缺省用 ../git-ai-studio-idea（本机已有归因数据的仓库）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repoPath = process.argv[2] ?? path.resolve(root, "..", "git-ai-studio-idea");

const { CommandDispatcher, AppSettings, InMemorySettingsStore, RepoService, StatsCache } = await import(
  path.join(root, "dist", "node", "dispatcher.js")
);

const settings = new AppSettings(new InMemorySettingsStore(null));
const repo = new RepoService(settings, () => repoPath);
const cache = new StatsCache();
const events = [];
const host = {
  pickDirectory: async () => null,
  notify: (title, body) => console.log(`  [notify] ${title}: ${body}`),
  openInExplorer: () => {},
};
const dispatcher = new CommandDispatcher({
  settings,
  repo,
  cache,
  host,
  emit: (channel, payload) => events.push({ channel, payload }),
});

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, cmd, args, validate) {
  try {
    const data = await dispatcher.dispatch(cmd, args ?? {});
    const problem = validate ? validate(data) : null;
    if (problem) {
      fail++;
      failures.push(`${name}: ${problem}\n  data=${JSON.stringify(data)?.slice(0, 400)}`);
      console.log(`✗ ${name} — ${problem}`);
    } else {
      pass++;
      console.log(`✓ ${name}`);
    }
    return data;
  } catch (e) {
    fail++;
    failures.push(`${name}: threw ${e?.message ?? e}`);
    console.log(`✗ ${name} — threw: ${e?.message ?? e}`);
    return undefined;
  }
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const okOrDegraded = (d) =>
  isObj(d) && (d.status === "ok" || d.status === "degraded") ? null : "expected status ok|degraded";

console.log(`repo: ${repoPath}\n`);

await check("ping", "ping", {}, (d) => (d === "pong" ? null : "expected 'pong'"));
await check("resolve_git_ai_path", "resolve_git_ai_path", {}, (d) =>
  Array.isArray(d) && typeof d[0] === "boolean" && typeof d[1] === "string" ? null : "expected [bool, string]",
);
await check("get_installed_version", "get_installed_version", {}, (d) =>
  isObj(d) && typeof d.installed === "boolean" ? null : "expected {installed}",
);
await check("get_app_settings", "get_app_settings", {}, (d) =>
  isObj(d) && Array.isArray(d.scan_roots) && isObj(d.notifications) ? null : "expected AppSettings shape",
);
await check("set_app_settings", "set_app_settings", { theme: "dark", low_ai_share_enabled: true }, (d) =>
  isObj(d) && d.theme === "dark" && d.notifications?.low_ai_share?.enabled === true
    ? null
    : "patch not applied (theme / notifications.low_ai_share.enabled)",
);
const repoEntry = await check("current_repo", "current_repo", {}, (d) =>
  isObj(d) && typeof d.path === "string" && typeof d.head_sha === "string" && "dirty" in d
    ? null
    : "expected RepoEntry",
);
await check("restore_last_repo", "restore_last_repo", {}, (d) => (isObj(d) ? null : "expected RepoEntry"));
await check("current_git_user_email", "current_git_user_email", {}, (d) =>
  d === null || typeof d === "string" ? null : "expected string|null",
);
await check("detect_dirty", "detect_dirty", { path: repoPath }, (d) =>
  typeof d === "boolean" || d === null ? null : "expected bool|null",
);
await check("list_recent_repos", "list_recent_repos", {}, (d) => (Array.isArray(d) ? null : "expected array"));
await check("list_scan_roots", "list_scan_roots", {}, (d) => (Array.isArray(d) ? null : "expected array"));
await check("get_aggregate_repos", "get_aggregate_repos", {}, (d) =>
  Array.isArray(d) && d.every((e) => isObj(e) && "valid" in e && "entry" in e)
    ? null
    : "expected [{path,valid,entry}]",
);

const commits = await check("list_recent_commits", "list_recent_commits", { maxCount: 5 }, (d) =>
  Array.isArray(d) && d.every((c) => typeof c.sha === "string" && Array.isArray(c.parents))
    ? null
    : "expected CommitBrief[]",
);
await check("list_recent_commits_with_stats", "list_recent_commits_with_stats", { maxCount: 5 }, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  const p = d.payload;
  if (!isObj(p) || !Array.isArray(p.commits)) return "missing payload.commits";
  const c = p.commits[0];
  if (c && (!isObj(c.stats) || typeof c.stats.ai_additions !== "number")) return "commit.stats shape";
  if (!Array.isArray(p.failed_shas) || typeof p.truncated !== "boolean" || typeof p.cache_hits !== "number")
    return "payload meta fields";
  return null;
});
await check("get_commit_stats(HEAD)", "get_commit_stats", {}, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  const v = d.view;
  return isObj(v) && v.kind === "commit" && isObj(v.stats) && typeof v.total_additions === "number"
    ? null
    : "view shape";
});
await check("get_commit_status", "get_commit_status", {}, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  return isObj(d.view) && d.view.kind === "working" && d.view.commit_sha === null ? null : "view shape";
});

const range = { kind: "last_n_days", days: 30 };
await check("get_history", "get_history", { range }, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  const p = d.payload;
  if (!isObj(p)) return "missing payload";
  for (const k of [
    "range",
    "range_start_unix_ms",
    "range_end_unix_ms",
    "total_commits_in_window",
    "per_commit",
    "daily_buckets",
    "cache_hits",
    "cached_repo_total",
    "failed_shas",
    "truncated",
    "took_ms",
  ]) {
    if (!(k in p)) return `payload missing ${k}`;
  }
  const b = p.daily_buckets[0];
  if (b && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return "bucket date format";
  return null;
});
await check("get_aggregate_history", "get_aggregate_history", { range, onlyMine: false }, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  const p = d.payload;
  for (const k of ["per_commit", "daily_buckets", "failed_repos", "failed_shas", "truncated_repos"]) {
    if (!(k in p)) return `payload missing ${k}`;
  }
  if (p.per_commit[0] && typeof p.per_commit[0].repo_path !== "string") return "per_commit repo_path";
  return null;
});
await check("get_aggregate_working_status", "get_aggregate_working_status", {}, (d) =>
  isObj(d) && typeof d.repos_with_changes === "number" && Array.isArray(d.per_repo)
    ? null
    : "expected working status shape",
);
await check("get_people_breakdown", "get_people_breakdown", { range }, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  const p = d.payload;
  if (!Array.isArray(p.rows)) return "rows";
  const r = p.rows[0];
  if (r && (typeof r.identity_key !== "string" || !Array.isArray(r.commit_refs))) return "row shape";
  return isObj(p.grand_total) ? null : "grand_total";
});
await check("get_range_summary", "get_range_summary", { range }, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  return isObj(d.range_summary) && isObj(d.range_summary.range_stats) ? null : "range_summary shape";
});

const notes = await check("list_ai_notes", "list_ai_notes", {}, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  const p = d.payload;
  return isObj(p) && Array.isArray(p.notes) && "head_sha" in p && Array.isArray(p.unreachable_shas)
    ? null
    : "payload shape";
});
const firstNoteSha = notes?.status === "ok" ? notes.payload.notes[0]?.commit_sha : undefined;
if (firstNoteSha) {
  await check("show_ai_note", "show_ai_note", { sha: firstNoteSha }, (d) => {
    if (okOrDegraded(d)) return okOrDegraded(d);
    if (d.status !== "ok") return null;
    const log = d.payload?.log;
    if (!isObj(log) || !Array.isArray(log.attestations)) return "log.attestations";
    const m = log.metadata;
    for (const k of ["schema_version", "git_ai_version", "base_commit_sha", "prompts", "humans", "sessions"]) {
      if (!(k in m)) return `metadata missing ${k}`;
    }
    return null;
  });
  await check("list_ai_lines_in_commit", "list_ai_lines_in_commit", { sha: firstNoteSha }, (d) => {
    if (okOrDegraded(d)) return okOrDegraded(d);
    if (d.status !== "ok") return null;
    if (!Array.isArray(d.lines)) return "lines";
    const l = d.lines[0];
    if (l && (typeof l.file !== "string" || typeof l.line_start !== "number")) return "line shape";
    return null;
  });
}
const headSha = commits?.[0]?.sha;
if (headSha) {
  await check("list_changed_files_in_commit", "list_changed_files_in_commit", { sha: headSha }, (d) =>
    isObj(d) && Array.isArray(d.files) ? null : "expected {files}",
  );
  await check("get_show_raw", "get_show_raw", { sha: headSha }, (d) =>
    isObj(d) && typeof d.raw === "string" ? null : "expected {sha, raw}",
  );
}

await check("list_branches", "list_branches", {}, (d) =>
  isObj(d) && Array.isArray(d.branches) && "current" in d ? null : "expected {branches, current}",
);
await check("list_files_at_ref", "list_files_at_ref", { ref: "HEAD" }, (d) =>
  isObj(d) && Array.isArray(d.files) && typeof d.truncated === "boolean" ? null : "expected {files, truncated}",
);
await check("read_file_at_ref(README.md)", "read_file_at_ref", { ref: "HEAD", file: "README.md" }, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  return typeof d.text === "string" && typeof d.size === "number" ? null : "text/size";
});
await check("read_file_at_ref(missing)", "read_file_at_ref", { ref: "HEAD", file: "__no_such__.txt" }, (d) =>
  d?.status === "degraded" && d.reason?.kind === "file_not_in_head" && d.reason?.file === "__no_such__.txt"
    ? null
    : "expected degraded file_not_in_head",
);
await check("get_blame(README.md)", "get_blame", { file: "README.md" }, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  const p = d.payload;
  if (!isObj(p) || !isObj(p.lines) || !isObj(p.prompts) || !Array.isArray(p.hunks)) return "payload shape";
  if (p.metadata?.is_logged_in !== false) return "metadata stub";
  for (const id of Object.values(p.lines)) {
    if (!(id in p.prompts)) return `lines value ${id} not in prompts`;
  }
  for (const rec of Object.values(p.prompts)) {
    if (!Array.isArray(rec.other_files) || !Array.isArray(rec.commits)) return "prompt defaults";
  }
  return null;
});
await check("get_blame_at_ref(bad ref)", "get_blame_at_ref", { ref: "no-such-ref", file: "README.md" }, (d) =>
  d?.status === "degraded" && d.reason?.kind === "ref_not_found" && d.reason?.ref === "no-such-ref"
    ? null
    : "expected degraded ref_not_found",
);

await check("get_whoami", "get_whoami", {}, (d) =>
  isObj(d) && typeof d.authenticated === "boolean" && typeof d.raw === "string" ? null : "expected whoami shape",
);
await check("list_effective_ignore_patterns", "list_effective_ignore_patterns", {}, (d) => {
  if (okOrDegraded(d)) return okOrDegraded(d);
  if (d.status !== "ok") return null;
  return Array.isArray(d.payload?.patterns) ? null : "patterns";
});
await check("diagnose_environment", "diagnose_environment", {}, (d) =>
  isObj(d) && isObj(d.report) && Array.isArray(d.agents) && "degraded" in d ? null : "expected overview shape",
);
await check("get_hooks_status", "get_hooks_status", {}, (d) =>
  d?.mode === "official" || d?.mode === "none" ? null : "expected {mode}",
);
await check("read_claude_settings", "read_claude_settings", {}, (d) =>
  isObj(d) && typeof d.exists === "boolean" && "raw" in d && "mode" in d ? null : "expected view shape",
);
await check("list_settings_backups", "list_settings_backups", {}, (d) =>
  Array.isArray(d) ? null : "expected array",
);
await check("get_git_ai_config", "get_git_ai_config", {}, (d) =>
  isObj(d) && "disable_auto_updates" in d && "update_channel" in d ? null : "expected config defaults",
);
await check("diagnose_git_ai_daemon", "diagnose_git_ai_daemon", {}, (d) =>
  d?.kind === "idle" ? null : "expected {kind:'idle'}",
);

// ---- AI 编码工具 npm 装卸：探测 + 负路径（不真正全局装卸，避免改动本机环境） ----
await check("refresh_path_env", "refresh_path_env", {}, (d) => (d === null ? null : "expected null"));
await check("detect_npm", "detect_npm", {}, (d) => {
  if (!isObj(d) || typeof d.available !== "boolean") return "expected {available}";
  if (!("version" in d) || !("path" in d)) return "missing version/path";
  if (d.available && typeof d.path !== "string") return "available but path not string";
  return null;
});
await check("detect_agent_cli(ClaudeCode)", "detect_agent_cli", { agent: "ClaudeCode" }, (d) =>
  isObj(d) && typeof d.installed === "boolean" && "version" in d && "binary_path" in d
    ? null
    : "expected InstalledVersion shape",
);
await check("detect_agent_cli(Codex)", "detect_agent_cli", { agent: "Codex" }, (d) =>
  isObj(d) && typeof d.installed === "boolean" && "version" in d && "binary_path" in d
    ? null
    : "expected InstalledVersion shape",
);
// 负路径：未知 agent 抛错
await check("detect_agent_cli(bad agent)", "detect_agent_cli", { agent: "Nope" }, () => "should have thrown");
{
  const last = failures[failures.length - 1];
  if (last?.startsWith("detect_agent_cli(bad agent): threw unknown agent")) {
    failures.pop();
    fail--;
    pass++;
    console.log("  (↑ 预期抛错 unknown agent，已计为通过)");
  }
}
// 负路径：uninstall 错误 token 抛 "二次确认 token 错误"（不接触 npm）
await check("uninstall_agent_cli(bad token)", "uninstall_agent_cli", { jobId: "x", agent: "Codex", confirmToken: "nope" }, () => "should have thrown");
{
  const last = failures[failures.length - 1];
  if (last?.includes("二次确认 token 错误")) {
    failures.pop();
    fail--;
    pass++;
    console.log("  (↑ 预期抛错 二次确认 token 错误，已计为通过)");
  }
}
await check("clear_stats_cache", "clear_stats_cache", {}, (d) =>
  typeof d === "number" ? null : "expected number",
);
await check("unknown command rejects", "no_such_command", {}, () => "should have thrown").then(() => {
  // check() 把抛错记为 fail —— 这里反转：最后一项预期抛错
});
// 反转最后一条的判定
{
  const last = failures[failures.length - 1];
  if (last?.startsWith("unknown command rejects: threw Command not implemented in plugin v1")) {
    failures.pop();
    fail--;
    pass++;
    console.log("  (↑ 预期抛错，已计为通过)");
  }
}

await check("run_git_ai_debug_report (streaming)", "run_git_ai_debug_report", { jobId: "smoke1" }, (d) =>
  typeof d === "number" ? null : "expected exit code",
);
const streamEvents = events.filter((e) => e.channel === "logs://debug/smoke1");
if (
  streamEvents.length >= 1 &&
  streamEvents[streamEvents.length - 1].payload.stream === "exit" &&
  typeof streamEvents[streamEvents.length - 1].payload.ts === "number"
) {
  pass++;
  console.log(`✓ streaming events (${streamEvents.length} events, exit code ${streamEvents[streamEvents.length - 1].payload.code})`);
} else {
  fail++;
  failures.push(`streaming events: got ${streamEvents.length} events`);
  console.log("✗ streaming events");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
