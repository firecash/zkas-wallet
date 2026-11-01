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
interface LiveEngine {
  history?(limit: number, offset: number): string;
  prepare_send?(skHex: string, to: string, amount: bigint, memo: string): string;
  mark_sent?(positionsJson: string, txidHex: string, outflow: bigint): void;
  checkpoint(): Uint8Array;
}
let live: LiveEngine | null = null;
let current: StartMessage | null = null;

interface SendMessage {
  type: "send";
  id: number;
  skHex: string;
  to: string;
  amountSompi: string;
  memo: string;
}

/** Prove, submit, park. The spending key arrives with this one message and is not kept. */
async function send(msg: SendMessage): Promise<{ txid: string; feeSompi: number } | { error: string }> {
  const eng = live;
  if (!eng?.prepare_send || !eng.mark_sent || !current) return { error: "The wallet is still starting in this browser; try again in a moment." };
  let prepared: { bundle_hex: string; positions: number[]; fee: number; outflow: number };
  try {
    prepared = JSON.parse(eng.prepare_send(msg.skHex, msg.to, BigInt(msg.amountSompi), msg.memo));
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
  const bytes = new Uint8Array(prepared.bundle_hex.match(/../g)!.map((h) => parseInt(h, 16)));
  let r: Response;
  try {
    r = await fetch(`${current.gateway}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
  } catch {
    return { error: "The payment could not reach the network. Nothing was sent; try again." };
  }
  if (!r.ok) return { error: (await r.text().catch(() => "")) || `The network refused the payment (${r.status}). Nothing was sent.` };
  const { txid } = (await r.json()) as { txid: string };
  // Parked, not deleted: the notes leave the balance now and come back on their own if the
  // payment is never mined. Saved at once, so a reload cannot offer the same notes again.
  eng.mark_sent(JSON.stringify(prepared.positions), txid, BigInt(prepared.outflow));
  await saveCheckpoint(current.id, eng.checkpoint()).catch(() => false);
  return { txid, feeSompi: prepared.fee };
}

const post = (status: BrowserSyncStatus) => (self as unknown as Worker).postMessage({ type: "status", status });

self.onmessage = async (ev: MessageEvent<StartMessage | SendMessage | { type: "stop" } | { type: "history"; id: number; limit: number; offset: number }>) => {
  const msg = ev.data;
  if (msg.type === "stop") {
    stopped = true;
    return;
  }
  if (msg.type === "send") {
    const result = await send(msg);
    (self as unknown as Worker).postMessage({ type: "sent", id: msg.id, result });
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
  current = msg;
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
          live = e as unknown as LiveEngine;
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
