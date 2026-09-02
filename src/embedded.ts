// The on-device wallet engine for the native Android app.
//
// Runs zkas-walletd IN THIS APP (the EmbeddedEngine native plugin → the
// zkas-walletd-mobile Rust .so) bound to a loopback port, exactly as the Tauri
// desktop shell runs it. The SPA then talks to http://127.0.0.1:<port>. The seed
// and full viewing key never leave the phone; the engine pulls compact block
// records from a public node and trial-decrypts locally.
//
// This is the SOVEREIGN option. The hosted service stays available as the fast,
// zero-setup default; this is opt-in (first run + Settings → Wallet service).

import { registerPlugin } from "@capacitor/core";
import { isNative } from "./api";

interface EmbeddedEnginePlugin {
  start(opts: { nodeAddr?: string; secret?: string }): Promise<{ port: number }>;
  stop(): Promise<void>;
  status(): Promise<{ port: number; running: boolean }>;
}

const Native = registerPlugin<EmbeddedEnginePlugin>("EmbeddedEngine");

const CHOICE_KEY = "wallet_service_embedded";

/** Only the native Android shell carries the engine plugin. `isPluginAvailable`
 * returns FALSE for plugins registered in MainActivity (which is how this one and
 * BackgroundSync are wired), so gate on the platform exactly as bgSyncAvailable does. */
export function embeddedAvailable(): boolean {
  const cap = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return isNative() && cap?.getPlatform?.() === "android";
}

/** Has the user chosen to run the wallet on this phone? */
export function embeddedChosen(): boolean {
  try {
    return embeddedAvailable() && localStorage.getItem(CHOICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setEmbeddedChosen(on: boolean): void {
  try {
    if (on) localStorage.setItem(CHOICE_KEY, "1");
    else localStorage.removeItem(CHOICE_KEY);
  } catch {
    /* ignore */
  }
}

let startPromise: Promise<number> | null = null;

/** Start the engine (idempotent) and return its loopback base URL, e.g.
 * http://127.0.0.1:54123. Throws if the engine cannot start. */
export async function ensureEmbedded(nodeAddr?: string): Promise<string> {
  if (!embeddedAvailable()) throw new Error("The on-device engine is not available on this device.");
  const already = await Native.status().catch(() => ({ port: 0, running: false }));
  if (already.running && already.port > 0) return `http://127.0.0.1:${already.port}`;
  if (!startPromise) {
    startPromise = Native.start({ nodeAddr }).then((r) => r.port);
  }
  try {
    const port = await startPromise;
    if (!port) throw new Error("engine returned no port");
    return `http://127.0.0.1:${port}`;
  } finally {
    startPromise = null;
  }
}

export async function stopEmbedded(): Promise<void> {
  if (!embeddedAvailable()) return;
  await Native.stop().catch(() => {});
}

export async function embeddedBase(): Promise<string | null> {
  if (!embeddedChosen()) return null;
  const s = await Native.status().catch(() => ({ port: 0, running: false }));
  return s.running && s.port > 0 ? `http://127.0.0.1:${s.port}` : null;
}
