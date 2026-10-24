import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MobileApi, ApiError, requiresLogin } from "../src/lib/api.ts";

const session = {
  principal_id: "alice",
  workspace_id: "workspace-1",
  csrf_token: `csrf_${"a".repeat(64)}`,
};
const profile = {
  id: "configured-provider",
  revision: 3,
  name: "Configured",
  model: "configured-model",
  cloud: true,
  engine: "deepseek-harness",
};
const answer = {
  runtime: {
    engine: "deepseek-harness",
    package: "synthetic-sdk",
    version: "test",
  },
  result: {
    status: "completed",
    result: {
      text: "Synthetic answer",
      model: "configured-model",
      reported_model: "model-from-server",
      usage: { input_tokens: 4, output_tokens: 3 },
    },
  },
};
const reply = (data, status = 200) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
function setup(handler) {
  const calls = [];
  const client = new MobileApi(async (path, options) => {
    calls.push({ path, options });
    return handler(path, options);
  });
  return { client, calls };
}

test("login uses only business username/password, HttpOnly cookies and no body role", async () => {
  const { client, calls } = setup(() => reply(session));
  await client.login("alice", "SYNTHETIC_TEST_PASSWORD");
  assert.equal(calls[0].path, "/api/v2/auth/login");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    username: "alice",
    password: "SYNTHETIC_TEST_PASSWORD",
  });
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal("x-depdek-csrf" in calls[0].options.headers, false);
});
test("exact-input chat has a business CSRF, fixed agent, no files/history/key", async () => {
  const { client, calls } = setup((path) =>
    reply(path.endsWith("/login") ? session : answer),
  );
  await client.login("alice", "SYNTHETIC");
  const result = await client.chat("只发送这一句话", profile, true);
  assert.equal(result.result.result.text, "Synthetic answer");
  const call = calls.at(-1);
  assert.equal(call.path, "/api/v2/room/chat");
  assert.equal(
    call.options.headers["x-depdek-business-csrf"],
    session.csrf_token,
  );
  assert.deepEqual(JSON.parse(call.options.body), {
    workspace_id: "workspace-1",
    provider_id: "configured-provider",
    profile_revision: 3,
    engine: "deepseek-harness",
    prompt: "只发送这一句话",
    max_tokens: 1024,
    cloud_consent: true,
    agent_id: "wukong",
    computer: false,
  });
});
test("cloud consent and missing sessions cannot silently fall back or call a provider", async () => {
  const { client, calls } = setup(() => reply(session));
  await assert.rejects(
    client.chat("Hello", profile, true),
    (error) => error.code === "AUTH_REQUIRED",
  );
  assert.equal(calls.length, 0);
  await client.login("alice", "SYNTHETIC");
  await assert.rejects(
    client.chat("Hello", profile, false),
    (error) => error.code === "FORBIDDEN",
  );
  assert.equal(calls.length, 1);
});
test("only fixed delegated file commands are used", async () => {
  const { client, calls } = setup((path) =>
    reply(
      path.endsWith("/login")
        ? session
        : {
            status: "completed",
            result: {
              entries: [{ name: "家庭资料.md", kind: "file", size: 12 }],
              truncated: false,
            },
          },
    ),
  );
  await client.login("alice", "SYNTHETIC");
  const result = await client.listFiles("documents/alice");
  assert.equal(result.resources[0].path, "documents/alice/家庭资料.md");
  const call = calls.at(-1);
  assert.equal(call.path, "/api/v2/commands/invoke");
  assert.deepEqual(JSON.parse(call.options.body), {
    workspace_id: "workspace-1",
    command: "file.list",
    command_version: "1.0",
    input: { path: "documents/alice", limit: 200 },
  });
});
test("auth failures erase the in-memory session and do not auto retry", async () => {
  const { client, calls } = setup((path) =>
    path.endsWith("/login")
      ? reply(session)
      : new Response(JSON.stringify({ error: { code: "SESSION_EXPIRED" } }), {
          status: 401,
        }),
  );
  await client.login("alice", "SYNTHETIC");
  await assert.rejects(client.chat("Hello", profile, true), (error) =>
    requiresLogin(error),
  );
  assert.equal(calls.length, 2);
  await assert.rejects(
    client.chat("Again", profile, true),
    (error) => error.code === "AUTH_REQUIRED",
  );
  assert.equal(calls.length, 2);
});
test("admin authentication is not confused with household login", () => {
  assert.equal(requiresLogin(new ApiError("ADMIN_AUTH_REQUIRED")), false);
  assert.equal(requiresLogin(new ApiError("SESSION_EXPIRED")), true);
});
test("untrusted errors are never displayed raw and never retried", async () => {
  const { client, calls } = setup(
    () =>
      new Response(
        JSON.stringify({
          error: {
            code: "SYNTHETIC_SECRET_SHOULD_NOT_APPEAR",
            message: "SYNTHETIC_SECRET_BODY",
          },
        }),
        { status: 502 },
      ),
  );
  await assert.rejects(client.restore(), (error) => {
    assert.doesNotMatch(error.message, /SYNTHETIC_SECRET/);
    return true;
  });
  assert.equal(calls.length, 1);
});
test("HTML or invalid successful responses are not treated as connected", async () => {
  const { client } = setup(
    () => new Response("<html>not an API</html>", { status: 200 }),
  );
  await assert.rejects(
    client.restore(),
    (error) => error.code === "INVALID_RESPONSE",
  );
});
test("a stale session restore cannot restore identity after explicit logout/clear", async () => {
  let resolve;
  const { client, calls } = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = client.restore();
  client.clearSession();
  resolve(reply(session));
  await assert.rejects(pending, (error) => error.code === "SESSION_EXPIRED");
  await assert.rejects(
    client.chat("Hello", profile, true),
    (error) => error.code === "AUTH_REQUIRED",
  );
  assert.equal(calls.length, 1);
});
test("session responses must contain a valid business CSRF, not an arbitrary object", async () => {
  const { client } = setup(() => reply({ ...session, csrf_token: "invalid" }));
  await assert.rejects(
    client.restore(),
    (error) => error.code === "INVALID_RESPONSE",
  );
});
test("new frontend has no credential persistence or direct model endpoint", () => {
  const source = readFileSync(
    new URL("../src/lib/api.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|indexedDB|api_key|Authorization/,
  );
  assert.doesNotMatch(source, /\/api\/files|\/api\/agent\/chat|\/rpc/);
});

test("an HTML 401 still requires login without displaying its body", async () => {
  const { client } = setup(
    () => new Response("<html>SYNTHETIC_PRIVATE_HTML</html>", { status: 401 }),
  );
  await assert.rejects(client.restore(), (error) => {
    assert.equal(requiresLogin(error), true);
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_HTML/);
    return true;
  });
});

test("SDK engine mismatch is not a verified model result", async () => {
  const { client } = setup((path) =>
    reply(
      path.endsWith("/login")
        ? session
        : { ...answer, runtime: { ...answer.runtime, engine: "pi" } },
    ),
  );
  await client.login("alice", "SYNTHETIC");
  await assert.rejects(
    client.chat("Hello", profile, true),
    (error) => error.code === "MODEL_OUTCOME_UNKNOWN",
  );
});

test("changing the restored household identity invalidates an old in-flight response", async () => {
  let resolveOld;
  const { client, calls } = setup((path) => {
    if (path.endsWith("/login")) return reply(session);
    if (path.endsWith("/session"))
      return reply({ ...session, principal_id: "bob" });
    return new Promise((resolve) => {
      resolveOld = resolve;
    });
  });
  await client.login("alice", "SYNTHETIC");
  const pending = client.chat("A private question", profile, true);
  const next = await client.restore();
  assert.equal(next.principal_id, "bob");
  resolveOld(reply(answer));
  await assert.rejects(pending, (error) => error.code === "SESSION_EXPIRED");
  assert.equal(calls.length, 3);
});

test("logout prevents further authenticated requests even if its response is lost", async () => {
  const { client, calls } = setup((path) => {
    if (path.endsWith("/login")) return reply(session);
    throw new Error("synthetic network failure");
  });
  await client.login("alice", "SYNTHETIC");
  await assert.rejects(
    client.logout(),
    (error) => error.code === "UNKNOWN_RESPONSE",
  );
  await assert.rejects(
    client.chat("Hello", profile, true),
    (error) => error.code === "AUTH_REQUIRED",
  );
  assert.equal(calls.length, 2);
});
