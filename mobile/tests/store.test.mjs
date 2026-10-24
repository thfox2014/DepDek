import { test } from "node:test";
import assert from "node:assert/strict";
import { ButlerStore } from "../src/lib/store.ts";

test("live projection has no demo data and cannot execute demo behavior", () => {
  const store = new ButlerStore("live");
  assert.equal(store.getSnapshot().resources.length, 0);
  assert.equal(store.getSnapshot().memories.length, 0);
  assert.throws(() => store.sendDemo("整理资料"));
  assert.equal(store.adjustLight(80), undefined);
  assert.equal(store.getSnapshot().tasks.length, 0);
  store.dispose();
});
test("two demo tasks progress independently and unknown dates do not block preparation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new ButlerStore("demo");
  const first = store.sendDemo("整理资料");
  const second = store.sendDemo("准备维修资料");
  assert.notEqual(first, second);
  assert.equal(store.getSnapshot().tasks.length, 2);
  t.mock.timers.tick(4400);
  assert.equal(
    store.getSnapshot().tasks.find((item) => item.id === first).status,
    "done",
  );
  assert.equal(
    store.getSnapshot().tasks.find((item) => item.id === second).status,
    "waiting",
  );
  store.confirmDate(second, "unknown");
  t.mock.timers.tick(650);
  assert.equal(
    store.getSnapshot().tasks.find((item) => item.id === second).date,
    "unknown",
  );
  assert.equal(
    store.getSnapshot().tasks.find((item) => item.id === second).status,
    "done",
  );
  store.dispose();
});
test("duplicate ongoing intents do not create a second task", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new ButlerStore("demo");
  store.sendDemo("整理资料");
  store.sendDemo("再整理资料");
  assert.equal(store.getSnapshot().tasks.length, 1);
  store.dispose();
});
test("cancel and reset invalidate stale task callbacks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new ButlerStore("demo");
  const id = store.sendDemo("整理资料");
  assert.equal(store.cancel(id), true);
  t.mock.timers.tick(6000);
  assert.equal(store.getSnapshot().tasks[0].status, "cancelled");
  store.sendDemo("准备维修资料");
  store.clear();
  t.mock.timers.tick(6000);
  assert.equal(store.getSnapshot().tasks.length, 0);
  assert.equal(store.getSnapshot().messages.length, 0);
  store.dispose();
});
test("empty resources do not report successful organization", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new ButlerStore("demo");
  store.setDemoEmpty(true);
  store.sendDemo("整理资料");
  assert.equal(store.getSnapshot().tasks.length, 0);
  assert.match(store.getSnapshot().messages.at(-1).text, /没有可整理/);
  store.dispose();
});
test("lost device receipts remain unknown, and recheck never resends", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new ButlerStore("demo");
  store.failure = true;
  store.adjustLight(65);
  t.mock.timers.tick(800);
  assert.equal(store.getSnapshot().light, 42);
  assert.equal(store.getSnapshot().actualLight, 65);
  assert.equal(store.getSnapshot().lightUnknown, true);
  assert.equal(store.recheckLight(), false);
  store.adjustLight(80);
  assert.equal(store.getSnapshot().tasks.length, 1);
  store.failure = false;
  assert.equal(store.recheckLight(), true);
  assert.equal(store.getSnapshot().light, 65);
  assert.equal(store.getSnapshot().tasks.length, 1);
  store.dispose();
});
test("forget removes recall until a new explicit instruction", () => {
  const store = new ButlerStore("demo");
  store.forget("brief");
  store.sendDemo("你好");
  assert.equal(store.getSnapshot().memories.length, 0);
  store.sendDemo("请记住，回答简单一点");
  assert.equal(store.getSnapshot().memories.length, 1);
  assert.match(store.getSnapshot().memories[0].source, /请记住/);
  store.dispose();
});
test("in-flight live requests cannot be reported as cancelled", () => {
  const store = new ButlerStore("live");
  const id = store.addTask("一次请求", "model", "running");
  assert.equal(store.cancel(id), false);
  assert.equal(store.getSnapshot().tasks[0].status, "running");
  store.dispose();
});
