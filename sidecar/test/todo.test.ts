import { describe, expect, it } from "vitest";
import { RpcError } from "../src/rpc.js";
import { enqueueTodo, listTodos, todoBus, updateTodo, type TodoQueueFile } from "../src/todo.js";

function fakeVault() {
  let content: string | undefined;
  return {
    async request<T = unknown>(method: string, params?: any): Promise<T> {
      if (method === "vault/read_file") {
        if (!content) throw new RpcError(-32002, "not found");
        return { content } as T;
      }
      if (method === "vault/write_file") {
        content = params.content;
        return {} as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    read(): TodoQueueFile | undefined {
      return content ? JSON.parse(content) as TodoQueueFile : undefined;
    },
  };
}

describe("todo message bus", () => {
  it("normalizes and persists an incoming message", async () => {
    const vault = fakeVault();
    const events: unknown[] = [];
    const result = await enqueueTodo(vault, {
      title: "  回复邮件  ",
      source: { type: "mail", id: "mail-1" },
      hooks: ["audit.todo"],
    }, (event) => events.push(event));
    expect(result.item.title).toBe("回复邮件");
    expect(result.item.lane).toBe("backlog");
    expect(result.item.priority).toBe("other");
    expect(result.item.hooks?.[0]).toMatchObject({ name: "audit.todo", status: "pending" });
    expect(vault.read()?.items).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("deduplicates messages from the same source", async () => {
    const vault = fakeVault();
    const first = await enqueueTodo(vault, { title: "同步事件", source: { type: "calendar", id: "event-1" }, dedupeKey: "calendar:event-1" }, () => {});
    const second = await enqueueTodo(vault, { title: "同步事件（重复）", source: { type: "calendar", id: "event-1" }, dedupeKey: "calendar:event-1" }, () => {});
    expect(second.duplicate).toBe(true);
    expect(second.item.id).toBe(first.item.id);
    expect(vault.read()?.items).toHaveLength(1);
  });

  it("invokes matching subscriber hooks without the publisher calling them", async () => {
    const vault = fakeVault();
    const seen: string[] = [];
    const unsubscribe = todoBus.subscribe("calendar.follow-up", (event) => {
      seen.push(`${event.type}:${event.item.title}`);
    });
    await enqueueTodo(vault, { title: "会议后跟进", source: { type: "calendar" }, hooks: ["calendar.follow-up"] }, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();
    expect(seen).toEqual(["enqueued:会议后跟进"]);
  });

  it("updates a lane and emits an update event", async () => {
    const vault = fakeVault();
    const events: string[] = [];
    const created = await enqueueTodo(vault, { title: "开始处理", source: { type: "manual" } }, () => {});
    const updated = await updateTodo(vault, { id: created.item.id, lane: "now", priority: "important_urgent" }, (event) => events.push(event.type));
    expect(updated.item.lane).toBe("now");
    expect(updated.item.priority).toBe("important_urgent");
    expect(events).toEqual(["updated"]);
    expect((await listTodos(vault)).items[0]?.lane).toBe("now");
  });
});
