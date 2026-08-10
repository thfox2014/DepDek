import * as api from "./api";
import type { TodoEnqueueInput, TodoItem, TodoQueueFile, TodoUpdateInput } from "./todoTypes";

export const TODO_QUEUE_PATH = "todo/queue.json";
const PREVIEW_STORAGE_KEY = "depdek.todo.queue.v1";
const TODO_EVENT = "depdek:todo-event";

const isBrowserPreview = () => typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

const previewNow = () => new Date().toISOString();

function previewQueue(): TodoItem[] {
  try {
    const value = window.localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (value) {
      const parsed = JSON.parse(value) as Partial<TodoQueueFile>;
      if (Array.isArray(parsed.items)) return parsed.items;
    }
  } catch {
    // Browser preview storage is optional; keep the UX usable if it is blocked.
  }
  const now = previewNow();
  return [
    { id: "preview-todo-mail", title: "确认域名续费并完成付款", description: "从邮件抽取的硬截止行动项", lane: "now", priority: "important_urgent", source: { type: "mail", id: "preview-domain", label: "域名续费提醒" }, createdAt: now, updatedAt: now, tags: ["付款", "邮件"] },
    { id: "preview-todo-review", title: "整理 DepDek 重构评审纪要", lane: "backlog", priority: "important_not_urgent", source: { type: "calendar", id: "preview-review", label: "DepDek 重构评审" }, createdAt: now, updatedAt: now },
    { id: "preview-todo-wait", title: "等待 Alice 确认 Q3 预算数据", lane: "blocked", priority: "important_not_urgent", source: { type: "mail", id: "preview-alice", label: "Q3 预算表 v2" }, createdAt: now, updatedAt: now },
    { id: "preview-todo-done", title: "回复法务关于授权范围的邮件", lane: "done", priority: "urgent_not_important", source: { type: "mail", id: "preview-legal", label: "法务邮件" }, createdAt: now, updatedAt: now },
  ];
}

function emitPreviewEvent(): void {
  window.dispatchEvent(new CustomEvent(TODO_EVENT));
}

function savePreviewQueue(items: TodoItem[]): void {
  try {
    window.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify({ version: 1, updatedAt: previewNow(), items } satisfies TodoQueueFile));
  } catch {
    // Keep in-memory behaviour for the current component when storage fails.
  }
  emitPreviewEvent();
}

export async function listTodos(): Promise<TodoItem[]> {
  if (isBrowserPreview()) return previewQueue();
  const result = await api.todoList();
  return result.items;
}

export async function enqueueTodo(input: TodoEnqueueInput): Promise<TodoItem> {
  if (isBrowserPreview()) {
    const items = previewQueue();
    const duplicate = input.dedupeKey && items.find((item) => item.dedupeKey === input.dedupeKey);
    if (duplicate) return duplicate;
    const now = previewNow();
    const item: TodoItem = {
      id: `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: input.title.trim(),
      description: input.description,
      lane: input.lane ?? "backlog",
      priority: input.priority ?? "other",
      source: input.source,
      dueAt: input.dueAt,
      createdAt: now,
      updatedAt: now,
      tags: input.tags,
      dedupeKey: input.dedupeKey,
      hooks: input.hooks?.map((name) => ({ name, status: "pending" as const })),
    };
    savePreviewQueue([item, ...items]);
    return item;
  }
  const result = await api.todoEnqueue(input);
  return result.item;
}

export async function updateTodo(input: TodoUpdateInput): Promise<TodoItem> {
  if (isBrowserPreview()) {
    const items = previewQueue();
    const current = items.find((item) => item.id === input.id);
    if (!current) throw new Error(`待办不存在：${input.id}`);
    const item: TodoItem = {
      ...current,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.lane === undefined ? {} : { lane: input.lane }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      id: current.id,
      updatedAt: previewNow(),
    };
    savePreviewQueue(items.map((candidate) => candidate.id === item.id ? item : candidate));
    return item;
  }
  const result = await api.todoUpdate(input);
  return result.item;
}

export function subscribeTodoChanges(listener: () => void): () => void {
  if (isBrowserPreview()) {
    window.addEventListener(TODO_EVENT, listener);
    return () => window.removeEventListener(TODO_EVENT, listener);
  }
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void api.onTodoEvent(() => {
    if (!disposed) listener();
  }).then((cleanup) => {
    if (disposed) cleanup();
    else unlisten = cleanup;
  }).catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}
