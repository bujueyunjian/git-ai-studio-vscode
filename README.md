# Git AI Studio — VS Code 扩展

把本地 AI 代码归因洞察搬进 **VS Code**，基于外部 [`git-ai`](https://github.com/git-ai-project/git-ai) CLI。
它是 [git-ai-studio](https://github.com/bujueyunjian/git-ai-studio) 桌面版与
[git-ai-studio-idea](https://github.com/bujueyunjian/git-ai-studio-idea) IntelliJ 插件的 VS Code 同胞 ——
同一套解析、同一套 React UI、同样的零上传 / 零 telemetry 承诺。

> 所有解析都经 `git-ai` CLI 在本机完成。零数据上传，无账号，无云。

## 能做什么

- **Dashboard / Stats / People / Notes / Repo / 诊断 / Hooks** —— 与桌面版和 IDEA 插件相同的完整 React UI，
  跑在 VS Code Webview 面板里（`Git AI: Open Panel` / `Git AI: Dashboard`）。
- **编辑器内行级归因** —— 对当前文件跑 `git-ai blame --json`，行首标出每行：
  **AI → 紫（短模型名），你 → 蓝（·）**（与桌面墨宠同一把锁死的颜色不变量）。
  右键 → **Git AI → Blame**，再次触发关闭。
- **状态栏 AI 占比** —— 当前文件的 AI 行占比（`AI 34%`），点击进面板下钻。
- **右键菜单** —— Blame / Stats / Blame in Panel / Dashboard，与 IDEA 插件四个 action 一一对应。

## 架构

与 IDEA 插件相同的移植手法 —— **换传输层即复用 UI**：

```
┌──────────────────────────────────────────────┐
│ VS Code WebviewPanel                          │
│   git-ai-studio React UI（与 IDEA 版同一产物）│
│   Dashboard / Stats / People / Notes …        │
└───────────────┬──────────────────────────────┘
                │  JS 桥(window.__gitaiSend / __gitaiReceive
                │        ↔ postMessage)
                ▼
   TS CommandDispatcher ──child_process──▶ git-ai / git（LC_ALL=C，--json）
                │
                └─ 编辑器行级归因（TextEditorDecorationType）─▶ git-ai blame --json
```

- 桥协议信封（`{type:"invoke",id,cmd,args}` / `{type:"response",id,ok,data|error}` /
  `{type:"event",channel,payload}`）与 IDEA 版逐字一致，React 业务源码一行不改。
- `CommandDispatcher` 1:1 移植 Kotlin 版：~50 个命令、degraded 契约、超时、`LC_ALL=C`、
  PATH 增补（`~/.local/bin`、`~/.cargo/bin`、`/opt/homebrew/bin` …）全部照搬。
- 主题跟随 VS Code（`onDidChangeActiveColorTheme` → `.dark` class）。

## 环境要求

- VS Code **1.90+**。
- `PATH` 上有 [`git-ai`](https://github.com/git-ai-project/git-ai) CLI（或在设置
  `gitAiStudio.gitAiPath` 指定其路径）。

## 构建与打包

```bash
# 1) 同步复用的 Web UI 产物（来自同级目录的 git-ai-studio-idea 仓库）
npm run sync-webview          # 或 node scripts/sync-webview.mjs --build 先重新构建

# 2) 依赖 + 类型检查 + 构建
npm install
npm run typecheck
npm run build

# 3) 命令层冒烟测试（纯 Node，不需要打开 VS Code）
npm run smoke

# 4) 打包 vsix
npm run package
```

## 开发

`scripts/smoke.mjs` 直接实例化 dispatcher 对真实仓库验证全部命令（dispatcher 不依赖
`vscode` 模块，宿主能力经 HostAdapter 注入）。
