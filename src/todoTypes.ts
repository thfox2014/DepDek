/**
 * Canonical work queue types shared by the Todo board, mail, calendar and
 * the sidecar message bus.  A message is an input; a TodoItem is the durable
 * work record created from that input.
 */

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

export const TODO_LANES: Array<{ id: TodoLane; label: string; hint: string }> = [
  { id: "backlog", label: "待办", hint: "已经确认，等待安排" },
  { id: "now", label: "马上办", hint: "当前专注处理" },
  { id: "blocked", label: "等待中", hint: "等待他人或外部条件" },
  { id: "done", label: "已办完", hint: "已闭环，可回溯" },
];

export const TODO_PRIORITIES: Array<{ id: TodoPriority; label: string; short: string }> = [
  { id: "important_urgent", label: "重要且紧急", short: "重要 · 紧急" },
  { id: "important_not_urgent", label: "重要不紧急", short: "重要 · 不急" },
  { id: "urgent_not_important", label: "紧急不重要", short: "紧急 · 次要" },
  { id: "other", label: "其他", short: "其他" },
];

export function todoLaneLabel(lane: TodoLane): string {
  return TODO_LANES.find((item) => item.id === lane)?.label ?? lane;
}

export function todoPriorityLabel(priority: TodoPriority): string {
  return TODO_PRIORITIES.find((item) => item.id === priority)?.label ?? priority;
}
