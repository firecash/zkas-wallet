// The browser wallet engine, off the main thread. Started with the wallet's viewing key (derived
// on the page from the seed it holds); posts status as it syncs. Nothing here sends a key, an
// address or wallet state anywhere: it only downloads public chain data.
import init, { Engine, segment_matches, verify_manifest } from "./pkg/zkas_web_engine.js";
import wasmUrl from "./pkg/zkas_web_engine_bg.wasm?url";
import { runSync, type BrowserSyncStatus } from "./sync";
import { deleteCheckpoint, loadCheckpoint, saveCheckpoint } from "./store";

export interface StartMessage {
  type: "start";
  id: string;
  fvkHex: string;
  birthday: number;
  files: string[];
  gateway: string;
}

let stopped = false;
let ready: Promise<unknown> | null = null;
let live: { history?(limit: number, offset: number): string } | null = null;

const post = (status: BrowserSyncStatus) => (self as unknown as Worker).postMessage({ type: "status", status });

self.onmessage = async (ev: MessageEvent<StartMessage | { type: "stop" } | { type: "history"; id: number; limit: number; offset: number }>) => {
  const msg = ev.data;
  if (msg.type === "stop") {
    stopped = true;
    return;
  }
  if (msg.type === "history") {
    let json = JSON.stringify({ recoverableHistory: true, total: 0, rows: [] });
    try {
      if (live?.history) json = live.history(msg.limit, msg.offset);
    } catch {
      /* the empty answer stands */
    }
    (self as unknown as Worker).postMessage({ type: "history", id: msg.id, json });
    return;
  }
  stopped = false;
  ready ??= init({ module_or_path: wasmUrl });
  await ready;
  try {
    await runSync({
      fetch: (u) => fetch(u),
      verifyManifest: verify_manifest,
      segmentMatches: segment_matches,
      create: (boundary, birthday) => new Engine(msg.fvkHex, boundary, birthday),
      restore: (bytes) => Engine.restore(msg.fvkHex, bytes),
      load: () => loadCheckpoint(msg.id),
      save: (b) => saveCheckpoint(msg.id, b),
      files: msg.files,
      gateway: msg.gateway,
      birthday: msg.birthday,
      onStatus: post,
      onEngine: (e) => {
        live = e;
      },
      shouldStop: () => stopped,
    });
  } catch (e) {
    // A tree that disagrees with the node is never kept: the next start rebuilds from the
    // birthday. Any other failure keeps the checkpoint and is reported for a retry.
    if (String(e).includes("tree differs")) await deleteCheckpoint(msg.id);
    post({ phase: "error", scanned: 0, tip: 0, birthday: msg.birthday, balanceSompi: "0", notes: 0, verified: null, error: String(e) });
  }
};
