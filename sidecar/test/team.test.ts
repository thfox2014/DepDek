import { describe, expect, it, vi } from "vitest";
import { RpcError } from "../src/rpc.js";
import {
  ERR_TEAM_TASK_NOT_FOUND,
  TEAM_LIMITS,
  TeamOrchestrator,
  createTeamTools,
  type TeamRunResult,
  type TeamSessionHost,
  type TeamSessionInfo,
  type TurnContext,
} from "../src/team.js";
import type { VaultClient } from "../src/tools.js";

interface Harness {
  team: TeamOrchestrator;
  sessions: Map<string, TeamSessionInfo>;
  turns: Map<string, TurnContext>;
  busy: Set<string>;
  runs: Array<{ id: string; text: string; turn: TurnContext }>;
  audits: Array<Record<string, unknown>>;
  release: (id: string, result?: TeamRunResult | Error) => void;
  gate: (id: string) => void;
}

function makeHarness(ids: TeamSessionInfo[]): Harness {
  const sessions = new Map(ids.map((session) => [session.id, session]));
  const turns = new Map<string, TurnContext>();
  const busy = new Set<string>();
  const runs: Harness["runs"] = [];
  const audits: Array<Record<string, unknown>> = [];
  const pending = new Map<string, (result: TeamRunResult | Error) => void>();
  const gated = new Set<string>();

  const host: TeamSessionHost = {
    has: (id) => sessions.has(id),
    isBusy: (id) => busy.has(id),
    labelOf: (id) => sessions.get(id)?.label ?? id,
    setLabel: (id, label) => {
      const session = sessions.get(id);
      if (!session) return false;
      session.label = label;
      return true;
    },
    listSessions: () => [...sessions.values()].map((session) => ({ ...session })),
    currentTurn: (id) => {
      const turn = turns.get(id);
      return turn ? { ...turn, chain: [...turn.chain] } : undefined;
    },
    runTurn: (id, text, turn) => new Promise<TeamRunResult>((resolve, reject) => {
      runs.push({ id, text, turn });
      const finish = (result: TeamRunResult | Error) => {
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      if (gated.has(id)) pending.set(id, finish);
      else finish({ text: `done:${id}`, aborted: false });
    }),
    abortRun: (id) => {
      pending.get(id)?.({ text: "", aborted: true });
      pending.delete(id);
    },
  };
  const vault: VaultClient = {
    request: vi.fn(async (_method: string, params?: unknown) => {
      audits.push((params ?? {}) as Record<string, unknown>);
      return {};
    }),
  };
  const team = new TeamOrchestrator(host, { notify: () => undefined }, vault);
  return {
    team,
    sessions,
    turns,
    busy,
    runs,
    audits,
    release: (id, result = { text: `done:${id}`, aborted: false }) => {
      const finish = pending.get(id);
      pending.delete(id);
      finish?.(result);
    },
    gate: (id) => gated.add(id),
  };
}

async function settle(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > 2000) throw new Error("timed out waiting for team queue");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const photo = { id: "photo-manager", label: "照片管家", engine: "pi" };
const docs = { id: "doc-manager", label: "文档管家", engine: "pi" };
const music = { id: "music-player", label: "音乐助手", engine: "pi" };

describe("TeamOrchestrator", () => {
  it("delegates by display name, runs on the target, and reports back to the source", async () => {
    const harness = makeHarness([docs, photo]);
    const accepted = harness.team.delegate("doc-manager", "照片管家", "找出上周的照片");
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;
    await settle(() => harness.runs.length >= 2);
    const task = harness.team.list().tasks.find((item) => item.id === accepted.task.id);
    expect(task?.status).toBe("done");
    expect(task?.to_session_id).toBe("photo-manager");
    expect(task?.depth).toBe(1);
    expect(task?.result_preview).toContain("done:photo-manager");
    expect(harness.runs[0]?.id).toBe("photo-manager");
    expect(harness.runs[0]?.turn.origin).toBe("delegate");
    expect(harness.runs[1]?.id).toBe("doc-manager");
    expect(harness.runs[1]?.turn.origin).toBe("result");
    expect(harness.runs[1]?.text).toContain("不要再委托");
    expect(harness.audits.some((entry) => entry.status === "done" && entry.ok === true)).toBe(true);
    expect(harness.audits.every((entry) => entry.kind === "delegate")).toBe(true);
  });

  it("keeps a task queued until the target is free, and lets the caller continue", async () => {
    const harness = makeHarness([docs, photo]);
    harness.busy.add("photo-manager");
    const accepted = harness.team.delegate("doc-manager", "photo-manager", "稍后再做");
    expect(accepted.accepted).toBe(true);
    expect(harness.team.list().tasks[0]?.status).toBe("queued");
    expect(harness.runs).toHaveLength(0);
    harness.busy.delete("photo-manager");
    harness.team.notifyIdle("photo-manager");
    await settle(() => harness.team.list().tasks[0]?.status === "done");
  });

  it("cancels a queued task without starting it, and aborts a running one", async () => {
    const queued = makeHarness([docs, photo]);
    queued.busy.add("photo-manager");
    const waiting = queued.team.delegate("doc-manager", "照片管家", "先别做");
    if (!waiting.accepted) throw new Error("expected accept");
    const cancelled = queued.team.cancel(waiting.task.id).task;
    expect(cancelled.status).toBe("cancelled");
    expect(queued.runs.filter((run) => run.turn.origin === "delegate")).toHaveLength(0);

    const running = makeHarness([docs, photo]);
    running.gate("photo-manager");
    const started = running.team.delegate("doc-manager", "照片管家", "正在做");
    if (!started.accepted) throw new Error("expected accept");
    await settle(() => running.team.list().tasks.some((task) => task.status === "running"));
    running.team.cancel(started.task.id);
    await settle(() => running.team.list().tasks.some((task) => task.status === "cancelled"));
    expect(() => running.team.cancel("tsk_missing1")).toThrow(RpcError);
    try {
      running.team.cancel("tsk_missing1");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(ERR_TEAM_TASK_NOT_FOUND);
    }
  });

  it("rejects self, unknown, depth, cycles, result turns, and the per-source cap", () => {
    const harness = makeHarness([docs, photo, music]);
    expect(harness.team.delegate("doc-manager", "文档管家", "自己做").accepted).toBe(false);
    expect(harness.team.delegate("doc-manager", "不存在", "找一下").accepted).toBe(false);

    harness.turns.set("doc-manager", { origin: "delegate", depth: TEAM_LIMITS.maxDepth, chain: ["doc-manager"] });
    expect(harness.team.delegate("doc-manager", "照片管家", "太深了").accepted).toBe(false);

    harness.turns.set("photo-manager", { origin: "message", depth: 1, chain: ["doc-manager", "photo-manager"] });
    const loop = harness.team.message("photo-manager", "文档管家", "再问回去");
    expect(loop.accepted).toBe(false);
    if (!loop.accepted) expect(loop.message).toContain("循环");

    harness.turns.set("doc-manager", { origin: "result", depth: 1, chain: ["doc-manager", "photo-manager"] });
    const echoed = harness.team.delegate("doc-manager", "音乐助手", "再转一次");
    expect(echoed.accepted).toBe(false);

    harness.turns.clear();
    harness.busy.add("photo-manager");
    for (let i = 0; i < TEAM_LIMITS.maxOpenPerSource; i += 1) {
      const accepted = harness.team.delegate("doc-manager", "照片管家", `任务 ${i}`);
      expect(accepted.accepted).toBe(true);
    }
    expect(harness.team.delegate("doc-manager", "照片管家", "超额").accepted).toBe(false);
    const duplicate = harness.team.delegate("doc-manager", "照片管家", "任务 0");
    expect(duplicate.accepted && duplicate.duplicate).toBe(true);
    expect(harness.audits.some((entry) => entry.status === "rejected" && entry.ok === false)).toBe(true);
  });

  it("resolves ambiguous labels, renames through the roster, and drops work when a session closes", () => {
    const harness = makeHarness([
      docs,
      { id: "photo-a", label: "照片管家", engine: "pi" },
      { id: "photo-b", label: "照片管家", engine: "pi" },
    ]);
    const ambiguous = harness.team.delegate("doc-manager", "照片管家", "哪一个");
    expect(ambiguous.accepted).toBe(false);
    expect(harness.team.applyRoster([{ id: "photo-a", label: "旅行照片" }, { id: "missing", label: "幽灵" }])).toEqual({ updated: 1 });
    harness.busy.add("photo-a");
    const accepted = harness.team.delegate("doc-manager", "旅行照片", "只看旅行");
    expect(accepted.accepted).toBe(true);
    harness.team.onSessionClosed("photo-a");
    expect(harness.team.list().tasks[0]?.status).toBe("cancelled");
  });

  it("runs two targets at once and does not expose a shell", async () => {
    const harness = makeHarness([docs, photo, music]);
    harness.gate("photo-manager");
    harness.team.delegate("doc-manager", "photo-manager", "看照片");
    harness.team.message("doc-manager", "music-player", "下一首歌是什么");
    await settle(() => harness.runs.some((run) => run.id === "music-player" && run.turn.origin === "message"));
    expect(harness.team.list().tasks.some((task) => task.status === "running" && task.to_session_id === "photo-manager")).toBe(true);
    expect(harness.team.list().tasks.some((task) => task.kind === "message" && task.status === "done")).toBe(true);
    harness.release("photo-manager", { text: "", aborted: true });
    const names = createTeamTools(harness.team, "doc-manager").map((tool) => tool.name);
    expect(names).toEqual(["list_teammates", "delegate_task", "send_agent_message"]);
    expect(names.join(" ")).not.toMatch(/bash|shell|fs_|exec/);
    const listed = await createTeamTools(harness.team, "doc-manager")[0]?.execute("tc", {});
    expect(listed?.content[0]?.text).toContain("照片管家");
  });
});
