import { describe, expect, it } from "vitest";
import { registerMemoryHandlers } from "../src/memory.js";
import { RpcPeer } from "../src/rpc.js";

function createPeerPair(): [RpcPeer, RpcPeer] {
  let a: RpcPeer;
  let b: RpcPeer;
  a = new RpcPeer({ write: (line) => b.feed(line) });
  b = new RpcPeer({ write: (line) => a.feed(line) });
  return [a, b];
}

describe("memory RPC bridge", () => {
  it("forwards memory requests to the Rust-side peer", async () => {
    const [sidecar, rust] = createPeerPair();
    registerMemoryHandlers(sidecar);
    rust.register("memory/query", (params) => ({ params, items: [{ id: "m1", status: "confirmed" }] }));

    await expect(sidecar.request("memory/query", { scopes: ["team"], limit: 5 })).resolves.toEqual({
      params: { scopes: ["team"], limit: 5 },
      items: [{ id: "m1", status: "confirmed" }],
    });
  });
});
