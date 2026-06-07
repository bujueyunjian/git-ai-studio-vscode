/**
 * 子进程执行（移植自 IDEA 插件 ProcessRunner.kt，契约一致）：
 * - 强制 LC_ALL=C / LANG=C：保证 git/git-ai 的 stderr 输出英文关键字，
 *   上层靠 "no note" / "fatal:" 等子串匹配分流，中文环境下不能丢。
 * - PATH 增补常见安装目录（GUI 启动的 VSCode 在 macOS 常缺 PATH）。
 * - 超时强杀，ok = exitCode === 0 && !timedOut。
 */
import { spawn } from "node:child_process";
import { augmentPath } from "./executableLocator";

export interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ok: boolean;
}

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.LC_ALL = "C";
  env.LANG = "C";
  env.PATH = augmentPath(env.PATH);
  return env;
}

export function run(
  exe: string,
  args: string[],
  workingDir: string | null,
  timeoutMs: number,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(exe, args, {
      cwd: workingDir ?? undefined,
      env: buildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 换行规整对齐 Kotlin readLine 重组：CRLF/CR → LF，再削尾随换行
      const normalize = (s: string) => s.replace(/\r\n|\r/g, "\n").replace(/\n+$/, "");
      resolve({
        exitCode,
        stdout: normalize(stdout),
        stderr: normalize(stderr),
        timedOut,
        ok: exitCode === 0 && !timedOut,
      });
    };

    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(timedOut ? -1 : (code ?? -1)));
  });
}

/** 流式执行：stderr 并入 stdout 逐行回调（驱动 logs://、hooks:// 事件流）。返回退出码，超时 -1。 */
export function runStreaming(
  exe: string,
  args: string[],
  workingDir: string | null,
  timeoutMs: number,
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let buf = "";

    const child = spawn(exe, args, {
      cwd: workingDir ?? undefined,
      env: buildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onData = (d: string) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, idx).replace(/\r$/, "")); // CRLF 行剥掉尾随 CR（对齐 readLine）
        buf = buf.slice(idx + 1);
      }
    };
    child.stdout.setEncoding("utf8").on("data", onData);
    child.stderr.setEncoding("utf8").on("data", onData);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buf.length > 0) onLine(buf);
      resolve(code);
    };
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(timedOut ? -1 : (code ?? -1)));
  });
}
