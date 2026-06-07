import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** 两个产物：
 *  - dist/extension.js   VSCode 扩展主入口（external: vscode）
 *  - dist/node/dispatcher.js  纯 Node 版命令层（冒烟测试用，不依赖 vscode 模块）
 */
const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
};

const extensionCtx = await esbuild.context({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});

const nodeCtx = await esbuild.context({
  ...common,
  entryPoints: ["src/bridge/dispatcher.ts"],
  outfile: "dist/node/dispatcher.js",
});

if (watch) {
  await Promise.all([extensionCtx.watch(), nodeCtx.watch()]);
} else {
  await Promise.all([extensionCtx.rebuild(), nodeCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), nodeCtx.dispose()]);
}
