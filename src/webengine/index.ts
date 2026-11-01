// "Run in this browser": the wallet engine inside the page. The viewing key is derived here from
// the seed this browser already holds and handed only to the in-page worker — no wallet service
// ever receives it. Public chain data comes from ZKas's chain files (Cloudflare CDN, then
// zkas.info) and the chain gateway, which see this browser's IP, as a node does.
import { fvkHex } from "../signer";
import { clearnetAllowed } from "../lib/privacy";
import { walletIdFor } from "./store";
import type { BrowserSyncStatus } from "./sync";

export type { BrowserSyncStatus } from "./sync";

/** Chain-file mirrors, in order (the engine falls back from one to the next). */
export const BROWSER_CHAIN_FILES = ["https://pub-ae5ed92258b2437e985b69ab9947ef60.r2.dev", "https://zkas.info/shielded-chain"];
export const BROWSER_GATEWAY = "https://zkas.info/chain-gateway";

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
  w.postMessage({ type: "start", id, fvkHex: fvk, birthday, files: BROWSER_CHAIN_FILES, gateway: BROWSER_GATEWAY });
  worker = w;
}

export function stopBrowserEngine(): void {
  if (!worker) return;
  worker.postMessage({ type: "stop" });
  worker.terminate();
  worker = null;
}
