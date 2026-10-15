import { chromium } from "playwright";
import { createServer as netServer, connect } from "node:net";
import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { publicAddress, permittedUrl } from "./policy.mjs";
import { createHash } from "node:crypto";

const hosts = (process.env.DEPDEK_COMPUTER_HOSTS || "")
  .split(",")
  .filter(Boolean);
const proxy = createServer((_q, r) => {
  r.writeHead(403);
  r.end();
});
proxy.on("connect", async (req, socket, head) => {
  try {
    const u = permittedUrl("https://" + req.url, hosts);
    const records = await lookup(u.hostname, { all: true });
    if (!records.length || records.some((r) => !publicAddress(r.address)))
      throw Error();
    const upstream = connect({ host: records[0].address, port: 443 });
    upstream.setTimeout(30000, () => upstream.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  } catch {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  proxy: {
    server: `http://127.0.0.1:${proxy.address().port}`,
    bypass: "<-loopback>",
  },
  args: [
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1100, height: 760 },
  acceptDownloads: false,
  serviceWorkers: "block",
  ignoreHTTPSErrors: false,
});
await context.route("**/*", async (route) => {
  try {
    permittedUrl(route.request().url(), hosts);
    await route.continue();
  } catch {
    await route.abort();
  }
});
await context.routeWebSocket("**/*", (ws) => ws.close());
let page = await context.newPage(),
  revision = 1,
  fingerprint = "",
  pending = null,
  last = Date.now(),
  next = 0;
const secrets = new Set();
context.on("page", async (p) => {
  try {
    await p.close();
  } catch {}
});
const hide = (s) => {
  for (const secret of secrets)
    if (secret) s = s.split(secret).join("[已填写]");
  return s;
};
async function snapshot(screen = false) {
  const dom = await page.evaluate(() => {
    const visible = (e) =>
      !!(e.getBoundingClientRect().width && e.getBoundingClientRect().height) &&
      getComputedStyle(e).visibility !== "hidden";
    const all = [
      ...document.querySelectorAll(
        "input:not([type=hidden]),textarea,select,button,a,[role=button]",
      ),
    ]
      .filter(visible)
      .slice(0, 40);
    const elements = all.map((e, i) => {
      e.setAttribute("data-depdek-id", "e" + (i + 1));
      const label = (
        e.labels?.[0]?.innerText ||
        e.getAttribute("aria-label") ||
        e.placeholder ||
        e.innerText ||
        e.name ||
        e.tagName
      )
        .trim()
        .slice(0, 100);
      return {
        target: "e" + (i + 1),
        label,
        type: e.type || e.tagName.toLowerCase(),
        input: ["INPUT", "TEXTAREA", "SELECT"].includes(e.tagName),
        filled: !!e.value,
        disabled: e.disabled === true,
      };
    });
    return {
      title: document.title.slice(0, 160),
      text: (document.body?.innerText || "").slice(0, 6000),
      elements,
    };
  });
  const url = page.url().startsWith("https:")
    ? (() => {
        const u = new URL(page.url());
        u.search = "";
        u.hash = "";
        return u.toString();
      })()
    : page.url() === "about:blank"
      ? "depdek:demo-login"
      : page.url();
  dom.text = hide(dom.text).slice(0, 4096);
  dom.title = hide(dom.title);
  for (const e of dom.elements) e.label = hide(e.label);
  const sig = createHash("sha256")
    .update(JSON.stringify({ url, ...dom }))
    .digest("hex");
  if (fingerprint && sig !== fingerprint) {
    revision++;
    pending = null;
  }
  fingerprint = sig;
  // Visible input fields always hand control to the human, including OTP.
  const fields = dom.elements.filter(
    (e) =>
      e.input &&
      !e.disabled &&
      !["submit", "button", "file", "checkbox", "radio"].includes(e.type),
  );
  const result = {
    running: true,
    revision,
    url: hide(url),
    ...dom,
    request: pending ? { id: pending, fields } : null,
    screenshot: null,
    mime: "image/jpeg",
  };
  if (screen) {
    const bytes = await page.screenshot({
      type: "jpeg",
      quality: 65,
      fullPage: false,
      timeout: 5000,
    });
    if (bytes.length > 700000) throw Error("SCREENSHOT_LIMIT");
    result.screenshot = bytes.toString("base64");
  }
  return result;
}
const demo = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DepDek 登录演示</title><style>body{font:18px sans-serif;background:#121318;color:#eee;display:grid;place-items:center;height:90vh}form{width:360px;padding:40px;border:1px solid #45464c;border-radius:18px}input,button{box-sizing:border-box;width:100%;padding:14px;margin:12px 0;background:#22242a;border:1px solid #666;color:white;border-radius:8px}button{background:#e5ba64;color:#151515}label{display:block}small{color:#999}</style><form><h1>浏览器电脑 · 登录</h1><small>合成测试网页，不连接任何账户</small><label>用户名<input name="username" autocomplete="off" required></label><label>密码<input name="password" type="password" autocomplete="off" required></label><button>登录</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.innerHTML='<section><h1>登录成功</h1><p>网页已在悟空的 Docker 电脑中完成登录。</p><p>可以截图或继续浏览。</p></section>'}</script></html>`;
async function action(a) {
  last = Date.now();
  await snapshot();
  if (["click", "respond"].includes(a.kind) && a.page_revision !== revision)
    throw Error("PAGE_CHANGED");
  switch (a.kind) {
    case "status":
      return snapshot();
    case "open":
      pending = null;
      if (a.url === "depdek:demo-login") {
        await page.goto("about:blank");
        await page.setContent(demo);
      } else {
        permittedUrl(a.url, hosts);
        await page.goto(a.url, {
          waitUntil: "domcontentloaded",
          timeout: 18000,
        });
      }
      break;
    case "click": {
      const target = page.locator(`[data-depdek-id="${a.target}"]`);
      if ((await target.count()) !== 1) throw Error("TARGET_MISSING");
      await target.click({ timeout: 5000 });
      await page.waitForTimeout(250);
      break;
    }
    case "respond": {
      const before = await snapshot();
      if (!pending) throw Error("INPUT_NOT_REQUESTED");
      const fields = new Map(before.request.fields.map((f) => [f.target, f]));
      if (Object.keys(a.values).some((k) => !fields.has(k)))
        throw Error("INPUT_INVALID");
      for (const [k, v] of Object.entries(a.values)) {
        secrets.add(v);
        const target = page.locator(`[data-depdek-id="${k}"]`);
        if (fields.get(k).type === "select-one") await target.selectOption(v);
        else await target.fill(v, { timeout: 3000 });
      }
      pending = null;
      break;
    }
    case "request_input":
      pending = "input-" + ++next;
      break;
    case "screenshot":
      break;
    default:
      throw Error("COMMAND_REJECTED");
  }
  const result = await snapshot(true);
  if (a.kind === "request_input") {
    pending = "input-" + next;
    result.request = {
      id: pending,
      fields: result.elements.filter(
        (e) =>
          e.input &&
          !e.disabled &&
          !["submit", "button", "file", "checkbox", "radio"].includes(e.type),
      ),
    };
  }
  return result;
}
let queue = Promise.resolve();
netServer({ allowHalfOpen: true }, (socket) => {
  let raw = "",
    bytes = 0;
  socket.on("data", (b) => {
    bytes += b.length;
    if (bytes > 20000) {
      socket.destroy();
      return;
    }
    raw += b;
  });
  socket.on("end", () => {
    queue = queue.then(async () => {
      try {
        const a = JSON.parse(raw);
        raw = "";
        const result = await action(a);
        socket.end(JSON.stringify(result));
      } catch (e) {
        raw = "";
        socket.end(
          JSON.stringify({
            error: [
              "PAGE_CHANGED",
              "HOST_NOT_ALLOWED",
              "TARGET_MISSING",
              "INPUT_NOT_REQUESTED",
              "INPUT_INVALID",
            ].includes(e.message)
              ? e.message
              : "COMPUTER_ACTION_FAILED",
          }),
        );
      }
    });
  });
  socket.on("error", () => {});
}).listen("/tmp/depdek-computer.sock");
setInterval(() => {
  if (Date.now() - last > 30 * 60 * 1000)
    void browser.close().finally(() => process.exit());
}, 30000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(
    signal,
    () => void browser.close().finally(() => process.exit()),
  );
