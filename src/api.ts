// Thin client for the zkas-walletd daemon.
//
// Default: the HOSTED daemon, reached same-origin at `<origin>/daemon` (nginx
// proxies it to 127.0.0.1:8501). This lets anyone use the wallet with just a
// browser — no node, no local install — connected to ZKas's public node.
// Each browser owns a random wallet token so wallets stay separate on the server.
//
// Self-hosted (fully non-custodial): override the daemon URL to your own local
// zkas-walletd (e.g. http://127.0.0.1:8501) — then the seed never leaves your
// machine.

function defaultBase(): string {
  // Native mobile (Capacitor) loads the bundle from the device, so there is no
  // same-origin server to proxy `/daemon` to — reach the hosted daemon directly.
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) return "https://wallet.zkas.info/daemon";
  // Same-origin hosted daemon in a normal web page; sensible fallback elsewhere.
  if (typeof window !== "undefined" && window.location?.origin?.startsWith("http")) {
    return window.location.origin + "/daemon";
  }
  return "http://127.0.0.1:8501";
}

export function getBase(): string {
  return localStorage.getItem("walletd_base") || defaultBase();
}
/** True when running inside the native mobile (Capacitor) shell rather than a browser. */
export function isNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}
export function setBase(url: string) {
  if (!url.trim()) localStorage.removeItem("walletd_base");
  else localStorage.setItem("walletd_base", url.replace(/\/$/, ""));
}

// A random per-browser wallet token. On the hosted daemon this selects THIS
// browser's wallet; losing it (clearing storage) means restoring from seed.
export function getToken(): string {
  let t = localStorage.getItem("wallet_token");
  if (!t) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    t = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("wallet_token", t);
  }
  return t;
}

export interface Status {
  has_wallet: boolean;
  address: string | null;
  network: string;
  node_connected: boolean;
  daa_score: number;
  synced: boolean;
  // Synced, but still doing the one-time witness warm-up that makes sends fast.
  // Sends work during this (just slower). Older daemons omit it.
  warming?: boolean;
  scanned_blocks: number;
  chain_len: number;
  balance_sompi: string;
  balance_fc: string;
  // Spendable now (matured past the ~10-min anchor depth) vs still-maturing. Older
  // daemons omit these; treat a missing value as "all of balance is spendable".
  spendable_fc?: string;
  spendable_sompi?: string;
  maturing_fc?: string;
  maturing_sompi?: string;
  // 0-conf: value seen arriving/leaving in blocks too close to the tip for the wallet
  // to ingest safely. The chain has confirmed these; the wallet's own tree has not
  // caught up yet. Older daemons omit them — absent means "nothing pending".
  pending_in_fc?: string;
  pending_out_fc?: string;
  note_count: number;
  updated_unix: number;
  error: string | null;
}

// Last good status, persisted so the app opens straight into the full wallet UI
// (balance, address, QR) instead of assembling it piece by piece as the first
// network round-trips land. The 1s poll corrects any staleness within a second.
// Keyed by wallet token so switching wallets never shows another wallet's data.
function statusCacheKey(): string {
  return `status_cache_${localStorage.getItem("wallet_token") || "default"}`;
}
export function loadStatusCache(): Status | null {
  try {
    const raw = localStorage.getItem(statusCacheKey());
    if (!raw) return null;
    const s = JSON.parse(raw) as Status;
    // Volatile flags must not be revived stale: a cached "warming" would flash the
    // warm-up notice on every open, and a cached error is long resolved.
    s.warming = false;
    s.error = null;
    return s.has_wallet && s.address ? s : null;
  } catch {
    return null;
  }
}
export function saveStatusCache(s: Status) {
  // Only a status that shows a real wallet is worth reviving; caching a
  // transient "no wallet" answer would flash the onboarding screen at startup.
  if (!s.has_wallet || !s.address) return;
  try {
    localStorage.setItem(statusCacheKey(), JSON.stringify(s));
  } catch {
    /* storage full/blocked — cache is best-effort */
  }
}

export interface Balance {
  balance_sompi: string;
  balance_fc: string;
  synced: boolean;
  scanned_blocks: number;
  chain_len: number;
  notes: { position: number; value: number }[];
  updated_unix: number;
  error: string | null;
}

export interface PrepareResp {
  session: string;
  sighash: string;
  value_balance: number;
  amount_sompi: number;
  fee_sompi: number;
  spend_auth: { index: number; alpha: string }[];
  bundle_hex: string;
  disclosure: {
    spend_value: number;
    out_value: number;
    out_recipient: string;
    out_rseed: string;
    rcv: string;
  }[];
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = { "X-Wallet-Token": getToken() };
  if (body) headers["Content-Type"] = "application/json";
  try {
    res = await fetch(getBase() + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("Cannot reach the wallet daemon. (" + (e as Error).message + ")");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  status: () => req<Status>("GET", "/api/status"),
  balance: () => req<Balance>("GET", "/api/wallet/balance"),
  create: () => req<{ address: string; seed_hex: string; network: string; warning: string }>("POST", "/api/wallet/create", {}),
  // Register a WATCH-ONLY wallet: the daemon gets the 96-byte viewing key only —
  // enough to sync the wallet and prove spends, powerless to authorize them. The
  // seed stays on this device. This is how the wallet is created/restored now;
  // `create`/`import` (which put the seed on the server) remain only for a
  // self-hosted daemon you run yourself.
  watch: (fvk_hex: string, birthday?: number) =>
    req<{ address: string }>("POST", "/api/wallet/watch", { fvk_hex, birthday: birthday ?? 0 }),
  reveal: () => req<{ address: string; seed_hex: string; network: string }>("GET", "/api/wallet/reveal"),
  import: (seed_hex: string, birthday?: number) =>
    req<{ address: string; seed_hex: string; network: string; warning: string }>("POST", "/api/wallet/import", {
      seed_hex,
      birthday: birthday && birthday > 0 ? Math.floor(birthday) : 0,
    }),
  // `memo` rides inside the recipient's encrypted note — readable by them, and by
  // this wallet only if recoverable history is on. The daemon has always accepted
  // it; the UI simply never offered it.
  send: (to: string, amount_fc: number, fee?: number, memo?: string) =>
    req<{ txid: string; amount_sompi: number; fee_sompi: number }>("POST", "/api/wallet/send", {
      to,
      amount_fc,
      fee,
      memo: memo?.trim() ? memo.trim() : undefined,
    }),
  // Non-custodial payment (mobile / hardened): the daemon builds the proof from the
  // FVK and returns per-spend randomizers to sign on-device; see noncustodial.ts.
  prepare: (fvk_hex: string, to: string, amount_fc: number, fee?: number, memo?: string) =>
    req<PrepareResp>("POST", "/api/wallet/prepare", {
      fvk_hex,
      to,
      amount_fc,
      fee,
      memo: memo?.trim() ? memo.trim() : undefined,
    }),
  submit: (session: string, sigs: { index: number; sig: string }[]) =>
    req<{ txid: string; amount_sompi: number; fee_sompi: number }>("POST", "/api/wallet/submit", { session, sigs }),
  sign: (message: string) =>
    req<{ address: string; message: string; signature: string; note: string }>("POST", "/api/wallet/sign", { message }),
  // Chain-derived history: recovered from the blocks themselves during scan
  // (coinbase mints, received notes, and — via the OVK — own sends), so unlike
  // the device-local send list it survives a seed restore and other devices.
  history: () => req<ChainHistory>("GET", "/api/wallet/history"),
  // History is opt-in: enabling stores a readable transaction record in the
  // wallet's scan data (and makes sends OVK-recoverable); disabling erases it.
  setHistoryEnabled: (on: boolean) =>
    req<{ recoverableHistory: boolean }>("POST", "/api/wallet/settings", { recoverable_history: on }),
  // Re-derive the wallet from the chain itself (from its birthday): backfills
  // history rows and recovers anything the incremental view lost.
  rescan: () => req<{ rescanning: boolean }>("POST", "/api/wallet/rescan", {}),
  verify: (address: string, message: string, signature: string) =>
    req<{ valid: boolean; reason: string | null }>("POST", "/api/verify", { address, message, signature }),
};

export interface ChainHistoryRow {
  kind: "coinbase" | "received" | "sent";
  txid: string;
  daaScore: number;
  timestamp: number; // ms; 0 when the scanning node predated block metadata
  amountSompi: number;
  amountZkas: number;
  feeSompi: number;
  recipient?: string | null; // sent rows only, and only when recoverable (OVK)
  memo?: string | null;
}

export interface PendingOutgoingRow {
  txid: string;
  amountSompi: number;
  amountZkas: number;
  submittedDaa: number;
}

export interface ChainHistory {
  recoverableHistory: boolean;
  total: number;
  rows: ChainHistoryRow[];
  // Sends submitted but not yet observed on-chain; the daemon auto-returns the
  // funds to the balance if the transaction never lands (~1 h).
  pendingOutgoing?: PendingOutgoingRow[];
}

// ---------------------------------------------------------------------------
// Public chain API (zkas-api), same-origin at `<origin>/chain` (nginx proxies it).
// The wallet asks the chain directly whether a send it broadcast is confirmed, rather
// than inferring it from its own balance — see localtx.applyChainStatus.

export interface ChainTx {
  confirmations?: number;
  is_accepted?: boolean;
  accepting_block_blue_score?: number;
}

/** Confirmations for a broadcast txid, or null if the chain doesn't know it yet. */
export async function chainTx(txid: string): Promise<ChainTx | null> {
  try {
    const base = isNative() ? "https://wallet.zkas.info/chain" : window.location.origin + "/chain";
    const r = await fetch(`${base}/transactions/${txid}`);
    if (!r.ok) return null; // not mined yet (the API 502s on an unknown tx)
    return (await r.json()) as ChainTx;
  } catch {
    return null;
  }
}
