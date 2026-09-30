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
import i18n from "./i18n";

interface EmbeddedEnginePlugin {
  start(opts: { nodeAddr?: string; secret?: string; socks?: string }): Promise<{ port: number }>;
  stop(): Promise<void>;
  status(): Promise<{ port: number; running: boolean }>;
  logs(): Promise<{ text: string }>;
  setDebugLogs(opts: { on: boolean }): Promise<void>;
  keepAlive(opts: { on: boolean }): Promise<void>;
}

const Native = registerPlugin<EmbeddedEnginePlugin>("EmbeddedEngine");

const CHOICE_KEY = "wallet_service_embedded";
const NODE_KEY = "wallet_embedded_node";

/** The public ZKas nodes the on-device engine can sync from, unless the user picks
 * their own. gRPC host:port.
 *
 * There is more than one for two reasons, and the smaller one is load. Sync is
 * overwhelmingly fetch-bound — measured at 94-99% of sync time, seconds per page — and
 * a single hardcoded address meant every sovereign wallet in the world queued on one
 * box that also runs the pool, the explorer and a wallet daemon.
 *
 * The larger reason is that this is the option people choose so that no server holds
 * their keys. Pointing all of them at one node we operate hands that node every such
 * user's IP and sync pattern — the record the chain exists to prevent. Spreading the
 * default across nodes does not fix that, but concentrating it makes it worse. */
export const PUBLIC_EMBEDDED_NODES = ["185.147.157.125:16110", "160.187.211.153:16110"] as const;

/** Kept as the named default for display and for anything that wants one address. */
export const DEFAULT_EMBEDDED_NODE = PUBLIC_EMBEDDED_NODES[0];

const PICKED_KEY = "wallet_embedded_node_picked";

/** Choose a public node for this install and remember it.
 *
 * Sticky rather than per-call: the engine is restarted on settings changes and on
 * resume, and a node that changed underneath it would discard warm page state and make
 * every restart a cold one. Sticky per install still spreads the fleet, which is what
 * the load and privacy arguments above actually need. */
function pickPublicNode(): string {
  try {
    const kept = localStorage.getItem(PICKED_KEY);
    if (kept && (PUBLIC_EMBEDDED_NODES as readonly string[]).includes(kept)) return kept;
    const chosen = PUBLIC_EMBEDDED_NODES[Math.floor(Math.random() * PUBLIC_EMBEDDED_NODES.length)];
    localStorage.setItem(PICKED_KEY, chosen);
    return chosen;
  } catch {
    return DEFAULT_EMBEDDED_NODE;
  }
}

/** The node the on-device engine should sync from (the user's choice, or the
 * public default). */
export function embeddedNode(): string {
  try {
    return localStorage.getItem(NODE_KEY) || pickPublicNode();
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

const DEBUG_KEY = "wallet_embedded_debug";
/** Verbose engine logging chosen in Settings. */
export function embeddedDebugChosen(): boolean {
  try { return localStorage.getItem(DEBUG_KEY) === "1"; } catch { return false; }
}
export function setEmbeddedDebug(on: boolean): void {
  try { if (on) localStorage.setItem(DEBUG_KEY, "1"); else localStorage.removeItem(DEBUG_KEY); } catch { /* ignore */ }
}

export function setEmbeddedNode(v: string): void {
  const a = (v || "").trim();
  try {
    // Store whatever was chosen, verbatim.
    //
    // This used to drop the value when it equalled DEFAULT_EMBEDDED_NODE, encoding
    // "same as the default" as "no preference". That was fine while there was one
    // public node and is wrong now that there are several: picking the first one
    // explicitly erased the key, the getter fell back to the automatic assignment, and
    // a user who deliberately chose that node could be handed the other one instead.
    // Absence means automatic; presence means the user picked, including when the pick
    // happens to match a default.
    if (a) localStorage.setItem(NODE_KEY, a);
    else localStorage.removeItem(NODE_KEY);
  } catch {
    /* ignore */
  }
}

/** Has the user pinned a node, or are we assigning one? Failover only ever moves an
 * automatic assignment — a node somebody typed on purpose is left alone, and its
 * failure is reported rather than worked around. */
export function embeddedNodeIsAutomatic(): boolean {
  try {
    return !localStorage.getItem(NODE_KEY);
  } catch {
    return true;
  }
}

/** Move the automatic assignment to the next public node.
 *
 * A second node is only an improvement if a dead one can be left behind: the pick is
 * sticky, so without this an install that happened to land on an unreachable node would
 * stay there forever. Returns the new address, or null when there is nothing to move to
 * (one node configured, or the user pinned their own). */
export function rotatePublicNode(): string | null {
  if (!embeddedNodeIsAutomatic() || PUBLIC_EMBEDDED_NODES.length < 2) return null;
  try {
    const cur = localStorage.getItem(PICKED_KEY);
    const i = PUBLIC_EMBEDDED_NODES.indexOf((cur ?? "") as (typeof PUBLIC_EMBEDDED_NODES)[number]);
    const next = PUBLIC_EMBEDDED_NODES[(i + 1 + PUBLIC_EMBEDDED_NODES.length) % PUBLIC_EMBEDDED_NODES.length];
    if (next === cur) return null;
    localStorage.setItem(PICKED_KEY, next);
    return next;
  } catch {
    return null;
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

// True while a heavy on-device operation (proving/signing/broadcasting a send, or a
// consolidation) is running. The engine is single-process, so it cannot answer the
// 1-second status poll while it is busy — those poll timeouts are NOT evidence it is
// down, and must not flip the app to "can't reach the wallet service" mid-send, nor
// trigger a self-heal restart that would kill the very send in flight.
let busy = false;
export function engineBusy(): boolean {
  return busy;
}
export function setEngineBusy(v: boolean): void {
  busy = v;
}

/** Start the engine (idempotent) and return its loopback base URL, e.g.
 * http://127.0.0.1:54123. Throws if the engine cannot start. */
export async function ensureEmbedded(nodeAddr?: string, tor?: boolean): Promise<string> {
  if (!embeddedAvailable()) throw new Error(i18n.t("embedded.unavailable"));
  // An address passed here is a CHOICE and gets pinned; nothing passed means "whichever
  // public node you assign me", which stays automatic so failover can move it later.
  // Collapsing the two (persisting on every start) would pin the assignment the first
  // time the engine ran and quietly disable the thing that leaves a dead node behind.
  const explicit = !!(nodeAddr && nodeAddr.trim());
  const node = explicit ? nodeAddr!.trim() : embeddedNode();
  const useTor = tor ?? embeddedTor();
  // Did the user change the node or the Tor toggle? start() is idempotent and would
  // otherwise keep the OLD transport, leaving e.g. a Tor-off switch stuck on a dead
  // SOCKS proxy (permanent "opening"). If so, stop the running engine and restart it.
  const changed = node !== embeddedNode() || useTor !== embeddedTor();
  const already = await Native.status().catch(() => ({ port: 0, running: false }));
  if (already.running && already.port > 0 && !changed) return `http://127.0.0.1:${already.port}`;
  if (already.running && changed) {
    await stopEmbedded().catch(() => {});
    startPromise = null;
  }
  if (explicit) setEmbeddedNode(node);
  setEmbeddedTor(useTor);
  if (!startPromise) {
    startPromise = Native.start({ nodeAddr: node, socks: useTor ? ORBOT_SOCKS : undefined }).then((r) => r.port);
  }
  try {
    const port = await startPromise;
    if (!port) throw new Error("engine returned no port");
    void setEngineDebugLogs(embeddedDebugChosen());
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

/** Recent on-device engine log lines (for the debug view in Settings). */
export async function engineLogs(): Promise<string> {
  if (!embeddedAvailable()) return "";
  const r = await Native.logs().catch(() => ({ text: "" }));
  return r.text || "";
}

/** Turn engine debug-level logging on or off. */
export async function setEngineDebugLogs(on: boolean): Promise<void> {
  if (!embeddedAvailable()) return;
  await Native.setDebugLogs({ on }).catch(() => {});
}

let keptAlive: boolean | null = null;
/** Hold the engine's foreground service while a sync is in progress, release it once
 * synced. Idempotent and cheap: only crosses the bridge when the state changes. */
export async function engineKeepAlive(on: boolean): Promise<void> {
  if (!embeddedAvailable() || !embeddedChosen()) return;
  if (keptAlive === on) return;
  keptAlive = on;
  await Native.keepAlive({ on }).catch(() => { keptAlive = null; });
}
