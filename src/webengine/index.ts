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
let latestAddress: string | null = null;
let historyId = 0;
const historyWaiters = new Map<number, (json: string) => void>();

/** The engine's last reported state, or null before it has said anything. */
export function browserStatus(): BrowserSyncStatus | null {
  return latest;
}

/** Start (or restart) the engine for the active wallet. */
export async function startBrowserMode(seedHex: string, address: string, birthday: number): Promise<void> {
  latestAddress = address;
  await startBrowserEngine(seedHex, birthday, (s) => {
    latest = s;
  });
  worker!.addEventListener("message", (ev: MessageEvent<{ type: string; id: number; json: string }>) => {
    if (ev.data?.type === "history") {
      historyWaiters.get(ev.data.id)?.(ev.data.json);
      historyWaiters.delete(ev.data.id);
    }
  });
}

/** The engine's history in the wallet service's `/api/wallet/history` shape. */
export function browserHistory(limit: number, offset: number): Promise<string> {
  const w = worker;
  if (!w) return Promise.resolve(JSON.stringify({ recoverableHistory: true, total: 0, rows: [] }));
  const id = ++historyId;
  return new Promise((resolve) => {
    historyWaiters.set(id, resolve);
    w.postMessage({ type: "history", id, limit, offset });
    setTimeout(() => {
      if (historyWaiters.delete(id)) resolve(JSON.stringify({ recoverableHistory: true, total: 0, rows: [] }));
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
let starting = false;

/** How the engine finds the active wallet (registered by the app, which knows where seeds live). */
export function setBrowserWalletResolver(fn: () => Promise<BrowserWallet | null>): void {
  resolver = fn;
}

/** Start the engine if browser mode is on and nothing runs yet. Safe to call on every poll. */
export function ensureBrowserEngine(): void {
  if (!browserModeChosen() || worker || starting || !resolver) return;
  starting = true;
  void resolver()
    .then((w) => (w && w.seedHex ? startBrowserMode(w.seedHex, w.address, w.birthday) : undefined))
    .catch((e) => {
      latest = { phase: "error", scanned: 0, tip: 0, birthday: 0, balanceSompi: "0", notes: 0, verified: null, error: String(e) };
    })
    .finally(() => {
      starting = false;
    });
}

/** The engine's state as the wallet service's `/api/status` answer, so every screen reads it
 *  unchanged. Sending is reported as unavailable (`spend_ready: false`) until the browser can
 *  prove payments itself. */
export function browserStatusAsServiceStatus(): Record<string, unknown> {
  ensureBrowserEngine();
  const s = latest;
  const bal = s?.balanceSompi ?? "0";
  return {
    has_wallet: true,
    address: latestAddress,
    birthday: s?.birthday,
    network: "mainnet",
    node_connected: !!s && s.phase !== "error",
    daa_score: s?.tip ?? 0,
    synced: s?.phase === "synced",
    spend_ready: false,
    loading: !s || s.phase === "starting",
    scanned_blocks: s?.scanned ?? 0,
    chain_len: s?.tip ?? 0,
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
