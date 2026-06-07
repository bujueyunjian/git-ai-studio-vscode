/**
 * 可执行文件发现（移植自 ExecutableLocator.kt）：
 * - git-ai 可被用户设置显式覆盖（最高优先）；git 无覆盖，找不到回退字面量 "git"。
 * - 候选目录补全 PATH，应对 GUI 启动缺 PATH 的场景。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const isWindows = process.platform === "win32";

function extraDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    return [
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "AppData", "Local", "Programs", "git-ai"),
    ];
  }
  return [
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(home, ".cargo", "bin"),
    path.join(home, "bin"),
    "/usr/bin",
  ];
}

/**
 * Node 系 CLI（npm / claude / codex）的常见全局安装位：nvm / volta / bun / npm prefix / Homebrew。
 * 对齐桌面版 227e6e8 的「固定目录二级解析」——PATH 镜像有盲区（nvm 早退、fish 默认 shell 不 source rc），
 * 补这些目录既能让 find 命中已装 CLI，又能让子进程（npm/claude 的 #!/usr/bin/env node）找到同源 node。
 * 仅返回真实存在的目录。
 */
export function nodeToolDirs(): string[] {
  const home = os.homedir();
  let raw: string[];
  if (isWindows) {
    raw = [
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Volta", "bin") : "",
      process.env.NVM_SYMLINK ?? "",
      "C:\\Program Files\\nodejs",
    ];
  } else {
    raw = [
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      ...nvmVersionBins(home),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
  }
  return raw.filter((d) => d.length > 0 && isDirectory(d));
}

/** ~/.nvm/versions/node/<ver>/bin，版本字典序降序（新版 v22 排在 v18 前）。无 nvm 返空。 */
function nvmVersionBins(home: string): string[] {
  const base = path.join(home, ".nvm", "versions", "node");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse()
    .map((v) => path.join(base, v, "bin"));
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (isWindows) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(name: string): string[] {
  return isWindows ? [`${name}.exe`, `${name}.cmd`, name] : [name];
}

/** 查找可执行文件绝对路径；explicit（用户设置）优先；找不到返回 null。 */
export function find(name: string, explicit?: string | null): string | null {
  if (explicit && explicit.trim().length > 0 && isExecutableFile(explicit)) {
    return path.resolve(explicit);
  }
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0);
  const dirs = [...pathDirs];
  for (const d of [...extraDirs(), ...nodeToolDirs()]) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  for (const dir of dirs) {
    for (const cand of candidateNames(name)) {
      const p = path.join(dir, cand);
      if (isExecutableFile(p)) return p;
    }
  }
  return null;
}

/** 把候选目录追加进 PATH（原有目录优先，去重）。 */
export function augmentPath(current: string | undefined): string {
  const parts = (current ?? process.env.PATH ?? "").split(path.delimiter).filter((p) => p.length > 0);
  for (const d of [...extraDirs(), ...nodeToolDirs()]) {
    if (!parts.includes(d)) parts.push(d);
  }
  return parts.join(path.delimiter);
}
