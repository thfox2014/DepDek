import { describe, expect, it } from "vitest";
import { RpcError, RpcPeer } from "../src/rpc.js";

/** Create a connected pair of peers over an in-memory NDJSON link. */
function createPeerPair(): [RpcPeer, RpcPeer] {
  let a: RpcPeer;
  let b: RpcPeer;
  a = new RpcPeer({ write: (line) => b.feed(line) });
  b = new RpcPeer({ write: (line) => a.feed(line) });
  return [a, b];
}

describe("RpcPeer", () => {
  it("resolves a request with the handler result", async () => {
    const [client, server] = createPeerPair();
    server.register("ping", (params) => ({ pong: params }));
    await expect(client.request("ping", { n: 1 })).resolves.toEqual({ pong: { n: 1 } });
  });

  it("supports requests in both directions", async () => {
    const [a, b] = createPeerPair();
    a.register("hello", () => "from-a");
    b.register("world", () => "from-b");
    await expect(b.request("hello")).resolves.toBe("from-a");
    await expect(a.request("world")).resolves.toBe("from-b");
  });

  it("uses request ids from the sidecar id space (>= 100000)", async () => {
    const lines: string[] = [];
    const peer = new RpcPeer({ write: (line) => lines.push(line) });
    const promise = peer.request("anything");
    const sent = JSON.parse(lines[0]!);
    expect(sent.id).toBeGreaterThanOrEqual(100000);
    peer.feed(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: {} }) + "\n");
    await expect(promise).resolves.toEqual({});
  });

  it("returns -32601 for unknown methods", async () => {
    const [client, server] = createPeerPair();
    server.register("known", () => ({}));
    const err = await client.request("nope").catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(-32601);
  });

  it("propagates RpcError code and message from handlers", async () => {
    const [client, server] = createPeerPair();
    server.register("fail", () => {
      throw new RpcError(-32001, "path escapes root");
    });
    const err = await client.request("fail").catch((e) => e);
    expect(err.code).toBe(-32001);
    expect(err.message).toBe("path escapes root");
  });

  it("maps unexpected handler exceptions to -32603", async () => {
    const [client, server] = createPeerPair();
    server.register("boom", () => {
      throw new Error("kaboom");
    });
    const err = await client.request("boom").catch((e) => e);
    expect(err.code).toBe(-32603);
    expect(err.message).toBe("kaboom");
  });

  it("delivers notifications without a response", async () => {
    const [a, b] = createPeerPair();
    const seen: unknown[] = [];
    b.onNotification("agent/event", (params) => {
      seen.push(params);
    });
    a.notify("agent/event", { session_id: "s1", type: "text_delta", data: { delta: "hi" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([{ session_id: "s1", type: "text_delta", data: { delta: "hi" } }]);
  });

  it("handles chunked and batched input", async () => {
    const [client, server] = createPeerPair();
    server.register("echo", (params) => params);
    // Feed the response in two chunks with another message on the same chunk.
    const promise = client.request("echo", { x: 1 });
    const half = JSON.stringify({ jsonrpc: "2.0", id: 100000, result: { x: 1 } });
    client.feed(half.slice(0, 10));
    client.feed(half.slice(10) + "\n" + JSON.stringify({ jsonrpc: "2.0", method: "ignored" }) + "\n");
    await expect(promise).resolves.toEqual({ x: 1 });
  });

  it("rejects pending requests on dispose", async () => {
    const peer = new RpcPeer({ write: () => {} });
    const promise = peer.request("never");
    peer.dispose(new Error("transport died"));
    await expect(promise).rejects.toThrow("transport died");
  });
});
