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
  start(opts: { nodeAddr?: string; secret?: string; socks?: string }): Promise<{ port: number }>;
  stop(): Promise<void>;
  status(): Promise<{ port: number; running: boolean }>;
}

const Native = registerPlugin<EmbeddedEnginePlugin>("EmbeddedEngine");

const CHOICE_KEY = "wallet_service_embedded";
const NODE_KEY = "wallet_embedded_node";

/** The public ZKas node the on-device engine syncs from unless the user picks
 * their own. gRPC host:port. */
export const DEFAULT_EMBEDDED_NODE = "185.147.157.125:16110";

/** The node the on-device engine should sync from (the user's choice, or the
 * public default). */
export function embeddedNode(): string {
  try {
    return localStorage.getItem(NODE_KEY) || DEFAULT_EMBEDDED_NODE;
  } catch {
    return DEFAULT_EMBEDDED_NODE;
  }
}

/** Remember the node to sync from; clearing back to the default forgets it. */
/** Orbot's local SOCKS5 proxy — Tor on Android. */
export const ORBOT_SOCKS = "127.0.0.1:9050";
const TOR_KEY = "wallet_embedded_tor";

/** Should the on-device engine reach its node over Tor (Orbot)? */
export function embeddedTor(): boolean {
  try { return localStorage.getItem(TOR_KEY) === "1"; } catch { return false; }
}

export function setEmbeddedTor(on: boolean): void {
  try { if (on) localStorage.setItem(TOR_KEY, "1"); else localStorage.removeItem(TOR_KEY); } catch { /* ignore */ }
}

export function setEmbeddedNode(v: string): void {
  const a = (v || "").trim();
  try {
    if (a && a !== DEFAULT_EMBEDDED_NODE) localStorage.setItem(NODE_KEY, a);
    else localStorage.removeItem(NODE_KEY);
  } catch {
    /* ignore */
  }
}

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
export async function ensureEmbedded(nodeAddr?: string, tor?: boolean): Promise<string> {
  if (!embeddedAvailable()) throw new Error("The on-device engine is not available on this device.");
  const already = await Native.status().catch(() => ({ port: 0, running: false }));
  if (already.running && already.port > 0) return `http://127.0.0.1:${already.port}`;
  // Sync from the node the user chose (persisted), or the public default.
  const node = (nodeAddr && nodeAddr.trim()) || embeddedNode();
  setEmbeddedNode(node);
  const useTor = tor ?? embeddedTor();
  setEmbeddedTor(useTor);
  if (!startPromise) {
    startPromise = Native.start({ nodeAddr: node, socks: useTor ? ORBOT_SOCKS : undefined }).then((r) => r.port);
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
