/**
 * Webview 宿主（对应 IDEA 插件的 WebUiPanel + WebSchemeHandlerFactory）。
 *
 * 桥协议与 IDEA 版逐字一致（前端 React 产物零改动复用）：
 * - JS → 宿主：window.__gitaiSend(JSON.stringify({type:"invoke",id,cmd,args}))
 * - 宿主 → JS：window.__gitaiReceive({type:"response",id,ok,data|error}) / {type:"event",channel,payload}
 *
 * JCEF 的两段式注入在 VSCode 里合成一段：HTML 组装期把启动全局
 * （__GITAI_PLUGIN_VERSION__ / __GITAI_HOST__）和 adapter 脚本
 * （__gitaiSend → acquireVsCodeApi().postMessage、message → __gitaiReceive）
 * 一起写进 <head>，时序天然满足「bundle 执行前就绪」。
 */
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { CommandDispatcher } from "../bridge/dispatcher";
import { DispatchError, type Json } from "../bridge/protocol";

export class GitAiPanelHost {
  private panel: vscode.WebviewPanel | null = null;
  private pendingHash: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dispatcher: CommandDispatcher,
  ) {}

  /** 事件推送（CommandDispatcher 的 emit 回调接到这里）。 */
  pushEvent(channel: string, payload: unknown): void {
    void this.panel?.webview.postMessage({ type: "event", channel, payload });
  }

  /** 打开（或聚焦）面板并跳到指定 hash 路由，如 "#/dashboard"。 */
  openAt(hash: string | null): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      if (hash) this.navigateTo(hash);
      return;
    }
    this.createPanel();
    // 面板初次加载：路由在 HTML 组装期直接写进 location.hash 的初始化脚本
    if (hash) this.pendingHash = hash;
    void this.refreshHtml();
  }

  private navigateTo(hash: string): void {
    void this.panel?.webview.postMessage({ type: "__gitai_host__", action: "navigate", hash });
  }

  private createPanel(): void {
    const panel = vscode.window.createWebviewPanel(
      "gitAiStudio",
      "Git AI Studio",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media", "web")],
      },
    );
    this.panel = panel;

    panel.webview.onDidReceiveMessage((raw) => this.handleInbound(raw), null, this.context.subscriptions);

    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => this.pushTheme());
    panel.onDidDispose(
      () => {
        themeSub.dispose();
        this.panel = null;
      },
      null,
      this.context.subscriptions,
    );
  }

  private isDark(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  }

  private pushTheme(): void {
    void this.panel?.webview.postMessage({ type: "__gitai_host__", action: "theme", dark: this.isDark() });
  }

  /** 入站消息：与 IDEA handleInbound 同构 —— 只认 type==="invoke"，其余静默丢弃。 */
  private handleInbound(raw: unknown): void {
    let msg: Json;
    if (typeof raw === "string") {
      try {
        msg = JSON.parse(raw) as Json;
      } catch {
        return;
      }
    } else if (typeof raw === "object" && raw !== null) {
      msg = raw as Json;
    } else {
      return;
    }
    if (msg.type !== "invoke") return; // emit/subscribe：事件由命令侧主动推送，这里无需处理
    const id = typeof msg.id === "string" ? msg.id : null;
    if (!id) return;
    const cmd = typeof msg.cmd === "string" ? msg.cmd : "";
    const args = typeof msg.args === "object" && msg.args !== null ? (msg.args as Json) : {};

    void this.dispatcher
      .dispatch(cmd, args)
      .then((data) => this.panel?.webview.postMessage({ type: "response", id, ok: true, data: data ?? null }))
      .catch((e: unknown) => {
        const message = e instanceof Error ? (e.message ?? String(e)) : String(e);
        if (!(e instanceof DispatchError)) {
          console.error(`[git-ai-studio] dispatch ${cmd} failed:`, e);
        }
        return this.panel?.webview.postMessage({ type: "response", id, ok: false, error: message });
      });
  }

  private async refreshHtml(): Promise<void> {
    if (!this.panel) return;
    this.panel.webview.html = await this.buildHtml(this.panel.webview);
  }

  private async buildHtml(webview: vscode.Webview): Promise<string> {
    const webRoot = vscode.Uri.joinPath(this.context.extensionUri, "media", "web");
    const indexBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(webRoot, "index.html"));
    let html = Buffer.from(indexBytes).toString("utf8");

    const baseUri = webview.asWebviewUri(webRoot).toString();
    const nonce = crypto.randomBytes(16).toString("base64");
    const version = (this.context.extension.packageJSON as { version?: string }).version ?? "";
    const dark = this.isDark();
    const initialHash = this.pendingHash;
    this.pendingHash = null;

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");

    // adapter 脚本：启动全局 + 桥 + 主题 + 宿主控制消息（theme/navigate）
    // __GITAI_HOST__ 注入 "idea"：theme.ts 严格判等 "idea" 时让出主题控制权，复用该让位逻辑。
    const adapter = `<meta http-equiv="Content-Security-Policy" content="${csp}">
<base href="${baseUri}/">
<script nonce="${nonce}">
(function () {
  window.__GITAI_PLUGIN_VERSION__ = ${JSON.stringify(version)};
  window.__GITAI_HOST__ = "idea";
  var api = acquireVsCodeApi();
  window.__gitaiSend = function (payload) { api.postMessage(payload); };
  if (Array.isArray(window.__gitaiQueue)) {
    var q = window.__gitaiQueue.slice();
    window.__gitaiQueue = [];
    for (var i = 0; i < q.length; i++) window.__gitaiSend(q[i]);
  }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (m && m.type === "__gitai_host__") {
      if (m.action === "theme") {
        document.documentElement.classList.toggle("dark", !!m.dark);
        document.documentElement.setAttribute("data-gitai-theme", m.dark ? "dark" : "light");
      } else if (m.action === "navigate" && typeof m.hash === "string") {
        window.location.hash = m.hash;
      }
      return;
    }
    if (window.__gitaiReceive) window.__gitaiReceive(m);
  });
  document.documentElement.classList.toggle("dark", ${dark});
  document.documentElement.setAttribute("data-gitai-theme", ${JSON.stringify(dark ? "dark" : "light")});
  ${initialHash ? `window.location.hash = ${JSON.stringify(initialHash)};` : ""}
})();
</script>`;

    // 产物里的内联 FOUC 脚本补 nonce；外链 script/link 去掉 crossorigin（vscode-webview 源下避免 CORS 干扰）
    html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
    html = html.replace(/ crossorigin/g, "");
    html = html.replace("<head>", `<head>\n${adapter}`);
    return html;
  }
}
