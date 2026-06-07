/**
 * AI agent hook 配置探测（移植自 AgentHookDetector.kt）：
 * 纯文件读 + 字符串启发式，判断各 agent 的 hook 是否安装并指向 git-ai checkpoint。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface AgentSpec {
  kind: string;
  cli: string | null;
  configPaths: string[]; // 相对 ~，多个取首个存在的
  tsPlugin: boolean;
}

const SPECS: AgentSpec[] = [
  { kind: "Claude", cli: "claude", configPaths: [".claude/settings.json"], tsPlugin: false },
  { kind: "Cursor", cli: "cursor", configPaths: [".cursor/hooks.json"], tsPlugin: false },
  { kind: "Codex", cli: "codex", configPaths: [".codex/config.toml", ".codex/hooks.json"], tsPlugin: false },
  { kind: "OpenCode", cli: null, configPaths: [".config/opencode/plugins/git-ai.ts"], tsPlugin: true },
  { kind: "Gemini", cli: "gemini", configPaths: [".gemini/settings.json"], tsPlugin: false },
  { kind: "Pi", cli: null, configPaths: [".pi/agent/extensions/git-ai.ts"], tsPlugin: true },
];

export interface AgentStatus {
  agent: string;
  detected: boolean;
  configured: boolean;
  config_path: string;
  hook_type: string | null;
  raw_excerpt: string | null;
  issues: string[];
}

/** 严格命令判定：无 shell 短路/注释，含 `checkpoint <cli>`，首 token 以 git-ai(.exe) 结尾。 */
export function isGitAiHook(command: string, cli: string): boolean {
  if (/[;#]|&&|\|\|/.test(command)) return false;
  if (!command.includes(`checkpoint ${cli}`)) return false;
  const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first.endsWith("git-ai") || first.endsWith("git-ai.exe");
}

/** JSON 基本反转义（对齐 Kotlin unescapeJson：已知转义还原，未知转义保留反斜杠）。 */
function unescapeJson(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case "\\":
      case '"':
      case "/":
        return c;
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return "\\" + c;
    }
  });
}

/** 抽取 JSON 双引号字面量（带基本反转义）+ TOML 单引号字面量。 */
export function extractQuotedLiterals(text: string): string[] {
  const out: string[] = [];
  const dq = /"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = dq.exec(text)) !== null) {
    out.push(unescapeJson(m[1]));
  }
  const sq = /'([^']*)'/g;
  while ((m = sq.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function detect(spec: AgentSpec): AgentStatus {
  const home = os.homedir();
  const existing = spec.configPaths.map((p) => path.join(home, p)).find((p) => fs.existsSync(p));
  const fallbackPath = path.join(home, spec.configPaths[0]);

  if (!existing) {
    return {
      agent: spec.kind,
      detected: false,
      configured: false,
      config_path: fallbackPath,
      hook_type: null,
      raw_excerpt: null,
      issues: [`未检测到 ${fallbackPath}（${spec.kind} 未配置）`],
    };
  }

  let text: string;
  try {
    text = fs.readFileSync(existing, "utf8");
  } catch (e) {
    return {
      agent: spec.kind,
      detected: true,
      configured: false,
      config_path: existing,
      hook_type: null,
      raw_excerpt: null,
      issues: [`配置文件读取失败: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (spec.tsPlugin) {
    const hasConst = text.includes("GIT_AI_BIN");
    const stillPlaceholder = text.includes("__GIT_AI_BINARY_PATH__");
    const configured = hasConst && !stillPlaceholder;
    const excerpt =
      text
        .split("\n")
        .find((l) => l.includes("GIT_AI_BIN") && l.includes("="))
        ?.trim() ?? null;
    const issues: string[] = [];
    if (!hasConst) issues.push("插件文件缺少 GIT_AI_BIN 常量，可能不是 git-ai 安装版本");
    if (hasConst && stillPlaceholder) issues.push("GIT_AI_BIN 仍是占位符，git-ai install-hooks 未替换真实路径");
    return {
      agent: spec.kind,
      detected: true,
      configured,
      config_path: existing,
      hook_type: configured ? "command" : null,
      raw_excerpt: excerpt,
      issues,
    };
  }

  const cli = spec.cli ?? "";
  const hit = extractQuotedLiterals(text).find((s) => isGitAiHook(s, cli));
  if (hit) {
    return {
      agent: spec.kind,
      detected: true,
      configured: true,
      config_path: existing,
      hook_type: "command",
      raw_excerpt: hit,
      issues: [],
    };
  }
  return {
    agent: spec.kind,
    detected: true,
    configured: false,
    config_path: existing,
    hook_type: null,
    raw_excerpt: null,
    issues: [`未找到 'git-ai checkpoint ${cli}' 配置`],
  };
}

export function detectAll(): AgentStatus[] {
  return SPECS.map(detect);
}

/** Hooks 页用：~/.claude/settings.json 含合法 checkpoint claude → "official"。 */
export function claudeHookMode(): "official" | "none" {
  const p = path.join(os.homedir(), ".claude", "settings.json");
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return "none";
  }
  return extractQuotedLiterals(text).some((s) => isGitAiHook(s, "claude")) ? "official" : "none";
}
