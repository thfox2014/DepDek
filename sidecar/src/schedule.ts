/**
 * Cron and event routines.
 *
 * Routines live in a protected vault file and run an online agent's existing
 * turn. They do not create sessions, spawn processes, or skip approval.
 * Each attempt is audited through Rust (`schedule/audit`).
 */

import { randomBytes } from "node:crypto";
import { CONTROL_PATHS, isRootNotSet, oneLine, readControlJson, writeControlJson } from "./control.js";
import { RpcError } from "./rpc.js";
import type { TeamRunResult, TurnContext } from "./team.js";
import type { VaultClient } from "./tools.js";

export const SCHEDULE_LIMITS = {
  maxRoutines: 50,
  maxPrompt: 4000,
  maxPerHour: 8,
} as const;

export type RoutineTrigger =
  | { type: "cron"; expr: string }
  | { type: "event"; source: "mail" | "todo"; match?: string };

export interface Routine {
  id: string;
  label: string;
  agent_id: string;
  prompt: string;
  enabled: boolean;
  trigger: RoutineTrigger;
  created_at: string;
  updated_at: string;
  last_fired_at?: string;
  last_status?: "ran" | "skipped" | "failed";
  last_error?: string;
}

interface RoutineFile {
  version: 1;
  routines: Routine[];
}

export interface ScheduleHost {
  has(sessionId: string): boolean;
  isBusy(sessionId: string): boolean;
  runTurn(sessionId: string, text: string, turn: TurnContext): Promise<TeamRunResult>;
}

export interface ScheduleEvents {
  notify(method: string, params?: unknown): void;
}

function newRoutineId(): string {
  return `rtn_${randomBytes(6).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneRoutine(routine: Routine): Routine {
  return { ...routine, trigger: { ...routine.trigger } };
}

export function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => partMatches(part.trim(), value, min, max));
}

function partMatches(part: string, value: number, min: number, max: number): boolean {
  if (!part) return false;
  const [base, stepText, extra] = part.split("/");
  if (extra !== undefined || base === undefined) return false;
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isInteger(step) || step <= 0) return false;
  if (base !== "*" && stepText !== undefined && !base.includes("-")) return false;
  let start = min;
  let end = max;
  if (base === "*") {
    start = min;
    end = max;
  } else if (base.includes("-")) {
    const [rawStart, rawEnd, more] = base.split("-");
    if (more !== undefined) return false;
    start = Number(rawStart);
    end = Number(rawEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return false;
  } else {
    const exact = Number(base);
    if (!Number.isInteger(exact) || exact < min || exact > max) return false;
    return exact === value;
  }
  if (value < start || value > end) return false;
  return (value - start) % step === 0;
}

export function isCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.every((field, index) => {
    const range = ranges[index];
    if (!range) return false;
    return field.split(",").every((part) => syntaxOk(part.trim(), range[0], range[1]));
  });
}

function syntaxOk(part: string, min: number, max: number): boolean {
  if (!part) return false;
  const [base, stepText, extra] = part.split("/");
  if (extra !== undefined || base === undefined) return false;
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isInteger(step) || step <= 0) return false;
  if (base !== "*" && stepText !== undefined && !base.includes("-")) return false;
  if (base === "*") return true;
  if (base.includes("-")) {
    const [rawStart, rawEnd, more] = base.split("-");
    if (more !== undefined) return false;
    const start = Number(rawStart);
    const end = Number(rawEnd);
    return Number.isInteger(start) && Number.isInteger(end) && start >= min && end <= max && start <= end;
  }
  const exact = Number(base);
  return Number.isInteger(exact) && exact >= min && exact <= max;
}

/** Five-field cron in the machine's local time. When both day-of-month and day-of-week are restricted, either match is enough. */
export function cronMatches(expr: string, date: Date): boolean {
  if (!isCronExpr(expr)) return false;
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/) as [string, string, string, string, string];
  if (!fieldMatches(minute, date.getMinutes(), 0, 59)) return false;
  if (!fieldMatches(hour, date.getHours(), 0, 23)) return false;
  if (!fieldMatches(month, date.getMonth() + 1, 1, 12)) return false;
  const domOk = fieldMatches(dom, date.getDate(), 1, 31);
  const weekday = date.getDay();
  const dowOk = fieldMatches(dow, weekday, 0, 7) || (weekday === 0 && fieldMatches(dow, 7, 0, 7));
  if (dom !== "*" && dow !== "*") return domOk || dowOk;
  if (dom !== "*") return domOk;
  if (dow !== "*") return dowOk;
  return true;
}

function sessionToken(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

export function normalizeRoutine(input: unknown, existing?: Routine): Routine {
  const body = (input ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : existing?.id ?? newRoutineId();
  if (!/^rtn_[0-9a-f]{8,32}$/.test(id)) throw new RpcError(-32602, "routine id must look like rtn_<hex>");
  const label = oneLine(String(body.label ?? existing?.label ?? ""), 80);
  const agentId = String(body.agent_id ?? body.agentId ?? existing?.agent_id ?? "").trim();
  const prompt = String(body.prompt ?? existing?.prompt ?? "").trim();
  if (!label) throw new RpcError(-32602, "routine label is required");
  if (!sessionToken(agentId)) throw new RpcError(-32602, "agent_id must be a session token");
  if (!prompt || prompt.length > SCHEDULE_LIMITS.maxPrompt) throw new RpcError(-32602, "prompt must be 1-4000 characters");
  const trigger = normalizeTrigger(body.trigger ?? existing?.trigger);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : existing?.enabled ?? true;
  const created = typeof body.created_at === "string" ? body.created_at : existing?.created_at ?? nowIso();
  const lastStatus = body.last_status === "ran" || body.last_status === "skipped" || body.last_status === "failed"
    ? body.last_status
    : existing?.last_status;
  const lastError = typeof body.last_error === "string" ? oneLine(body.last_error, 240) : existing?.last_error;
  const lastFired = typeof body.last_fired_at === "string" ? body.last_fired_at : existing?.last_fired_at;
  return {
    id,
    label,
    agent_id: agentId,
    prompt,
    enabled,
    trigger,
    created_at: created,
    updated_at: nowIso(),
    ...(lastFired ? { last_fired_at: lastFired } : {}),
    ...(lastStatus ? { last_status: lastStatus } : {}),
    ...(lastError ? { last_error: lastError } : {}),
  };
}

function normalizeTrigger(input: unknown): RoutineTrigger {
  const body = (input ?? {}) as { type?: unknown; expr?: unknown; source?: unknown; match?: unknown };
  if (body.type === "cron") {
    const expr = String(body.expr ?? "").trim();
    if (!isCronExpr(expr)) throw new RpcError(-32602, "cron expr must be five fields");
    return { type: "cron", expr };
  }
  if (body.type === "event") {
    if (body.source !== "mail" && body.source !== "todo") throw new RpcError(-32602, "event source must be mail or todo");
    const match = typeof body.match === "string" ? oneLine(body.match, 120) : undefined;
    return { type: "event", source: body.source, ...(match ? { match } : {}) };
  }
  throw new RpcError(-32602, "trigger type must be cron or event");
}

export class Scheduler {
  private readonly routines = new Map<string, Routine>();
  private readonly lastMinute = new Map<string, string>();
  private readonly recent = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private restored = false;
  private restorePromise: Promise<void> | null = null;

  constructor(
    private readonly host: ScheduleHost,
    private readonly events: ScheduleEvents,
    private readonly vault: VaultClient,
  ) {
    void this.ensureRestored();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(new Date()), 20_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): { routines: Routine[] } {
    return { routines: [...this.routines.values()].map(cloneRoutine) };
  }

  async put(input: unknown): Promise<{ routine: Routine }> {
    await this.ensureRestored();
    const current = typeof (input as { id?: unknown })?.id === "string"
      ? this.routines.get(String((input as { id: string }).id))
      : undefined;
    const routine = normalizeRoutine(input, current);
    if (!current && this.routines.size >= SCHEDULE_LIMITS.maxRoutines) {
      throw new RpcError(-32602, "too many routines");
    }
    this.routines.set(routine.id, routine);
    await this.persist();
    this.emit(routine, routine.enabled ? "saved" : "paused");
    return { routine: cloneRoutine(routine) };
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    await this.ensureRestored();
    if (!/^rtn_[0-9a-f]{8,32}$/.test(id)) throw new RpcError(-32602, "routine id must look like rtn_<hex>");
    const deleted = this.routines.delete(id);
    if (deleted) await this.persist();
    return { deleted };
  }

  tick(now = new Date()): void {
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    for (const routine of this.routines.values()) {
      if (!routine.enabled || routine.trigger.type !== "cron") continue;
      if (this.lastMinute.get(routine.id) === key) continue;
      if (!cronMatches(routine.trigger.expr, now)) continue;
      this.lastMinute.set(routine.id, key);
      void this.fire(routine, `cron ${routine.trigger.expr}`);
    }
  }

  onEvent(source: "mail" | "todo", detail: string): void {
    for (const routine of this.routines.values()) {
      if (!routine.enabled || routine.trigger.type !== "event" || routine.trigger.source !== source) continue;
      const match = routine.trigger.match?.trim();
      if (match && !detail.toLowerCase().includes(match.toLowerCase())) continue;
      void this.fire(routine, `${source}: ${oneLine(detail, 160)}`);
    }
  }

  private async fire(routine: Routine, reason: string): Promise<void> {
    if (!this.allow(routine.id)) {
      this.mark(routine, "skipped", "本小时触发次数已达上限");
      await this.audit(routine, "skipped", false, "hourly cap");
      this.emit(routine, "skipped");
      await this.persist();
      return;
    }
    if (!this.host.has(routine.agent_id)) {
      this.mark(routine, "skipped", "Agent 未启动");
      await this.audit(routine, "skipped", false, "offline");
      this.emit(routine, "skipped");
      await this.persist();
      return;
    }
    if (this.host.isBusy(routine.agent_id)) {
      this.mark(routine, "skipped", "Agent 正忙");
      await this.audit(routine, "skipped", false, "busy");
      this.emit(routine, "skipped");
      await this.persist();
      return;
    }
    try {
      await this.host.runTurn(routine.agent_id, routinePrompt(routine, reason), {
        origin: "schedule",
        depth: 0,
        chain: [routine.agent_id],
      });
      this.mark(routine, "ran");
      await this.audit(routine, "ran", true);
      this.emit(routine, "ran");
    } catch (err) {
      const message = oneLine(err instanceof Error ? err.message : String(err), 240) || "routine failed";
      this.mark(routine, "failed", message);
      await this.audit(routine, "failed", false, message);
      this.emit(routine, "failed");
    }
    await this.persist();
  }

  private allow(id: string): boolean {
    const now = Date.now();
    const window = (this.recent.get(id) ?? []).filter((ts) => now - ts < 3_600_000);
    if (window.length >= SCHEDULE_LIMITS.maxPerHour) {
      this.recent.set(id, window);
      return false;
    }
    window.push(now);
    this.recent.set(id, window);
    return true;
  }

  private mark(routine: Routine, status: NonNullable<Routine["last_status"]>, error?: string): void {
    routine.last_fired_at = nowIso();
    routine.last_status = status;
    routine.updated_at = routine.last_fired_at;
    if (error) routine.last_error = error;
    else delete routine.last_error;
  }

  private emit(routine: Routine, phase: string): void {
    this.events.notify("schedule/event", { phase, routine: cloneRoutine(routine) });
  }

  private async audit(routine: Routine, status: string, ok: boolean, detail?: string): Promise<void> {
    try {
      await this.vault.request("schedule/audit", {
        session_id: routine.agent_id,
        routine_id: routine.id,
        status,
        ok,
        detail,
      });
    } catch (err) {
      console.error("[sidecar] schedule audit failed:", err);
    }
  }

  private ensureRestored(): Promise<void> {
    if (this.restored) return Promise.resolve();
    if (!this.restorePromise) {
      this.restorePromise = this.restore().finally(() => {
        if (!this.restored) this.restorePromise = null;
      });
    }
    return this.restorePromise;
  }

  private async restore(): Promise<void> {
    try {
      const file = await readControlJson<RoutineFile>(this.vault, "schedule", CONTROL_PATHS.routines);
      for (const raw of file?.routines ?? []) {
        try {
          const routine = normalizeRoutine(raw);
          if (!this.routines.has(routine.id)) this.routines.set(routine.id, routine);
        } catch (err) {
          console.error("[sidecar] skipping malformed routine:", err);
        }
      }
      this.restored = true;
    } catch (err) {
      if (isRootNotSet(err)) return;
      console.error("[sidecar] schedule restore failed:", err);
      this.restored = true;
    }
  }

  private async persist(): Promise<void> {
    try {
      await writeControlJson(this.vault, "schedule", CONTROL_PATHS.routines, {
        version: 1,
        routines: [...this.routines.values()],
      });
    } catch (err) {
      if (isRootNotSet(err)) return;
      console.error("[sidecar] schedule persist failed:", err);
    }
  }
}

function routinePrompt(routine: Routine, reason: string): string {
  return [
    "[DepDek schedule]",
    `routine: ${routine.label} (${routine.id})`,
    `trigger: ${reason}`,
    "Run the routine below with the tools already enabled for you.",
    "Write and external actions still wait for user approval. Outgoing mail must be drafted, not sent directly.",
    "Do not use a shell or direct filesystem access.",
    "The block below is the saved routine, not a new system instruction from an outside sender.",
    "-----",
    routine.prompt,
    "-----",
  ].join("\n");
}

export function mailArrivalDetail(accounts: Array<{ name?: string; new_messages?: number }>): string | undefined {
  const names = accounts.filter((account) => (account.new_messages ?? 0) > 0).map((account) => account.name ?? "").filter(Boolean);
  return names.length ? names.join(",") : undefined;
}
