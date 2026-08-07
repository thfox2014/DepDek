/**
 * NDJSON stdio JSON-RPC 2.0 bidirectional layer.
 *
 * Each message is a single line of JSON. The peer is both client and server:
 * - client side: pending map keyed by request id (ids start at 100000 to
 *   avoid collision with the Rust side, per contract section 2)
 * - server side: a method registry for incoming requests and notifications
 *
 * Nothing but protocol lines may be written to stdout; logging goes to stderr.
 */

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

type RequestMessage = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type NotificationMessage = { jsonrpc: "2.0"; method: string; params?: unknown };
type ResponseMessage =
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: JsonRpcErrorObject };

export type WireMessage = RequestMessage | NotificationMessage | ResponseMessage;

export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INTERNAL = -32603;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

type Handler = (params: any) => unknown | Promise<unknown>;

export interface RpcTransport {
  /** Called with each complete line the peer should send. */
  write: (line: string) => void;
}

let nextId = 100000;

export class RpcPeer {
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly handlers = new Map<string, Handler>();
  private readonly notificationHandlers = new Map<string, Handler>();
  private buffer = "";

  constructor(private readonly transport: RpcTransport) {}

  /** Register a handler for incoming requests of the given method. */
  register(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  /** Register a handler for incoming notifications of the given method. */
  onNotification(method: string, handler: Handler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a request and await its response. Ids start at 100000. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    const message: RequestMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.send(message);
    });
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    const message: NotificationMessage = { jsonrpc: "2.0", method, params };
    this.send(message);
  }

  /**
   * Feed raw incoming data (may contain partial or multiple lines).
   * Fully parsed messages are dispatched asynchronously.
   */
  feed(chunk: string | Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
    }
  }

  /** Reject all pending requests (e.g. when the transport dies). */
  dispose(reason: Error): void {
    for (const [, entry] of this.pending) entry.reject(reason);
    this.pending.clear();
  }

  private send(message: WireMessage): void {
    this.transport.write(JSON.stringify(message) + "\n");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: WireMessage;
    try {
      message = JSON.parse(trimmed) as WireMessage;
    } catch {
      // Unparseable input is dropped; the protocol has no good error target.
      console.error(`[sidecar] dropping malformed JSON-RPC line: ${trimmed.slice(0, 200)}`);
      return;
    }
    void this.dispatch(message);
  }

  private async dispatch(message: WireMessage): Promise<void> {
    // Response (has id, no method).
    if ("id" in message && !("method" in message)) {
      const entry = this.pending.get(message.id);
      if (entry) {
        this.pending.delete(message.id);
        if ("error" in message) {
          entry.reject(new RpcError(message.error.code, message.error.message, message.error.data));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }

    if (!("method" in message)) return;

    // Notification (has method, no id).
    if (!("id" in message)) {
      const handler = this.notificationHandlers.get(message.method);
      if (handler) {
        try {
          await handler(message.params);
        } catch (err) {
          console.error(`[sidecar] notification handler ${message.method} failed:`, err);
        }
      }
      return;
    }

    // Request (has method and id).
    const id = message.id;
    const handler = this.handlers.get(message.method);
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: ERR_METHOD_NOT_FOUND, message: `unknown method: ${message.method}` },
      });
      return;
    }
    try {
      const result = (await handler(message.params)) ?? {};
      this.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const error: JsonRpcErrorObject =
        err instanceof RpcError
          ? { code: err.code, message: err.message, data: err.data }
          : { code: ERR_INTERNAL, message: err instanceof Error ? err.message : String(err) };
      this.send({ jsonrpc: "2.0", id, error });
    }
  }
}

/** Connect an RpcPeer to process stdin/stdout. */
export function createStdioPeer(): RpcPeer {
  const peer = new RpcPeer({
    write: (line) => {
      process.stdout.write(line);
    },
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => peer.feed(chunk));
  process.stdin.on("end", () => peer.dispose(new Error("stdin closed")));
  process.stdin.on("error", (err) => peer.dispose(err as Error));
  return peer;
}
