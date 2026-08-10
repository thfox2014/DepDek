/**
 * Canonical todo message bus.
 *
 * Mail, calendar and external connectors publish messages here.  The bus
 * normalizes them into durable TodoItems and emits a notification for UI
 * subscribers.  Handlers are callbacks, not callers: a connector registers a
 * hook once and the bus invokes it whenever a matching item is published.
 */

import { RpcError } from "./rpc.js";
import type { VaultClient } from "./tools.js";

export const TODO_QUEUE_PATH = "todo/queue.json";
export const TODO_SESSION_ID = "todo";
export const ERR_TODO_INVALID = -32602;

export type TodoLane = "backlog" | "now" | "blocked" | "done";
export type TodoPriority =
  | "important_urgent"
  | "important_not_urgent"
  | "urgent_not_important"
  | "other";
export type TodoSourceType = "manual" | "mail" | "calendar" | "agent" | "external";

export interface TodoSource {
  type: TodoSourceType;
  id?: string;
  label?: string;
  path?: string;
  remoteId?: string;
}

export interface TodoHookRef {
  name: string;
  status: "pending" | "running" | "success" | "error";
  message?: string;
  updatedAt?: string;
}

export interface TodoItem {
  id: string;
  title: string;
  description?: string;
  lane: TodoLane;
  priority: TodoPriority;
  source: TodoSource;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  dedupeKey?: string;
  hooks?: TodoHookRef[];
}

export interface TodoEnqueueInput {
  title: string;
  description?: string;
  lane?: TodoLane;
  priority?: TodoPriority;
  source: TodoSource;
  dueAt?: string;
  tags?: string[];
  dedupeKey?: string;
  hooks?: string[];
}

export interface TodoUpdateInput {
  id: string;
  title?: string;
  description?: string;
  lane?: TodoLane;
  priority?: TodoPriority;
  dueAt?: string;
  tags?: string[];
}

export interface TodoQueueFile {
  version: 1;
  updatedAt: string;
  items: TodoItem[];
}

export interface TodoEvent {
  type: "enqueued" | "updated";
  item: TodoItem;
  emittedAt: string;
}

export type TodoHook = (event: TodoEvent) => void | Promise<void>;

/** A small in-process pub/sub bus; subscriber callbacks are invoked by name. */
export class TodoBus {
  private readonly subscribers = new Map<string, Set<TodoHook>>();

  subscribe(name: string, hook: TodoHook): () => void {
    const hooks = this.subscribers.get(name) ?? new Set<TodoHook>();
    hooks.add(hook);
    this.subscribers.set(name, hooks);
    return () => {
      hooks.delete(hook);
      if (hooks.size === 0) this.subscribers.delete(name);
    };
  }

  async publish(event: TodoEvent): Promise<void> {
    const names = new Set(["*"]);
    for (const hook of event.item.hooks ?? []) names.add(hook.name);
    for (const name of names) {
      for (const hook of this.subscribers.get(name) ?? []) await hook(event);
    }
  }
}

export const todoBus = new TodoBus();

let queueTail: Promise<void> = Promise.resolve();

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queueTail.then(operation, operation);
  queueTail = result.then(() => undefined, () => undefined);
  return result;
}

function now(): string {
  return new Date().toISOString();
}

function queueEmpty(): TodoQueueFile {
  return { version: 1, updatedAt: now(), items: [] };
}

async function readQueue(vault: VaultClient): Promise<TodoQueueFile> {
  try {
    const result = await vault.request<{ content: string }>("vault/read_file", {
      session_id: TODO_SESSION_ID,
      path: TODO_QUEUE_PATH,
    });
    const parsed = JSON.parse(result.content) as Partial<TodoQueueFile>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now(),
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (error) {
    if (error instanceof RpcError && error.code === -32002) return queueEmpty();
    throw error;
  }
}

async function writeQueue(vault: VaultClient, items: TodoItem[]): Promise<TodoQueueFile> {
  const queue: TodoQueueFile = { version: 1, updatedAt: now(), items };
  await vault.request("vault/write_file", {
    session_id: TODO_SESSION_ID,
    path: TODO_QUEUE_PATH,
    content: `${JSON.stringify(queue, null, 2)}\n`,
  });
  return queue;
}

function invalid(message: string): never {
  throw new RpcError(ERR_TODO_INVALID, message);
}

function normalizeInput(input: TodoEnqueueInput): TodoEnqueueInput {
  if (!input || typeof input.title !== "string" || !input.title.trim()) invalid("todo title is required");
  if (!input.source || typeof input.source !== "object" || !input.source.type) invalid("todo source.type is required");
  const lanes: TodoLane[] = ["backlog", "now", "blocked", "done"];
  const priorities: TodoPriority[] = ["important_urgent", "important_not_urgent", "urgent_not_important", "other"];
  const sourceTypes: TodoSourceType[] = ["manual", "mail", "calendar", "agent", "external"];
  if (input.lane && !lanes.includes(input.lane)) invalid(`unknown todo lane: ${input.lane}`);
  if (input.priority && !priorities.includes(input.priority)) invalid(`unknown todo priority: ${input.priority}`);
  if (!sourceTypes.includes(input.source.type)) invalid(`unknown todo source.type: ${input.source.type}`);
  return {
    ...input,
    title: input.title.trim(),
    lane: input.lane ?? "backlog",
    priority: input.priority ?? "other",
    source: { ...input.source, type: input.source.type },
    tags: input.tags?.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim()),
    hooks: input.hooks?.filter((hook) => typeof hook === "string" && hook.trim()).map((hook) => hook.trim()),
  };
}

function createItem(input: TodoEnqueueInput): TodoItem {
  const timestamp = now();
  return {
    id: `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: input.title,
    description: input.description,
    lane: input.lane ?? "backlog",
    priority: input.priority ?? "other",
    source: input.source,
    dueAt: input.dueAt,
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: input.tags,
    dedupeKey: input.dedupeKey,
    hooks: input.hooks?.map((name) => ({ name, status: "pending" })),
  };
}

export async function listTodos(vault: VaultClient): Promise<TodoQueueFile> {
  return readQueue(vault);
}

export async function enqueueTodo(
  vault: VaultClient,
  input: TodoEnqueueInput,
  notify: (event: TodoEvent) => void,
): Promise<{ item: TodoItem; duplicate?: boolean }> {
  return serial(async () => {
    const normalized = normalizeInput(input);
    const queue = await readQueue(vault);
    if (normalized.dedupeKey) {
      const duplicate = queue.items.find((item) => item.dedupeKey === normalized.dedupeKey);
      if (duplicate) return { item: duplicate, duplicate: true };
    }
    const item = createItem(normalized);
    await writeQueue(vault, [item, ...queue.items]);
    const event: TodoEvent = { type: "enqueued", item, emittedAt: now() };
    notify(event);
    void todoBus.publish(event).catch((error) => console.error("[todo] hook failed:", error));
    return { item };
  });
}

export async function updateTodo(
  vault: VaultClient,
  input: TodoUpdateInput,
  notify: (event: TodoEvent) => void,
): Promise<{ item: TodoItem }> {
  return serial(async () => {
    if (!input?.id) invalid("todo id is required");
    const queue = await readQueue(vault);
    const index = queue.items.findIndex((item) => item.id === input.id);
    if (index < 0) throw new RpcError(-32002, `todo not found: ${input.id}`);
    const current = queue.items[index]!;
    const lanes: TodoLane[] = ["backlog", "now", "blocked", "done"];
    const priorities: TodoPriority[] = ["important_urgent", "important_not_urgent", "urgent_not_important", "other"];
    if (input.lane && !lanes.includes(input.lane)) invalid(`unknown todo lane: ${input.lane}`);
    if (input.priority && !priorities.includes(input.priority)) invalid(`unknown todo priority: ${input.priority}`);
    const item: TodoItem = {
      ...current,
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.lane === undefined ? {} : { lane: input.lane }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      updatedAt: now(),
    };
    if (!item.title) invalid("todo title cannot be empty");
    const items = queue.items.slice();
    items[index] = item;
    await writeQueue(vault, items);
    const event: TodoEvent = { type: "updated", item, emittedAt: now() };
    notify(event);
    void todoBus.publish(event).catch((error) => console.error("[todo] hook failed:", error));
    return { item };
  });
}
