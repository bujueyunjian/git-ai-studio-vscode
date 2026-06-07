/**
 * 协议层共享纯函数（移植自 CommandDispatcher.kt 的私有辅助），与宿主无关：
 * AiStats 归一化、note_kind 推导、时间窗解析、git log 紧凑格式解析、
 * AI note 文本解析、blame-analysis 输出变换。
 */

export class DispatchError extends Error {}

export type Json = Record<string, unknown>;

export const HARD_CAP = 500;
export const FILES_CAP = 50000;
export const MAX_FILE_BYTES = 512 * 1024;
export const NOTES_REF = "refs/notes/ai";
/** 字段以 0x1F (unit separator) 分隔：sha/short/committerISO/authorName/authorEmail/subject/parents */
export const LOG_FORMAT = "%H%x1f%h%x1f%cI%x1f%an%x1f%ae%x1f%s%x1f%P";

// ---------- args 取值（对齐 JsonUtil 语义） ----------

export function argStr(args: Json, k: string): string | null {
  const v = args[k];
  return typeof v === "string" ? v : null;
}
export function argInt(args: Json, k: string, def: number): number {
  const v = args[k];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
}
export function argBool(args: Json, k: string, def: boolean): boolean {
  const v = args[k];
  return typeof v === "boolean" ? v : def;
}
export function argStrArray(args: Json, k: string): string[] {
  const v = args[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---------- degraded 包络 ----------

export function degraded(kind: string, extra?: Json): Json {
  return { status: "degraded", reason: { kind, ...(extra ?? {}) } };
}

// ---------- AiStats ----------

export interface AiStats {
  human_additions: number;
  unknown_additions: number;
  ai_additions: number;
  ai_accepted: number;
  git_diff_deleted_lines: number;
  git_diff_added_lines: number;
  tool_model_breakdown: Json;
}

function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function normalizeAiStats(raw: unknown): AiStats {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Json;
  const breakdown = o.tool_model_breakdown;
  return {
    human_additions: numOf(o.human_additions),
    unknown_additions: numOf(o.unknown_additions),
    ai_additions: numOf(o.ai_additions),
    ai_accepted: numOf(o.ai_accepted),
    git_diff_deleted_lines: numOf(o.git_diff_deleted_lines),
    git_diff_added_lines: numOf(o.git_diff_added_lines),
    tool_model_breakdown:
      typeof breakdown === "object" && breakdown !== null && !Array.isArray(breakdown) ? (breakdown as Json) : {},
  };
}

export function totalAdditions(stats: AiStats): number {
  return stats.human_additions + stats.unknown_additions + stats.ai_additions;
}

export function deriveNoteKind(stats: AiStats, total: number, isMerge: boolean): string | null {
  if (isMerge) return "merge";
  if (total === 0) return "empty_additions";
  if (stats.ai_additions === 0 && stats.ai_accepted === 0 && stats.unknown_additions > 0) {
    return "working_logs_missing";
  }
  return null;
}

export function statsView(
  kind: "commit" | "working",
  commitSha: string | null,
  isMerge: boolean,
  stats: AiStats,
): Json {
  const total = totalAdditions(stats);
  return {
    kind,
    commit_sha: commitSha,
    is_merge: isMerge,
    stats,
    total_additions: total,
    note_kind: deriveNoteKind(stats, total, isMerge),
  };
}

// ---------- git log 紧凑格式 ----------

export interface CommitMeta {
  sha: string;
  short: string;
  authoredAt: string; // %cI 原样 ISO
  authorName: string;
  authorEmail: string;
  subject: string;
  parents: string[];
  isMerge: boolean;
  committerMs: number; // %cI 解析失败 = 0
}

export function parseLogLines(stdout: string): CommitMeta[] {
  const out: CommitMeta[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\u001f");
    if (parts.length < 7) continue;
    const parents = parts[6].trim().length > 0 ? parts[6].trim().split(/\s+/) : [];
    const ms = Date.parse(parts[2]);
    out.push({
      sha: parts[0],
      short: parts[1],
      authoredAt: parts[2],
      authorName: parts[3],
      authorEmail: parts[4],
      subject: parts[5],
      parents,
      isMerge: parents.length > 1,
      committerMs: Number.isFinite(ms) ? ms : 0,
    });
  }
  return out;
}

export function commitBrief(m: CommitMeta): Json {
  return {
    sha: m.sha,
    short: m.short,
    authored_at: m.authoredAt,
    author_name: m.authorName,
    author_email: m.authorEmail,
    subject: m.subject,
    parents: m.parents,
    is_merge: m.isMerge,
  };
}

// ---------- 时间窗（系统本地时区，对齐 resolveWindow） ----------

const DAY_MS = 86_400_000;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 周一为周首。 */
function startOfWeek(d: Date): Date {
  const sod = startOfDay(d);
  const dow = (sod.getDay() + 6) % 7; // Monday=0
  return new Date(sod.getTime() - dow * DAY_MS);
}

export function resolveWindow(range: Json | null): { startMs: number; endMs: number } {
  const now = new Date();
  const nowMs = now.getTime();
  const kind = range && typeof range.kind === "string" ? range.kind : "last_n_days";
  switch (kind) {
    case "today":
      return { startMs: startOfDay(now).getTime(), endMs: nowMs };
    case "yesterday": {
      const todayStart = startOfDay(now).getTime();
      return { startMs: todayStart - DAY_MS, endMs: todayStart - 1 };
    }
    case "this_week":
      return { startMs: startOfWeek(now).getTime(), endMs: nowMs };
    case "last_week": {
      const thisWeekStart = startOfWeek(now).getTime();
      return { startMs: thisWeekStart - 7 * DAY_MS, endMs: thisWeekStart - 1 };
    }
    case "this_month":
      return { startMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), endMs: nowMs };
    case "last_month": {
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
      return { startMs: lastMonthStart, endMs: thisMonthStart - 1 };
    }
    case "last_n_days": {
      const days = range ? argInt(range, "days", 30) : 30;
      return { startMs: nowMs - days * DAY_MS, endMs: nowMs };
    }
    case "custom": {
      const start = range && typeof range.start_unix_ms === "number" ? range.start_unix_ms : nowMs - 30 * DAY_MS;
      const end = range && typeof range.end_unix_ms === "number" ? range.end_unix_ms : nowMs;
      return { startMs: start, endMs: end };
    }
    default:
      return { startMs: nowMs - 30 * DAY_MS, endMs: nowMs };
  }
}

/** 本地时区 YYYY-MM-DD（daily bucket key）。 */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- AI note 解析（文本归因段 + "---" + JSON 元数据） ----------

export interface NoteAttestationEntry {
  hash: string;
  line_ranges: string;
}
export interface NoteAttestation {
  file_path: string;
  entries: NoteAttestationEntry[];
}

export function parseAiNote(noteText: string): { attestations: NoteAttestation[]; metadata: Json } {
  const lines = noteText.split("\n");
  const attestations: NoteAttestation[] = [];
  let current: NoteAttestation | null = null;
  let metadata: Json = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      i++;
      break;
    }
    if (line.trim().length === 0) continue;
    if (/^[ \t]/.test(line)) {
      // 缩进行："<hash> <line_ranges>"，按首个 ASCII 空格切分（对齐 Kotlin indexOf(' ')）
      const t = line.trim();
      const sp = t.indexOf(" ");
      if (sp > 0 && current) {
        current.entries.push({ hash: t.slice(0, sp), line_ranges: t.slice(sp + 1).trim() });
      }
    } else {
      current = { file_path: line.trim(), entries: [] };
      attestations.push(current);
    }
  }
  if (i < lines.length) {
    try {
      const parsed = JSON.parse(lines.slice(i).join("\n"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        metadata = parsed as Json;
      }
    } catch {
      metadata = {};
    }
  }
  return { attestations, metadata };
}

/** Kotlin String.toIntOrNull 语义：可选正负号 + 纯数字，否则 null。 */
export function toIntOrNull(s: string | undefined): number | null {
  if (s === undefined || !/^[+-]?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * "1-10,15" → [[1,10],[15,15]]（宽松版，对齐 Kotlin listAiLines 内联解析）：
 * 含 '-' 的段 split('-') 取前两段（"1-2-3"→(1,2)），任一段不可解析则丢弃；不做端点/正负校验。
 */
export function expandLineRanges(ranges: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const seg of ranges.split(",")) {
    const t = seg.trim();
    if (t.length === 0) continue;
    if (t.includes("-")) {
      const parts = t.split("-");
      const start = toIntOrNull(parts[0]?.trim());
      const end = toIntOrNull(parts[1]?.trim());
      if (start === null || end === null) continue;
      out.push([start, end]);
    } else {
      const n = toIntOrNull(t);
      if (n !== null) out.push([n, n]);
    }
  }
  return out;
}

// ---------- blame-analysis 输出变换（对齐桌面 convert_analysis / Kotlin transformBlame） ----------

/**
 * git-ai blame-analysis 输出：line_authors {"<行号>": "<author>"}、prompt_records {"<promptId>": {...}}、blame_hunks。
 * 只保留 author 命中 prompt_records 键的行（即 AI 行），连续同 promptId 行压成 "13" / "15-25"。
 */
export function transformBlame(analysis: Json): Json {
  const lineAuthors =
    typeof analysis.line_authors === "object" && analysis.line_authors !== null
      ? (analysis.line_authors as Record<string, unknown>)
      : {};
  const promptRecords =
    typeof analysis.prompt_records === "object" && analysis.prompt_records !== null
      ? (analysis.prompt_records as Record<string, unknown>)
      : {};

  const aiLines: Array<{ line: number; promptId: string }> = [];
  for (const [k, v] of Object.entries(lineAuthors)) {
    const line = parseInt(k, 10);
    if (!Number.isFinite(line)) continue;
    if (typeof v !== "string") continue;
    if (!(v in promptRecords)) continue;
    aiLines.push({ line, promptId: v });
  }
  aiLines.sort((a, b) => a.line - b.line);

  const lines: Record<string, string> = {};
  let runStart = -1;
  let runEnd = -1;
  let runPrompt = "";
  const flush = () => {
    if (runStart < 0) return;
    lines[runStart === runEnd ? String(runStart) : `${runStart}-${runEnd}`] = runPrompt;
  };
  for (const { line, promptId } of aiLines) {
    if (runStart >= 0 && line === runEnd + 1 && promptId === runPrompt) {
      runEnd = line;
    } else {
      flush();
      runStart = line;
      runEnd = line;
      runPrompt = promptId;
    }
  }
  flush();

  const prompts: Json = {};
  for (const [id, rec] of Object.entries(promptRecords)) {
    // 仅纳入纯对象记录（对齐 Kotlin rec.takeIf { it.isJsonObject } ?: continue）
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) continue;
    const r = { ...(rec as Json) };
    if (!("other_files" in r)) r.other_files = [];
    if (!("commits" in r)) r.commits = [];
    prompts[id] = r;
  }

  return {
    lines,
    prompts,
    metadata: { is_logged_in: false, current_user: null },
    hunks: Array.isArray(analysis.blame_hunks) ? analysis.blame_hunks : [],
  };
}

// ---------- 杂项 ----------

export const VERSION_REGEX = /\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?/;

export function errText(r: { stderr: string; exitCode: number }): string {
  return r.stderr.trim().length > 0 ? r.stderr : `exit ${r.exitCode}`;
}
