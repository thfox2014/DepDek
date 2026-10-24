export type Mode = "live" | "demo";
export type Tab = "chat" | "tasks" | "home" | "memory" | "files";
export type Category = "全部" | "照片" | "视频" | "文档" | "邮件" | "其他";
export type Engine = "pi" | "deepseek-harness";
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "error"
  | "unknown"
  | "cancelled";
export interface Profile {
  id: string;
  revision: number;
  name: string;
  model: string;
  cloud: boolean;
  engine: Engine;
}
export interface BusinessSession {
  principal_id: string;
  workspace_id: string;
  csrf_token: string;
}
export interface RoomConfig {
  enabled: boolean;
  profiles: Array<{
    id: string;
    name: string;
    model: string;
    base_url: string;
    profile_revision: number;
    configured: boolean;
  }>;
}
export interface RoomAnswer {
  runtime: { engine: string; package: string; version: string };
  result: {
    status: string;
    result: {
      text: string;
      model: string;
      reported_model?: string | null;
      usage: { input_tokens: number; output_tokens: number } | null;
    };
  };
}
export interface Resource {
  id: string;
  name: string;
  path: string;
  category: Exclude<Category, "全部">;
  kind: "file" | "dir";
  size: number | null;
  note?: string;
  sha256?: string;
  content?: string;
}
export interface Task {
  id: string;
  title: string;
  kind: "organize" | "repair" | "model" | "light";
  status: TaskStatus;
  phase: string;
  step: number;
  date?: string;
  reply?: string;
  usage?: { input_tokens: number; output_tokens: number } | null;
  error?: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  taskId?: string;
  error?: boolean;
}
export interface Memory {
  id: string;
  text: string;
  source: string;
}
export type Panel =
  | { type: "task"; id: string }
  | { type: "file"; id: string }
  | {
      type: "light" | "settings" | "privacy" | "model" | "package";
      id?: string;
    };
export interface FamilyItem {
  id: string;
  name: string;
  revision: number;
  sources: string[];
  assertions: Array<{
    id: string;
    field: string;
    value: string;
    evidence: string;
    source_id: string;
  }>;
  selected: Record<string, string>;
}
export interface FamilyPack {
  id: string;
  item_id: string;
  markdown: string;
  stale: boolean;
}
export interface Household {
  items: FamilyItem[];
  packages: FamilyPack[];
  tasks: Array<{
    id: string;
    title: string;
    completed: boolean;
    package_id: string;
  }>;
}
export interface PackagePlan {
  item_id: string;
  revision: number;
  markdown: string;
  effects: string[];
}
export interface StoreState {
  messages: Message[];
  tasks: Task[];
  resources: Resource[];
  memories: Memory[];
  light: number;
  lightBefore: number;
  lightUnknown: boolean;
  actualLight: number;
  lightReceipt: boolean;
}
