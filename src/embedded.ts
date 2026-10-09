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

const BACKUP_KEY = "wallet_embedded_node_backup";
const ACTIVE_BACKUP_KEY = "wallet_embedded_node_using_backup";
const SEEDED_KEY = "wallet_embedded_nodes_seeded_v2";

/** Give this install a primary and a backup, once.
 *
 * Which node is primary is randomised per install. Sync is fetch-bound and every
 * sovereign wallet used to queue on one box; more importantly this is the option people
 * choose so that no server holds their keys, and pointing all of them at one node we
 * operate hands it every such user's IP and sync pattern. Spreading the default does not
 * fix that, but concentrating it makes it worse.
 *
 * An install that already has a node keeps it as its primary — including one that
 * earlier builds pinned without anyone choosing it, since `ensureEmbedded` used to
 * persist on every start. It only gains a backup it did not have.
 */
function seedNodes(): void {
  try {
    if (localStorage.getItem(SEEDED_KEY)) return;
    localStorage.setItem(SEEDED_KEY, "1");
    const existing = (localStorage.getItem(NODE_KEY) || "").trim();
    const shuffled = [...PUBLIC_EMBEDDED_NODES].sort(() => Math.random() - 0.5);
    const primary = existing || shuffled[0];
    const backup = PUBLIC_EMBEDDED_NODES.find((n) => n !== primary) ?? "";
    localStorage.setItem(NODE_KEY, primary);
    if (backup && !localStorage.getItem(BACKUP_KEY)) localStorage.setItem(BACKUP_KEY, backup);
  } catch {
    /* storage is a convenience here, never a requirement */
  }
}

/** The node to sync from: the primary, or the backup while failover has switched to it. */
export function embeddedNode(): string {
  try {
    seedNodes();
    const backup = (localStorage.getItem(BACKUP_KEY) || "").trim();
    if (localStorage.getItem(ACTIVE_BACKUP_KEY) === "1" && backup) return backup;
    return (localStorage.getItem(NODE_KEY) || "").trim() || DEFAULT_EMBEDDED_NODE;
  } catch {
    return DEFAULT_EMBEDDED_NODE;
  }
}

/** The primary, as configured — not necessarily the one in use right now. */
export function embeddedPrimaryNode(): string {
  try {
    seedNodes();
    return (localStorage.getItem(NODE_KEY) || "").trim() || DEFAULT_EMBEDDED_NODE;
  } catch {
    return DEFAULT_EMBEDDED_NODE;
  }
}

/** The backup, or "" when none is configured. Optional by design: one node is a valid
 * setup, it just cannot be failed away from. */
export function embeddedBackupNode(): string {
  try {
    seedNodes();
    return (localStorage.getItem(BACKUP_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setEmbeddedNode(v: string): void {
  try {
    const a = (v || "").trim();
    if (a) localStorage.setItem(NODE_KEY, a);
    else localStorage.removeItem(NODE_KEY);
    // Editing the primary means going back to it; otherwise a wallet left on the backup
    // would ignore the address the user just typed.
    localStorage.removeItem(ACTIVE_BACKUP_KEY);
  } catch {
    /* ignore */
  }
}

export function setEmbeddedBackupNode(v: string): void {
  try {
    const a = (v || "").trim();
    if (a) localStorage.setItem(BACKUP_KEY, a);
    else {
      localStorage.removeItem(BACKUP_KEY);
      localStorage.removeItem(ACTIVE_BACKUP_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** True while sync is running on the backup rather than the primary. */
export function embeddedUsingBackup(): boolean {
  try {
    return localStorage.getItem(ACTIVE_BACKUP_KEY) === "1" && !!embeddedBackupNode();
  } catch {
    return false;
  }
}

/** Switch between primary and backup after sustained failure, and report the new
 * address. Null when there is no backup to switch to — one node is a valid setup, it
 * just cannot be failed away from, and saying so beats pretending to retry. */
export function rotatePublicNode(): string | null {
  const backup = embeddedBackupNode();
  if (!backup) return null;
  try {
    const onBackup = localStorage.getItem(ACTIVE_BACKUP_KEY) === "1";
    if (onBackup) localStorage.removeItem(ACTIVE_BACKUP_KEY);
    else localStorage.setItem(ACTIVE_BACKUP_KEY, "1");
    return embeddedNode();
  } catch {
    return null;
  }
}

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
    else {
      localStorage.removeItem(CHOICE_KEY);
      // Leaving phone mode also leaves Tor. The flag was written in exactly one
      // place — `ensureEmbedded` — and cleared in none, so every exit from phone
      // mode left it set. `privacyMode()` reads it, so the app then believed it
      // was in "tor-only" while `defaultBase()` had fallen back to the clearnet
      // hosted daemon: it disabled the explorer, the price and chat "because Tor
      // is on" and simultaneously POSTed the full viewing key over the clearnet
      // from the real IP. Clearing it here rather than at the five call sites so
      // that no future exit path can forget.
      localStorage.removeItem(TOR_KEY);
    }
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
/// What the RUNNING engine was actually started with.
///
/// `changed` used to be computed against localStorage, which the caller had
/// already written — `rotatePublicNode()` flips the active-node flag and returns
/// the NEW address, so `node !== embeddedNode()` was comparing a value with
/// itself and was always false. Failover therefore early-returned the live port
/// every time and the engine never left the dead node, while the UI switched to
/// "on the backup now" and the offline card promised it would reconnect on its
/// own. Comparing against what we actually started is the only honest test.
let startedWith: { node: string; tor: boolean } | null = null;

export async function ensureEmbedded(nodeAddr?: string, tor?: boolean, pin = true): Promise<string> {
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
  const changed = startedWith ? node !== startedWith.node || useTor !== startedWith.tor : false;
  const already = await Native.status().catch(() => ({ port: 0, running: false }));
  if (already.running && already.port > 0 && !changed) return `http://127.0.0.1:${already.port}`;
  if (already.running && changed) {
    await stopEmbedded().catch(() => {});
    startPromise = null;
  }
  // `pin: false` is failover asking for a different node for now. Pinning there
  // overwrote the PRIMARY with the backup and cleared the active-backup flag, so
  // both slots became the same address and failover was permanently dead with the
  // original primary forgotten.
  if (explicit && pin) setEmbeddedNode(node);
  // The Tor flag is persisted only once the engine is actually UP. Writing it
  // first bricked the wallet: if the start failed — Orbot not installed, which
  // is the common case for someone trying the option for the first time — the
  // flag survived while the app stayed on the clearnet hosted daemon. That is
  // privacyMode() === "tor-only" pointed at a clearnet base, so every wallet
  // call was refused, the price froze, chat reported blocked, and Explore said
  // "hidden on Tor". Nothing in Settings cleared it: the Public service row was
  // already the active choice, so tapping it did nothing, and only a SUCCESSFUL
  // phone-mode start or onion connect ever rewrote the flag. The wallet could
  // not be recovered from inside the app.
  if (!startPromise) {
    startPromise = Native.start({ nodeAddr: node, socks: useTor ? ORBOT_SOCKS : undefined }).then((r) => r.port);
  }
  try {
    const port = await startPromise;
    if (!port) throw new Error("engine returned no port");
    setEmbeddedTor(useTor);
    startedWith = { node, tor: useTor };
    void setEngineDebugLogs(embeddedDebugChosen());
    return `http://127.0.0.1:${port}`;
  } finally {
    startPromise = null;
  }
}

export async function stopEmbedded(): Promise<void> {
  if (!embeddedAvailable()) return;
  await Native.stop().catch(() => {});
  // A start that is still in flight belongs to the engine we just stopped; leaving
  // it set let the next ensureEmbedded await a cancelled start and adopt a dead
  // port. The node-change path already did this; the public stop did not.
  startPromise = null;
  startedWith = null;
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
