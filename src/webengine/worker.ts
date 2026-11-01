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
  // Run until stopped. A failed run — a mirror or the gateway unreachable for a moment, the
  // gateway answering "busy" — is retried with backoff and resumes from the saved checkpoint; it
  // used to end syncing for the whole session. The last good numbers stay on screen meanwhile:
  // an error report with a zero balance read as "your money is gone".
  let last: BrowserSyncStatus | null = null;
  let backoff = 2_000;
  while (!stopped) {
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
        onStatus: (st) => {
          last = st;
          backoff = 2_000;
          post(st);
        },
        onEngine: (e) => {
          live = e;
        },
        shouldStop: () => stopped,
      });
      return; // only a stop ends a run cleanly
    } catch (e) {
      // A tree that disagrees with the node is never kept: the retry rebuilds from the birthday.
      if (String(e).includes("tree differs")) await deleteCheckpoint(msg.id);
      const prev: BrowserSyncStatus = last ?? { phase: "starting", scanned: 0, tip: 0, birthday: msg.birthday, balanceSompi: "0", notes: 0, verified: null };
      post({ ...prev, phase: "error", error: String(e) });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
};
