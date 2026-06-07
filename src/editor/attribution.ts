/**
 * `git-ai blame --json` 输出解析（移植自 BlameAttributionSupport.kt）。
 * schema：lines 只含 AI 行（key = "5" 或 "10-20"，1-based 闭区间，value = promptId），
 * prompts[promptId].agent_id.{tool,model}。
 */

export interface LineAttribution {
  isAi: boolean;
  agent: string | null; // "tool::model" 口径
  promptId: string | null;
}

interface BlameJson {
  lines?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

function toIntOrNull(s: string | undefined): number | null {
  if (s === undefined || !/^[+-]?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

/**
 * "start-end" / "start" → 1-based 行号数组（对齐 Kotlin split("-", limit=2)）：
 * 第二段不可解析时退化为单行 start；start<1 或 end<start 丢弃。
 */
function expandLineKey(key: string): number[] {
  const dash = key.indexOf("-");
  const first = dash < 0 ? key : key.slice(0, dash);
  const rest = dash < 0 ? undefined : key.slice(dash + 1);
  const start = toIntOrNull(first);
  if (start === null) return [];
  const end = rest !== undefined ? (toIntOrNull(rest) ?? start) : start;
  if (start < 1 || end < start) return [];
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** tool/model 拼装（与 webview BlamePromptDetails 同口径）。 */
export function promptToolModel(prompt: unknown): string | null {
  if (typeof prompt !== "object" || prompt === null) return null;
  const agentId = (prompt as Record<string, unknown>).agent_id;
  if (typeof agentId !== "object" || agentId === null) return null;
  const a = agentId as Record<string, unknown>;
  const tool = typeof a.tool === "string" && a.tool.trim().length > 0 ? a.tool : null;
  const model = typeof a.model === "string" && a.model.trim().length > 0 ? a.model : null;
  if (tool && model) return `${tool}::${model}`;
  return model ?? tool;
}

/** gutter 短模型名：取 "::" 后段，去末尾 8 位日期后缀；空 → "AI"。 */
export function shortModelName(agent: string | null): string {
  if (!agent || agent.trim().length === 0) return "AI";
  const idx = agent.indexOf("::");
  const model = idx >= 0 ? agent.slice(idx + 2) : agent;
  if (model.trim().length === 0) return "AI";
  return model.replace(/-\d{8}$/, "");
}

function parseBlameJson(stdout: string): BlameJson | null {
  try {
    const parsed = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null ? (parsed as BlameJson) : null;
  } catch {
    return null;
  }
}

/** 只含 AI 行：1-based 行号 → agent（tool::model 或 null）。 */
export function parseAiLineAgents(stdout: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const json = parseBlameJson(stdout);
  if (!json) return out;
  const lines = json.lines ?? {};
  const prompts = json.prompts ?? {};
  for (const [key, promptId] of Object.entries(lines)) {
    if (typeof promptId !== "string") continue;
    const agent = promptToolModel(prompts[promptId]);
    for (const line of expandLineKey(key)) {
      out.set(line, agent);
    }
  }
  return out;
}

/**
 * 全行归因 map（0-based 行号）：先全部填人工兜底，再用 AI 行覆盖。
 * blame 是 HEAD 视角：未提交新增行不在 lines 里 → 归为人工。
 */
export function parseLineAttributions(stdout: string, totalLines: number): Map<number, LineAttribution> {
  const out = new Map<number, LineAttribution>();
  for (let i = 0; i < totalLines; i++) {
    out.set(i, { isAi: false, agent: null, promptId: null });
  }
  const json = parseBlameJson(stdout);
  if (!json) return out;
  const lines = json.lines ?? {};
  const prompts = json.prompts ?? {};
  for (const [key, promptId] of Object.entries(lines)) {
    if (typeof promptId !== "string") continue;
    const agent = promptToolModel(prompts[promptId]);
    for (const line1 of expandLineKey(key)) {
      const line0 = line1 - 1;
      if (line0 >= 0 && line0 < totalLines) {
        out.set(line0, { isAi: true, agent, promptId });
      }
    }
  }
  return out;
}

export interface Share {
  ai: number;
  total: number;
  pct: number;
}

/** 文件 AI 占比：total = 编辑器行数，ai = 落在 0..total-1 的 AI 行数，pct 四舍五入。 */
export function fileShare(stdout: string, totalLines: number): Share {
  const attrs = parseLineAttributions(stdout, totalLines);
  let ai = 0;
  for (const a of attrs.values()) {
    if (a.isAi) ai++;
  }
  const total = totalLines;
  const pct = total > 0 ? Math.floor((ai * 100 + total / 2) / total) : 0;
  return { ai, total, pct };
}
