// "Run in this browser": the wallet engine inside the page. The viewing key is derived here from
// the seed this browser already holds and handed only to the in-page worker — no wallet service
// ever receives it. Public chain data comes from ZKas's chain files (Cloudflare CDN, then
// zkas.info) and the chain gateway, which see this browser's IP, as a node does.
import { fvkHex } from "../signer";
import { clearnetAllowed } from "../lib/privacy";
import { walletIdFor } from "./store";
import type { BrowserSyncStatus } from "./sync";

export type { BrowserSyncStatus } from "./sync";

/** Where the engine reads public chain data. On wallet.zkas.info both are served from the page's
 *  own origin (proxied there to zkas.info), so the site's strict CSP needs no new source; any
 *  other origin (development, a self-hosted copy) reads zkas.info directly. */
export function browserSources(origin: string = globalThis.location?.origin ?? ""): { files: string[]; gateway: string } {
  if (/^https:\/\/wallet\.zkas\.info$/.test(origin)) {
    return { files: [`${origin}/shielded-chain`], gateway: `${origin}/chain-gateway` };
  }
  return { files: ["https://zkas.info/shielded-chain"], gateway: "https://zkas.info/chain-gateway" };
}

let worker: Worker | null = null;

/** Can this page run the engine? (Workers, WebAssembly, IndexedDB, and clearnet allowed.) */
export function browserEngineAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && typeof indexedDB !== "undefined" && clearnetAllowed();
}

/** Start syncing the wallet whose seed is `seedHex` from `birthday` (DAA). Restarts if running. */
export async function startBrowserEngine(seedHex: string, birthday: number, onStatus: (s: BrowserSyncStatus) => void): Promise<void> {
  // Tor-only and onion modes must not make clearnet requests: a normal browser cannot route these
  // fetches through Tor, so the mode is refused rather than quietly leaking the IP.
  if (!clearnetAllowed()) throw new Error("Run in this browser needs clearnet access; it is off in Tor mode.");
  stopBrowserEngine();
  const fvk = await fvkHex(seedHex);
  const id = await walletIdFor(fvk);
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (ev: MessageEvent<{ type: string; status: BrowserSyncStatus }>) => {
    if (ev.data?.type === "status") onStatus(ev.data.status);
  };
  const src = browserSources();
  w.postMessage({ type: "start", id, fvkHex: fvk, birthday, files: src.files, gateway: src.gateway });
  worker = w;
}

export function stopBrowserEngine(): void {
  if (!worker) return;
  worker.postMessage({ type: "stop" });
  worker.terminate();
  worker = null;
}

// ---------------------------------------------------------------------------------------------
// Browser mode: the app's wallet-service calls answered by the in-page engine.
// ---------------------------------------------------------------------------------------------

const MODE_KEY = "wallet_browser_engine";

/** Did the user choose "Run in this browser"? */
export function browserModeChosen(): boolean {
  try {
    return localStorage.getItem(MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBrowserModeChosen(on: boolean): void {
  try {
    if (on) localStorage.setItem(MODE_KEY, "1");
    else localStorage.removeItem(MODE_KEY);
  } catch {
    /* a session-only choice */
  }
}

let latest: BrowserSyncStatus | null = null;
/** The wallet the running engine syncs (by seed), so a switch of wallet restarts it. */
let running: { seedHex: string; address: string } | null = null;
let starting: Promise<void> | null = null;
let historyId = 0;
const historyWaiters = new Map<number, (json: string) => void>();

/** The engine's last reported state, or null before it has said anything. */
export function browserStatus(): BrowserSyncStatus | null {
  return latest;
}

function onWorkerMessage(ev: MessageEvent<{ type: string; id?: number; json?: string; status?: BrowserSyncStatus }>) {
  if (ev.data?.type === "history" && ev.data.id !== undefined) {
    historyWaiters.get(ev.data.id)?.(ev.data.json ?? "");
    historyWaiters.delete(ev.data.id);
  }
}

async function startFor(w: BrowserWallet): Promise<void> {
  latest = null;
  running = { seedHex: w.seedHex, address: w.address };
  await startBrowserEngine(w.seedHex, w.birthday, (st) => {
    latest = st;
  });
  worker?.addEventListener("message", onWorkerMessage);
}

function stopAll(): void {
  stopBrowserEngine();
  running = null;
  latest = null;
}

/** The engine's history in the wallet service's `/api/wallet/history` shape. */
export function browserHistory(limit: number, offset: number): Promise<string> {
  const empty = JSON.stringify({ recoverableHistory: true, total: 0, rows: [] });
  const w = worker;
  if (!w) return Promise.resolve(empty);
  const id = ++historyId;
  return new Promise((resolve) => {
    historyWaiters.set(id, resolve);
    w.postMessage({ type: "history", id, limit, offset });
    setTimeout(() => {
      if (historyWaiters.delete(id)) resolve(empty);
    }, 10_000);
  });
}

const fc = (sompi: string) => {
  const v = BigInt(sompi || "0");
  return `${v / 100_000_000n}.${(v % 100_000_000n).toString().padStart(8, "0")}`;
};

export interface BrowserWallet {
  seedHex: string;
  address: string;
  birthday: number;
}
let resolver: (() => Promise<BrowserWallet | null>) | null = null;

/** How the engine finds the active wallet (registered by the app, which knows where seeds live).
 *  Null when this browser holds no wallet yet. */
export function setBrowserWalletResolver(fn: () => Promise<BrowserWallet | null>): void {
  resolver = fn;
}

// The chain tip, for a browser that holds no wallet yet: creating one needs a birthday.
let tipCache: { at: number; tip: number } | null = null;
async function gatewayTip(): Promise<number> {
  if (tipCache && Date.now() - tipCache.at < 10_000) return tipCache.tip;
  try {
    const r = await fetch(`${browserSources().gateway}/tip`, { cache: "no-store" });
    const tip = Number((await r.json())?.virtual_daa_score) || 0;
    if (tip > 0) tipCache = { at: Date.now(), tip };
    return tip || (tipCache?.tip ?? 0);
  } catch {
    return tipCache?.tip ?? 0;
  }
}

const BIRTHDAY_KEY = (address: string) => `browser_birthday:${address}`;

/** Has this browser registered `address` (create, import, restore, or the app's re-register of
 *  an existing wallet)? The engine starts only then: the create flow stores the seed BEFORE it
 *  registers, and a status poll in that gap started the engine at birthday 0 — a genesis scan
 *  for a wallet born a minute ago, pinned there by its checkpoint (found end-to-end, 1 Nov). */
export function browserRegistered(address: string): boolean {
  try {
    return localStorage.getItem(BIRTHDAY_KEY(address)) !== null;
  } catch {
    return true; // storage refused: fall back to the app's own birthday record
  }
}

/** The birthday recorded when this browser registered `address` (0 when it did not). */
export function browserBirthday(address: string): number {
  try {
    return Number(localStorage.getItem(BIRTHDAY_KEY(address))) || 0;
  } catch {
    return 0;
  }
}

// The viewing key -> address, by the engine (lazily loaded on the page only in browser mode).
let addressFn: Promise<(fvk: string) => string> | null = null;
async function addressOfFvk(fvk: string): Promise<string> {
  addressFn ??= (async () => {
    const [m, u] = await Promise.all([import("./pkg/zkas_web_engine.js"), import("./pkg/zkas_web_engine_bg.wasm?url")]);
    await m.default({ module_or_path: u.default });
    return m.address_of_fvk;
  })();
  return (await addressFn)(fvk);
}

/** `POST /api/wallet/watch` in browser mode: nothing leaves the page. The address is derived
 *  here from the viewing key and the birthday recorded for the engine, which starts (or switches)
 *  on the next status poll once the app has stored the wallet's seed. */
export async function browserWatch(fvk: string, birthday: number): Promise<{ address: string }> {
  const address = await addressOfFvk(fvk.trim().toLowerCase());
  try {
    const had = browserBirthday(address);
    // The EARLIER birthday wins: re-registering with a later one must never skip history.
    const b = had > 0 && birthday > 0 ? Math.min(had, birthday) : had > 0 ? had : birthday;
    if (b > 0) localStorage.setItem(BIRTHDAY_KEY(address), String(b));
    else localStorage.setItem(BIRTHDAY_KEY(address), "0");
  } catch {
    /* the app's own birthday record is used instead */
  }
  return { address };
}

/** The engine's state as the wallet service's `/api/status` answer, so every screen reads it
 *  unchanged. Starts, switches or stops the engine to follow the wallet this browser holds now.
 *  Sending is reported unavailable (`spend_ready: false`) until the browser proves payments. */
export async function browserServiceStatus(): Promise<Record<string, unknown>> {
  const w = resolver ? await resolver().catch(() => null) : null;
  if (!w || !w.seedHex) {
    if (worker) stopAll();
    const tip = await gatewayTip();
    return {
      has_wallet: false,
      address: null,
      network: "mainnet",
      node_connected: tip > 0,
      daa_score: tip,
      synced: false,
      scanned_blocks: 0,
      chain_len: tip,
      balance_sompi: "0",
      balance_fc: "0.00000000",
      note_count: 0,
      updated_unix: Math.floor(Date.now() / 1000),
      error: null,
    };
  }
  if (!running || running.seedHex !== w.seedHex || !worker) {
    if (!starting) {
      starting = startFor(w)
        .catch((e) => {
          running = null;
          latest = { phase: "error", scanned: 0, tip: 0, birthday: w.birthday, balanceSompi: "0", notes: 0, verified: null, error: String(e) };
        })
        .finally(() => {
          starting = null;
        });
    }
    await starting;
  }
  const s = latest;
  const tip = s?.tip || (await gatewayTip());
  const bal = s?.balanceSompi ?? "0";
  return {
    has_wallet: true,
    address: w.address,
    birthday: w.birthday,
    network: "mainnet",
    node_connected: !!s && s.phase !== "error",
    daa_score: tip,
    synced: s?.phase === "synced",
    spend_ready: false,
    loading: !s || s.phase === "starting",
    scanned_blocks: s?.scanned || w.birthday,
    chain_len: tip,
    balance_sompi: bal,
    balance_fc: fc(bal),
    spendable_sompi: bal,
    spendable_fc: fc(bal),
    maturing_sompi: "0",
    maturing_fc: "0.00000000",
    pending_in_sompi: "0",
    pending_in_fc: "0.00000000",
    pending_out_sompi: "0",
    pending_out_fc: "0.00000000",
    note_count: s?.notes ?? 0,
    updated_unix: Math.floor(Date.now() / 1000),
    error: s?.phase === "error" ? (s.error ?? "error") : null,
    watch_only: false,
  };
}
