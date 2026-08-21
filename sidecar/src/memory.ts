/**
 * Memory RPC bridge.
 *
 * Tauri sends memory/* requests to the sidecar so the frontend uses the same
 * transport as agents. The Rust side remains the trust boundary and owns the
 * actual JSONL store; this bridge simply forwards the request in the opposite
 * direction over the existing bidirectional JSON-RPC pipe.
 */

import type { RpcPeer } from "./rpc.js";

const METHODS = [
  "memory/query",
  "memory/get",
  "memory/propose",
  "memory/confirm",
  "memory/reject",
  "memory/tombstone",
  "memory/stats",
  "memory/rebuild_index",
] as const;

export function registerMemoryHandlers(peer: RpcPeer): void {
  for (const method of METHODS) {
    peer.register(method, (params) => peer.request(method, params));
  }
}
