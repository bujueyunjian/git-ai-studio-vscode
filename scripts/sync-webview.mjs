/**
 * 从 git-ai-studio-idea 仓库同步 webview 构建产物到 media/web。
 *
 * 该 React UI（含 bridge shim）是 IDEA 插件与本扩展共用的：bridge 协议
 * （__gitaiSend/__gitaiReceive）与宿主无关，VSCode 侧只需注入 adapter 脚本。
 * 产物同步进本仓库并提交，保证扩展可独立构建打包。
 *
 * 用法：
 *   node scripts/sync-webview.mjs            # 直接拷贝 IDEA 仓库现有产物
 *   node scripts/sync-webview.mjs --build    # 先在 IDEA 仓库 pnpm build 再拷贝
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const ideaRepo = path.resolve(root, "..", "git-ai-studio-idea");
const srcWeb = path.join(ideaRepo, "src", "main", "resources", "web");
const dstWeb = path.join(root, "media", "web");

if (process.argv.includes("--build")) {
  console.log("[sync-webview] pnpm build in", path.join(ideaRepo, "webview"));
  execSync("pnpm build", { cwd: path.join(ideaRepo, "webview"), stdio: "inherit" });
}

if (!existsSync(path.join(srcWeb, "index.html"))) {
  console.error("[sync-webview] not found:", srcWeb);
  console.error("  先在 IDEA 仓库构建 webview（cd webview && pnpm build），或检查目录布局。");
  process.exit(1);
}

rmSync(dstWeb, { recursive: true, force: true });
cpSync(srcWeb, dstWeb, { recursive: true });
console.log("[sync-webview] copied", srcWeb, "->", dstWeb);
