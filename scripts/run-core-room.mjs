// Disposable local synthetic fixture. Never imports Home, old env or real keys.
import { mkdtemp, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import assert from "node:assert/strict";
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2),
  test = args.includes("--test");
const withComputer = args.includes("--computer");
const port = Number(
  args.find((a) => a.startsWith("--port="))?.slice(7) || 8788,
);
if (
  args.some(
    (a) => a !== "--test" && a !== "--computer" && !/^--port=\d+$/.test(a),
  ) ||
  port < 1024 ||
  port > 65535
)
  throw Error("use --test [--computer] [--port=8788]");
const core = join(repo, "services/depdekd/target/debug/depdekd"),
  cli = join(repo, "services/depdekd/target/debug/depdek"),
  worker = join(repo, "services/depdekd/target/debug/depdek-worker"),
  web = join(repo, "webdesk/target/debug/depdek-webdesk"),
  sdk = join(repo, "sidecar/dist/r1-engine-worker.mjs");
const PASSWORD = "RoomDemo2026!",
  MASTER = "RoomDemoStore2026!",
  KEY = "synthetic-room-key-not-for-production";
const env = { PATH: process.env.PATH, LANG: "C.UTF-8" };
const children = [];
let count = 0;
let mock;
function processText(command, arguments_, input) {
  return new Promise((ok, no) => {
    const p = spawn(command, arguments_, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    p.stdout.on("data", (b) => (output += b.toString()));
    p.on("error", no);
    p.on("exit", (code) =>
      code === 0 ? ok(output) : no(Error("fixture helper failed")),
    );
    p.stdin.end(input);
  });
}
function rpc(socket, method, params) {
  return new Promise((ok, no) => {
    const s = createConnection(socket);
    let bytes = Buffer.alloc(0);
    s.setTimeout(58000, () => s.destroy(Error("fixture RPC deadline")));
    s.on("error", no);
    s.on("connect", () =>
      s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"),
    );
    s.on("data", (b) => {
      bytes = Buffer.concat([bytes, b]);
      if (bytes.length > 2 * 1024 * 1024) {
        s.destroy(Error("fixture response limit"));
        return;
      }
      const i = bytes.indexOf(10);
      if (i >= 0) {
        try {
          const r = JSON.parse(bytes.subarray(0, i));
          s.end();
          if (r.error) no(Error(r.error.data.error.code));
          else ok(r.result.data);
        } catch (e) {
          no(e);
        }
      }
    });
  });
}
async function ready(fn) {
  for (let i = 0; i < 100; i++) {
    try {
      return await fn();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("fixture startup failed");
}
const dir = await mkdtemp(join(tmpdir(), "depdek-core-room-"));
await chmod(dir, 0o700);
for (const path of ["home/documents", "private", "webdata"]) {
  await mkdir(join(dir, path), { recursive: true, mode: 0o700 });
}
const socket = join(dir, "runtime/core.sock"),
  origin = `http://127.0.0.1:${port}`;
const cookies = new Map();
let csrf = "",
  business = "";
async function http(path, body, extra = {}) {
  const r = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(body === undefined ? {} : { origin }),
      ...(csrf ? { "x-depdek-csrf": csrf } : {}),
      ...(business ? { "x-depdek-business-csrf": business } : {}),
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const raw of r.headers.getSetCookie()) {
    const [key, value] = raw.split(";")[0].split("=");
    cookies.set(key, value);
  }
  const value = await r.json();
  if (!r.ok)
    throw Error(
      typeof value.error === "string"
        ? value.error
        : value.error?.code || `HTTP${r.status}`,
    );
  return value;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of children.reverse()) p.kill("SIGTERM");
  mock?.close();
  await Promise.all(
    children.map(
      (p) =>
        new Promise((r) => {
          if (p.exitCode !== null) r();
          else {
            p.once("exit", r);
            setTimeout(() => {
              p.kill("SIGKILL");
              r();
            }, 3000);
          }
        }),
    ),
  );
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  const hash = (
    await processText(
      cli,
      ["auth", "hash-password", "--stdin"],
      JSON.stringify({ password: PASSWORD }),
    )
  ).trim();
  const webHash = (
    await processText(web, ["hash-password"], PASSWORD + "\n")
  ).match(/password_hash = '([^']+)'/)?.[1];
  if (!webHash) throw Error("web hash missing");
  mock = createServer(async (req, res) => {
    try {
      if (
        req.url !== "/v1/chat/completions" ||
        req.method !== "POST" ||
        req.headers.authorization !== `Bearer ${KEY}`
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      let bytes = "";
      for await (const b of req) {
        bytes += b;
        if (bytes.length > 20000) throw Error("mock limit");
      }
      const input = JSON.parse(bytes);
      assert.equal(input.model, "synthetic-room-model");
      assert.equal(input.messages.length, 1);
      assert.equal(input.messages[0].role, "user");
      assert.equal(input.stream, false);
      count++;
      res.setHeader("content-type", "application/json");
      let content =
        "## 合成验收结果\n已通过受控核心连接实际执行器。这里是合成 Provider，不是真实云端。\n\n邮箱顺序校验：forms@support.example.invalid";
      if (
        input.messages[0].content.includes("你是悟空，可操作独立浏览器电脑")
      ) {
        const text = input.messages[0].content;
        const excerpt = JSON.parse(
          text.split("页面摘录：")[1].split("\n用户目标：")[0],
        );
        let action = null,
          message = "网页已完成登录，我把截图放在右侧了。";
        if (!excerpt.running || !excerpt.text) {
          action = { kind: "open", url: "depdek:demo-login" };
          message = "我先打开登录演示网页。";
        } else if (!excerpt.text.includes("登录成功")) {
          if (excerpt.elements.filter((e) => e.input).every((e) => e.filled)) {
            const button = excerpt.elements.find(
              (e) => !e.input && e.type === "submit",
            );
            action = {
              kind: "click",
              target: button.target,
              page_revision: excerpt.revision,
            };
            message = "信息已填写，请在右侧确认登录按钮。";
          } else {
            action = { kind: "request_input" };
            message = "登录信息需要你填写，输入框已经放到右侧。";
          }
        }
        content = JSON.stringify({ message, action });
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content,
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
      );
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = mock.address().port;
  const control = {
    workspace_id: "room-demo",
    root: join(dir, "home"),
    read_paths: ["documents"],
    socket,
    secret_dir: join(dir, "private"),
    access_users: ["admin", "alice", "bob"].map((principal_id) => ({
      principal_id,
      password_hash: hash,
      read_paths: ["documents"],
    })),
    local_model_profiles: ["synthetic-room"],
    provider_profiles: [],
    cloud_model_hosts: ["api.deepseek.com"],
    household_enabled: true,
    room_runtime: {
      node: process.execPath,
      worker_script: sdk,
      worker_command: worker,
      trusted_local_worker: true,
    },
  };
  if (withComputer) {
    const docker = "/usr/local/bin/docker";
    const image = (
      await processText(
        docker,
        ["image", "inspect", "depdek-computer:0.2.1", "--format", "{{.Id}}"],
        "",
      )
    ).trim();
    const docker_host = (
      await processText(
        docker,
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        "",
      )
    ).trim();
    control.room_runtime.computer = {
      node: process.execPath,
      script: join(repo, "services/depdek-computer/host.mjs"),
      docker,
      image,
      docker_host,
      allowed_hosts: ["example.com", "www.wikipedia.org", "github.com"],
    };
  }
  await writeFile(join(dir, "core.json"), JSON.stringify(control), {
    mode: 0o600,
  });
  await writeFile(
    join(dir, "webdesk.toml"),
    `bind = '127.0.0.1:${port}'\ndata_dir = '${join(dir, "webdata")}'\nweb_root = '${join(repo, "webdesk/web/dist")}'\nbusiness_socket = '${socket}'\nbusiness_origin = '${origin}'\n[auth]\npassword_hash = '${webHash}'\n`,
    { mode: 0o600 },
  );
  for (const [command, path] of [
    [core, "core.json"],
    [web, "webdesk.toml"],
  ]) {
    const p = spawn(command, ["serve", "--config", join(dir, path)], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    p.stderr.on("data", () => {});
    children.push(p);
  }
  await ready(() => rpc(socket, "v2/health", {}));
  await ready(() => fetch(origin + "/api/health"));
  csrf = (await http("/api/login", { password: PASSWORD })).csrf;
  const controlCall = (path, body) =>
    http(path, { workspace_id: "room-demo", ...body }).then((r) => r.data);
  await controlCall("/api/v2/room/store", {
    action: "init",
    input: { operation_id: "init", passphrase: MASTER },
  });
  await controlCall("/api/v2/room/providers", {
    input: {
      operation_id: "save",
      id: "synthetic-room",
      name: "合成验收（不是云端）",
      base_url: `http://127.0.0.1:${mockPort}/v1`,
      model: "synthetic-room-model",
      api_key: KEY,
      expected_revision: 0,
    },
  });
  console.log(
    `Local synthetic Room: ${origin}\nFixture only: ${dir}\nAdmin / business admin,alice,bob: ${PASSWORD}\nSynthetic store: ${MASTER}\nDocker computer: ${withComputer ? "enabled" : "disabled"}\nNo real model/old credentials imported.`,
  );
  if (test) {
    let checks = 0;
    const pass = (label) => {
      console.log(`PASS ${++checks}: ${label}`);
    };
    const config = (await http("/api/v2/room/config")).data;
    assert.equal(config.profiles[0].id, "synthetic-room");
    assert.equal(config.profiles[0].configured, true);
    assert(!JSON.stringify(config).includes(KEY));
    pass("admin saved encrypted profile and immediate catalogue");
    const probe = () =>
      controlCall("/api/v2/room/providers/test", {
        input: {
          provider_id: "synthetic-room",
          profile_revision: 1,
          cloud_consent: false,
        },
      });
    const initialProbe = await probe();
    assert.equal(initialProbe.connection_verified, true);
    assert(initialProbe.result.text);
    await assert.rejects(
      () =>
        http(
          "/api/v2/room/providers/test",
          {
            workspace_id: "room-demo",
            input: {
              provider_id: "synthetic-room",
              profile_revision: 1,
              cloud_consent: false,
            },
          },
          { cookie: "" },
        ),
      /ADMIN_AUTH_REQUIRED/,
    );
    await assert.rejects(
      () =>
        http(
          "/api/v2/room/providers/test",
          {
            workspace_id: "room-demo",
            input: {
              provider_id: "synthetic-room",
              profile_revision: 1,
              cloud_consent: false,
            },
          },
          { "x-depdek-csrf": "invalid" },
        ),
      /CSRF_REQUIRED/,
    );
    await assert.rejects(
      () =>
        controlCall("/api/v2/room/providers/test", {
          input: {
            provider_id: "synthetic-room",
            profile_revision: 1,
            cloud_consent: false,
            prompt: "private user input",
          },
        }),
      /INVALID_INPUT/,
    );
    pass(
      "admin-only fixed connection probe works without private-space login; CSRF and arbitrary prompt rejected",
    );
    await controlCall('/api/v2/room/store',{action:'lock',input:{}});
    const update={operation_id:'admin-unlock-save',id:'synthetic-room',name:'合成验收（不是云端）',base_url:`http://127.0.0.1:${mockPort}/v1`,model:'synthetic-room-model',api_key:KEY,expected_revision:1};
    await assert.rejects(()=>controlCall('/api/v2/room/providers',{input:update}),/SECRET_STORE_LOCKED/);
    await controlCall('/api/v2/room/store',{action:'unlock',input:{passphrase:MASTER}});
    const savedAgain=await controlCall('/api/v2/room/providers',{input:update});
    const activeRevision=savedAgain.profile.profile_revision;
    const savedProbe=await controlCall('/api/v2/room/providers/test',{input:{provider_id:'synthetic-room',profile_revision:activeRevision,cloud_consent:false}});
    assert.equal(savedProbe.connection_verified,true);assert.equal(savedProbe.result.profile_revision,activeRevision);
    pass('locked admin unlocks, saves persistent profile and verifies the exact saved revision');
    const beforeEngines = count;
    const auth = (
      await http("/api/v2/auth/login", {
        username: "alice",
        password: PASSWORD,
      })
    ).data;
    business = auth.csrf_token;
    const chat = (engine) =>
      http("/api/v2/room/chat", {
        workspace_id: "room-demo",
        provider_id: "synthetic-room",
        profile_revision: activeRevision,
        engine,
        prompt: "只测试合成材料；核对 forms@support.example.invalid",
        max_tokens: 128,
        cloud_consent: false,
      });
    for (const engine of ["pi", "deepseek-harness"]) {
      const r = (await chat(engine)).data;
      assert.equal(r.runtime.engine, engine);
      assert(r.result.result.text.includes("forms@support.example.invalid"));
      assert.equal(r.result.result.usage.input_tokens, 12);
      assert.equal(r.runtime.key_received, false);
      assert.deepEqual(r.runtime.tools, []);
      pass(`actual ${engine} SDK through HTTP/BFF/core/single-use gateway`);
    }
    assert.equal(count - beforeEngines, 2);
    pass("exactly one provider request per engine");
    const family = (command, input) =>
      http("/api/v2/household", {
        workspace_id: "room-demo",
        command,
        input,
      }).then((r) => r.data);
    const importInput = {
      operation_id: "import",
      filename: "synthetic-receipt.txt",
      content_base64: Buffer.from("合成空调发票：2026-01-01；TEST-AC").toString(
        "base64",
      ),
      name: "客厅合成空调",
    };
    const first = await family("import", importInput);
    assert.deepEqual(first, await family("import", importInput));
    const item = first.item.id,
      source = first.source_id;
    let revision = first.item.revision;
    pass("original hash + idempotent import");
    for (const [index, value] of ["2026-01-01", "2026-01-02"].entries()) {
      const r = await family("assert", {
        operation_id: `date-${index}`,
        item_id: item,
        expected_revision: revision,
        source_id: source,
        field: "purchase_date",
        value,
        evidence: "原件第1行人工摘录",
      });
      revision = r.item.revision;
    }
    let state = await family("list", {});
    assert.equal(state.items[0].assertions.length, 2);
    assert.deepEqual(state.items[0].selected, {});
    pass("conflicting assertions preserved, no implicit confirmation");
    const r = await family("confirm", {
      operation_id: "confirm",
      item_id: item,
      expected_revision: revision,
      assertion_id: state.items[0].assertions[0].id,
    });
    revision = r.item.revision;
    const preview = await family("prepare", {
      operation_id: "preview",
      item_id: item,
      expected_revision: revision,
      apply: false,
    });
    assert.equal((await family("list", {})).tasks.length, 0);
    assert(preview.plan.markdown.includes("未知"));
    pass("exact diff preview has no writes and lists unknown facts");
    const input = {
      operation_id: "apply",
      item_id: item,
      expected_revision: revision,
      apply: true,
    };
    const receipt = await family("prepare", input);
    assert.deepEqual(receipt, await family("prepare", input));
    state = await family("list", {});
    assert.equal(state.tasks.length, 1);
    assert.equal(state.packages.length, 1);
    pass("package + task atomic apply, replay no duplicate");
    const original = await family("get", { id: source });
    assert.equal(original.source.content_base64, importInput.content_base64);
    pass("original export retains exact bytes");
    await family("assert", {
      operation_id: "correct",
      item_id: item,
      expected_revision: revision,
      source_id: source,
      field: "model",
      value: "TEST-CORRECTED",
      evidence: "原件第2行",
    });
    assert.equal((await family("get", { id: receipt.package_id })).stale, true);
    pass("correction invalidates derived package");
    await family("complete", {
      operation_id: "done",
      id: receipt.task_id,
      completed: true,
    });
    assert.equal((await family("list", {})).tasks[0].completed, true);
    pass("same business command completes task");
    const aliceCookie = cookies.get("depdek_business_session"),
      aliceCsrf = business;
    business = (
      await http("/api/v2/auth/login", { username: "bob", password: PASSWORD })
    ).data.csrf_token;
    assert.equal((await family("list", {})).items.length, 0);
    await assert.rejects(() => family("get", { id: source }), /NOT_FOUND/);
    pass("bob cannot discover/read alice evidence or derived results");
    cookies.set("depdek_business_session", aliceCookie);
    business = aliceCsrf;
    await controlCall("/api/v2/room/store", { action: "lock", input: {} });
    const before = count;
    await assert.rejects(() => chat("pi"));
    assert.equal(count, before);
    pass("locked credentials block before provider egress");
    await controlCall("/api/v2/room/store", {
      action: "unlock",
      input: { passphrase: MASTER },
    });
    const changed = { ...importInput, name: "different" };
    await assert.rejects(() => family("import", changed), /CONFLICT/);
    pass("same operation with changed params conflicts");
    if (withComputer) {
      const computer = (action) =>
        http("/api/v2/computer", { workspace_id: "room-demo", action }).then(
          (r) => r.data,
        );
      const browserChat = () =>
        http("/api/v2/room/chat", {
          workspace_id: "room-demo",
          provider_id: config.profiles[0].id,
            profile_revision: activeRevision,
          engine: "deepseek-harness",
          prompt: "打开登录演示网页，帮我完成登录并截图。",
          max_tokens: 1024,
          cloud_consent: false,
          agent_id: "wukong",
          computer: true,
        }).then((r) => r.data);
      const first = await browserChat();
      assert(first.computer.running);
      assert(first.computer.screenshot.length > 1000);
      assert.equal(first.continuation, true);
      const second = await browserChat();
      assert.equal(second.computer.request.fields.length, 2);
      const fields = second.computer.request.fields;
      const secret = "OnlyBrowser-Synthetic-2026!";
      const filled = await computer({
        kind: "respond",
        page_revision: second.computer.revision,
        values: { [fields[0].target]: "demo-user", [fields[1].target]: secret },
      });
      assert(!JSON.stringify({ ...filled, screenshot: null }).includes(secret));
      await assert.rejects(
        () =>
          computer({
            kind: "click",
            target: "e3",
            page_revision: second.computer.revision,
          }),
        /PAGE_CHANGED/,
      );
      const third = await browserChat();
      assert.equal(third.proposed_action.kind, "click");
      assert.equal(third.continuation, false);
      const logged = await computer(third.proposed_action);
      assert(logged.text.includes("登录成功"));
      assert(logged.screenshot);
      const fourth = await browserChat();
      assert(!fourth.proposed_action);
      assert.equal(fourth.continuation, false);
      const actorCookie = cookies.get("depdek_business_session"),
        actorCsrf = business;
      business = (
        await http("/api/v2/auth/login", {
          username: "bob",
          password: PASSWORD,
        })
      ).data.csrf_token;
      assert.equal((await computer({ kind: "status" })).running, false);
      cookies.set("depdek_business_session", actorCookie);
      business = actorCsrf;
      await assert.rejects(() =>
        computer({ kind: "open", url: "https://127.0.0.1" }),
      );
      await assert.rejects(
        () => computer({ kind: "open", url: "https://unapproved.example" }),
        /HOST_NOT_ALLOWED/,
      );
      await assert.rejects(() =>
        http(
          "/api/v2/computer",
          { workspace_id: "room-demo", action: { kind: "status" } },
          { "x-depdek-business-csrf": "invalid" },
        ),
      );
      const audit = await readFile(
        join(dir, "home/.vault-audit.jsonl"),
        "utf8",
      );
      assert(!audit.includes(secret));
      assert(!audit.includes("demo-user"));
      const publicPage = await computer({
        kind: "open",
        url: "https://example.com",
      });
      assert.equal(publicPage.title, "Example Domain");
      assert(publicPage.url.startsWith("https://example.com/"));
      assert(publicPage.text.length > 20);
      await computer({ kind: "stop" });
      pass(
        "actual Docker browser login/screenshot, human handoff, stale targets, per-user isolation and network/CSRF boundaries",
      );
    }
    const logs =
      (await readFile(join(dir, "home/.vault-audit.jsonl"), "utf8")) +
      (await readFile(join(dir, "private/.secret-audit.jsonl"), "utf8")) +
      (await readFile(join(dir, "webdata/webdesk-audit.jsonl"), "utf8"));
    for (const secret of [
      KEY,
      MASTER,
      PASSWORD,
      auth.csrf_token,
      importInput.content_base64,
      "TEST-CORRECTED",
    ]) {
      assert(!logs.includes(secret));
    }
    pass(
      "audit contains no keys, passphrases, credentials, prompts or receipt content",
    );
    console.log(
      `Verified ${checks} synthetic end-to-end groups; real cloud NOT verified.`,
    );
    await stop();
  } else {
    console.log(
      "Leave this process running for browser review. Ctrl-C stops only this fixture; original services untouched.",
    );
    await new Promise((r) => process.once("SIGINT", r));
    await stop();
  }
} catch (e) {
  await stop();
  console.error(`Fixture failed: ${e.message}. Retained ${dir}`);
  process.exitCode = 1;
}
