/**
 * Per-action approval cards.
 *
 * Write and external tool calls wait here before any vault mutation or
 * network call. Outgoing agent mail is a draft until the user approves the
 * card; only then does this module call the existing SMTP sender. Tokens and
 * passwords are stripped from the card preview. Decisions are appended to the
 * Rust audit log via `approval/audit`.
 */

import { randomBytes } from "node:crypto";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  CONTROL_PATHS,
  isRootNotSet,
  oneLine,
  readControlJson,
  redactPreview,
  writeControlJson,
} from "./control.js";
import { sendMail, type MailSendResult } from "./mail.js";
import { RpcError } from "./rpc.js";
import type { ActionApproval, VaultClient } from "./tools.js";

export const ERR_APPROVAL_NOT_FOUND = -32014;

export const APPROVAL_LIMITS = {
  maxPending: 32,
  timeoutMs: 10 * 60 * 1000,
  maxDrafts: 50,
  maxBodyChars: 100_000,
} as const;

export type ApprovalKind = "write" | "external" | "email";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalCard {
  id: string;
  session_id: string;
  kind: ApprovalKind;
  tool: string;
  title: string;
  summary: string;
  preview: Record<string, unknown>;
  status: ApprovalStatus;
  created_at: string;
  decided_at?: string;
}

export interface EmailDraft {
  id: string;
  session_id: string;
  account: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text: string;
  status: "pending" | "sent" | "denied" | "expired" | "send_failed";
  message_id?: string;
  error?: string;
}

interface DraftFile {
  version: 1;
  drafts: EmailDraft[];
}

export interface ApprovalEvents {
  notify(method: string, params?: unknown): void;
}

type MailSender = (vault: VaultClient, input: {
  account: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text: string;
}) => Promise<MailSendResult>;

function newApprovalId(): string {
  return `apr_${randomBytes(6).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneCard(card: ApprovalCard): ApprovalCard {
  return { ...card, preview: { ...card.preview } };
}

export class ApprovalGate implements ActionApproval {
  private readonly cards = new Map<string, ApprovalCard>();
  private readonly waiters = new Map<string, (approved: boolean) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly send: MailSender;
  private readonly inflightSend = new Map<string, Promise<string>>();

  constructor(
    private readonly events: ApprovalEvents,
    private readonly vault: VaultClient,
    options: { timeoutMs?: number; send?: MailSender } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? APPROVAL_LIMITS.timeoutMs;
    this.send = options.send ?? sendMail;
    void this.restoreDrafts();
  }

  private readonly timeoutMs: number;

  list(): { cards: ApprovalCard[] } {
    const cards = [...this.cards.values()].map(cloneCard);
    cards.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { cards };
  }

  async request(input: {
    sessionId: string;
    kind: "write" | "external";
    tool: string;
    title: string;
    summary: string;
    preview: Record<string, unknown>;
  }): Promise<boolean> {
    const id = await this.openCard({
      sessionId: input.sessionId,
      kind: input.kind,
      tool: input.tool,
      title: input.title,
      summary: input.summary,
      preview: input.preview,
    });
    if (!id) return false;
    return this.wait(id);
  }

  /**
   * Store an outgoing message and wait. SMTP runs only after approval.
   * A restarted sidecar has no waiter; deciding the restored card sends it.
   */
  async requestEmail(sessionId: string, draft: Omit<EmailDraft, "id" | "status" | "session_id">): Promise<{ approved: boolean; id: string; messageId?: string; error?: string }> {
    const pending = [...this.cards.values()].filter((card) => card.status === "pending");
    if (pending.length >= APPROVAL_LIMITS.maxPending) {
      await this.audit(sessionId, newApprovalId(), "email", "denied", false, "approval queue full");
      return { approved: false, id: "", error: "审批队列已满，邮件未发送。" };
    }
    const id = newApprovalId();
    await this.saveDraft({ ...draft, id, session_id: sessionId, status: "pending" });
    this.placeCard({
      id,
      sessionId,
      kind: "email",
      tool: "draft_email",
      title: "发送邮件",
      summary: `发给 ${oneLine(draft.to, 80)}：${oneLine(draft.subject || "(无主题)", 80)}`,
      preview: {
        account: draft.account,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        text: draft.text,
      },
    });
    const approved = await this.wait(id);
    if (!approved) return { approved: false, id };
    try {
      const messageId = await this.sendStoredDraft(id);
      return { approved: true, id, messageId };
    } catch (err) {
      const error = oneLine(err instanceof Error ? err.message : String(err), 240);
      return { approved: true, id, error };
    }
  }

  async decide(id: string, decision: string): Promise<{ card: ApprovalCard }> {
    if (decision !== "approve" && decision !== "deny") {
      throw new RpcError(-32602, "decision must be approve or deny");
    }
    const card = this.cards.get(id);
    if (!card) throw new RpcError(ERR_APPROVAL_NOT_FOUND, `unknown approval: ${id}`);
    const hadWaiter = this.waiters.has(id);
    if (card.status === "pending") {
      await this.finish(id, decision === "approve" ? "approved" : "denied");
    }
    if (!hadWaiter && decision === "approve" && card.kind === "email") {
      try {
        await this.sendStoredDraft(id);
      } catch (err) {
        card.summary = `发送失败：${oneLine(err instanceof Error ? err.message : String(err), 180)}`;
        this.emit(card);
      }
    }
    const current = this.cards.get(id);
    if (!current) throw new RpcError(ERR_APPROVAL_NOT_FOUND, `unknown approval: ${id}`);
    return { card: cloneCard(current) };
  }

  private async openCard(input: {
    sessionId: string;
    kind: ApprovalKind;
    tool: string;
    title: string;
    summary: string;
    preview: Record<string, unknown>;
  }): Promise<string | undefined> {
    const pending = [...this.cards.values()].filter((card) => card.status === "pending");
    if (pending.length >= APPROVAL_LIMITS.maxPending) {
      const id = newApprovalId();
      await this.audit(input.sessionId, id, input.kind, "denied", false, "approval queue full");
      return undefined;
    }
    const id = newApprovalId();
    this.placeCard({ ...input, id });
    return id;
  }

  private placeCard(input: {
    id: string;
    sessionId: string;
    kind: ApprovalKind;
    tool: string;
    title: string;
    summary: string;
    preview: Record<string, unknown>;
  }): void {
    const card: ApprovalCard = {
      id: input.id,
      session_id: input.sessionId,
      kind: input.kind,
      tool: input.tool,
      title: oneLine(input.title, 80),
      summary: oneLine(input.summary, 240),
      preview: (redactPreview(input.preview) as Record<string, unknown>) ?? {},
      status: "pending",
      created_at: nowIso(),
    };
    this.cards.set(card.id, card);
    this.emit(card);
    void this.audit(card.session_id, card.id, card.kind, "pending", true);
  }

  private wait(id: string): Promise<boolean> {
    const card = this.cards.get(id);
    if (!card) return Promise.resolve(false);
    if (card.status !== "pending") return Promise.resolve(card.status === "approved");
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      const timer = setTimeout(() => {
        void this.finish(id, "expired");
      }, this.timeoutMs);
      timer.unref?.();
      this.timers.set(id, timer);
    });
  }

  private async finish(id: string, status: "approved" | "denied" | "expired"): Promise<void> {
    const card = this.cards.get(id);
    if (!card || card.status !== "pending") return;
    card.status = status;
    card.decided_at = nowIso();
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    if (card.kind === "email" && status !== "approved") {
      await this.markDraft(id, status === "denied" ? "denied" : "expired");
    }
    this.emit(card);
    await this.audit(card.session_id, card.id, card.kind, status, status === "approved");
    waiter?.(status === "approved");
  }

  private sendStoredDraft(id: string): Promise<string> {
    const existing = this.inflightSend.get(id);
    if (existing) return existing;
    const promise = this.sendStoredDraftOnce(id).catch((err) => {
      this.inflightSend.delete(id);
      throw err;
    });
    this.inflightSend.set(id, promise);
    return promise;
  }

  private async sendStoredDraftOnce(id: string): Promise<string> {
    const drafts = await this.readDrafts();
    const draft = drafts.find((item) => item.id === id);
    if (!draft) throw new Error("找不到待发送的草稿");
    if (draft.status === "sent" && draft.message_id) return draft.message_id;
    try {
      const result = await this.send(this.vault, {
        account: draft.account,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        text: draft.text,
      });
      draft.status = "sent";
      draft.message_id = result.message_id;
      delete draft.error;
      await this.writeDrafts(drafts);
      return result.message_id;
    } catch (err) {
      draft.status = "send_failed";
      draft.error = oneLine(err instanceof Error ? err.message : String(err), 240);
      await this.writeDrafts(drafts);
      throw err;
    }
  }

  private async saveDraft(draft: EmailDraft): Promise<void> {
    const drafts = await this.readDrafts();
    drafts.unshift(draft);
    await this.writeDrafts(drafts.slice(0, APPROVAL_LIMITS.maxDrafts));
  }

  private async markDraft(id: string, status: EmailDraft["status"]): Promise<void> {
    const drafts = await this.readDrafts();
    const draft = drafts.find((item) => item.id === id);
    if (!draft || draft.status === "sent") return;
    draft.status = status;
    await this.writeDrafts(drafts);
  }

  private async readDrafts(): Promise<EmailDraft[]> {
    try {
      const file = await readControlJson<DraftFile>(this.vault, "mail", CONTROL_PATHS.drafts);
      return Array.isArray(file?.drafts) ? file.drafts : [];
    } catch (err) {
      if (isRootNotSet(err)) return [];
      console.error("[sidecar] draft read failed:", err);
      return [];
    }
  }

  private async writeDrafts(drafts: EmailDraft[]): Promise<void> {
    try {
      await writeControlJson(this.vault, "mail", CONTROL_PATHS.drafts, { version: 1, drafts });
    } catch (err) {
      if (isRootNotSet(err)) return;
      console.error("[sidecar] draft write failed:", err);
    }
  }

  private async restoreDrafts(): Promise<void> {
    const drafts = await this.readDrafts();
    for (const draft of drafts) {
      if (draft.status !== "pending" || this.cards.has(draft.id)) continue;
      const card: ApprovalCard = {
        id: draft.id,
        session_id: draft.session_id,
        kind: "email",
        tool: "draft_email",
        title: "发送邮件",
        summary: `发给 ${oneLine(draft.to, 80)}：${oneLine(draft.subject || "(无主题)", 80)}`,
        preview: (redactPreview({
          account: draft.account,
          to: draft.to,
          cc: draft.cc,
          subject: draft.subject,
          text: draft.text,
        }) as Record<string, unknown>) ?? {},
        status: "pending",
        created_at: nowIso(),
      };
      this.cards.set(card.id, card);
      this.emit(card);
    }
  }

  private emit(card: ApprovalCard): void {
    this.events.notify("approval/event", { card: cloneCard(card) });
  }

  private async audit(sessionId: string, id: string, kind: ApprovalKind, decision: string, ok: boolean, detail?: string): Promise<void> {
    try {
      await this.vault.request("approval/audit", {
        session_id: sessionId,
        approval_id: id,
        kind,
        decision,
        ok,
        detail,
      });
    } catch (err) {
      console.error("[sidecar] approval audit failed:", err);
    }
  }
}

export function createDraftEmailTool(gate: ApprovalGate, sessionId: string): AgentTool<any> {
  return {
    name: "draft_email",
    label: "draft_email",
    description:
      "Prepare an outgoing email and wait for the user to approve it. " +
      "This tool does not contact SMTP until the user approves the card. " +
      "Do not tell the user the message was sent unless the tool result includes a message id.",
    parameters: Type.Object({
      account: Type.String({ description: "Mail account display name already configured by the user." }),
      to: Type.String({ description: "Recipient address." }),
      cc: Type.Optional(Type.String()),
      bcc: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String()),
      text: Type.String({ description: "Plain-text body." }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId: string, raw: unknown): Promise<AgentToolResult<any>> => {
      const args = raw as { account?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string };
      const account = String(args.account ?? "").trim();
      const to = String(args.to ?? "").trim();
      const text = String(args.text ?? "");
      if (!account || !to || !text.trim()) {
        return { content: [{ type: "text", text: "草稿需要账号、收件人和正文。" }], details: { blocked: true } };
      }
      if (text.length > APPROVAL_LIMITS.maxBodyChars) {
        return { content: [{ type: "text", text: "正文过长，邮件未创建。" }], details: { blocked: true } };
      }
      const result = await gate.requestEmail(sessionId, {
        account,
        to,
        cc: args.cc?.trim() || undefined,
        bcc: args.bcc?.trim() || undefined,
        subject: args.subject?.trim() || undefined,
        text,
      });
      if (!result.approved) {
        return {
          content: [{ type: "text", text: result.error || "用户没有批准，邮件没有发送。" }],
          details: { blocked: true, approval_id: result.id },
        };
      }
      if (result.error || !result.messageId) {
        return {
          content: [{ type: "text", text: `用户已批准，但发送失败：${result.error || "未知错误"}。邮件没有确认送出。` }],
          details: { approval_id: result.id, sent: false },
        };
      }
      return {
        content: [{ type: "text", text: `用户已批准并发送。message id: ${result.messageId}` }],
        details: { approval_id: result.id, sent: true, message_id: result.messageId },
      };
    },
  };
}
