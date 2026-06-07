/**
 * 集成验证 dev server：在真实浏览器里跑完整 React UI + TS dispatcher。
 * 桥接：__gitaiSend → POST /__send；GET /__recv 长轮询 → __gitaiReceive。
 * 仅用于本地验证（替代 VSCode webview 宿主），不进发布包。
 *
 * 用法：node scripts/devserver.mjs [repoPath] [port]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repoPath = process.argv[2] ?? path.resolve(root, "..", "git-ai-studio-idea");
const port = parseInt(process.argv[3] ?? "8841", 10);
const webRoot = path.join(root, "media", "web");

const { CommandDispatcher, AppSettings, InMemorySettingsStore, RepoService, StatsCache } = await import(
  path.join(root, "dist", "node", "dispatcher.js")
);

const outbox = [];
let waiter = null;
function push(msg) {
  outbox.push(msg);
  if (waiter) {
    const w = waiter;
    waiter = null;
    w();
  }
}

const settings = new AppSettings(new InMemorySettingsStore(null));
const repo = new RepoService(settings, () => repoPath);
const dispatcher = new CommandDispatcher({
  settings,
  repo,
  cache: new StatsCache(),
  host: {
    pickDirectory: async () => null,
    notify: (t, b) => console.log(`[notify] ${t}: ${b}`),
    openInExplorer: (p) => console.log(`[openInExplorer] ${p}`),
  },
  emit: (channel, payload) => push({ type: "event", channel, payload }),
});

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const ADAPTER = `<script>
window.__GITAI_PLUGIN_VERSION__ = "0.1.0-dev";
window.__GITAI_HOST__ = "idea";
window.__gitaiSend = function (payload) {
  fetch("/__send", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
};
if (Array.isArray(window.__gitaiQueue)) {
  var q = window.__gitaiQueue.slice(); window.__gitaiQueue = [];
  for (var i = 0; i < q.length; i++) window.__gitaiSend(q[i]);
}
(function poll() {
  fetch("/__recv").then(function (r) { return r.json(); }).then(function (msgs) {
    msgs.forEach(function (m) { window.__gitaiReceive && window.__gitaiReceive(m); });
    poll();
  }).catch(function () { setTimeout(poll, 500); });
})();
document.documentElement.classList.toggle("dark", ${process.env.GITAI_DARK !== "0"});
document.documentElement.setAttribute("data-gitai-theme", ${process.env.GITAI_DARK !== "0"} ? "dark" : "light");
</script>`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "POST" && url.pathname === "/__send") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(204).end();
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          return;
        }
        if (msg?.type !== "invoke" || typeof msg.id !== "string") return;
        const cmd = typeof msg.cmd === "string" ? msg.cmd : "";
        const args = typeof msg.args === "object" && msg.args !== null ? msg.args : {};
        dispatcher
          .dispatch(cmd, args)
          .then((data) => push({ type: "response", id: msg.id, ok: true, data: data ?? null }))
          .catch((e) => push({ type: "response", id: msg.id, ok: false, error: e?.message ?? String(e) }));
      });
      return;
    }
    if (url.pathname === "/__recv") {
      const flush = () => {
        const msgs = outbox.splice(0, outbox.length);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msgs));
      };
      if (outbox.length > 0) return flush();
      const timeout = setTimeout(flush, 25000);
      waiter = () => {
        clearTimeout(timeout);
        flush();
      };
      req.on("close", () => {
        if (waiter) waiter = null;
        clearTimeout(timeout);
      });
      return;
    }
    // 静态资源
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(webRoot, decodeURIComponent(p));
    if (!file.startsWith(webRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    if (p === "/index.html") {
      let html = fs.readFileSync(file, "utf8");
      html = html.replace(/ crossorigin/g, "").replace("<head>", `<head>\n${ADAPTER}`);
      res.writeHead(200, { "content-type": "text/html" }).end(html);
      return;
    }
    res
      .writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" })
      .end(fs.readFileSync(file));
  })
  .listen(port, "127.0.0.1", () => console.log(`devserver: http://127.0.0.1:${port}/  repo=${repoPath}`));
