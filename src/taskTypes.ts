export type TaskStatus = "running" | "success" | "error";

export type TaskKind = "mail_fetch" | "mail_delete" | "mail_action" | "file_index" | "calendar_sync" | "model_run" | "other";

export type TaskLogLevel = "info" | "success" | "warn" | "error";

export interface TaskProgress {
  current: number;
  total?: number;
  label?: string;
}

export interface TaskLog {
  ts: number;
  level: TaskLogLevel;
  message: string;
}

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  title: string;
  detail: string;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  message?: string;
  progress?: TaskProgress;
  logs: TaskLog[];
}

export type TaskStartInput = Omit<TaskRecord, "id" | "status" | "startedAt" | "finishedAt" | "logs"> & { logs?: TaskLog[] };
export type TaskUpdate = Partial<Pick<TaskRecord, "status" | "detail" | "message" | "finishedAt" | "progress">> & {
  log?: Omit<TaskLog, "ts">;
};

export type TaskReporter = {
  onStartTask?: (task: TaskStartInput) => string;
  onUpdateTask?: (id: string, update: TaskUpdate) => void;
};
