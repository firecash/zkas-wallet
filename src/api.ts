// Thin client for the firecash-walletd daemon.
//
// Default: the HOSTED daemon, reached same-origin at `<origin>/daemon` (nginx
// proxies it to 127.0.0.1:8501). This lets anyone use the wallet with just a
// browser — no node, no local install — connected to FireCash's public node.
// Each browser owns a random wallet token so wallets stay separate on the server.
//
// Self-hosted (fully non-custodial): override the daemon URL to your own local
// firecash-walletd (e.g. http://127.0.0.1:8501) — then the seed never leaves your
// machine.

function defaultBase(): string {
  // Native mobile (Capacitor) loads the bundle from the device, so there is no
  // same-origin server to proxy `/daemon` to — reach the hosted daemon directly.
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) return "https://wallet.firecash.info/daemon";
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
  scanned_blocks: number;
  chain_len: number;
  balance_sompi: string;
  balance_fc: string;
  note_count: number;
  updated_unix: number;
  error: string | null;
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
  send: (to: string, amount_fc: number, fee?: number) =>
    req<{ txid: string; amount_sompi: number; fee_sompi: number }>("POST", "/api/wallet/send", { to, amount_fc, fee }),
  // Non-custodial payment (mobile / hardened): the daemon builds the proof from the
  // FVK and returns per-spend randomizers to sign on-device; see noncustodial.ts.
  prepare: (fvk_hex: string, to: string, amount_fc: number, fee?: number) =>
    req<PrepareResp>("POST", "/api/wallet/prepare", { fvk_hex, to, amount_fc, fee }),
  submit: (session: string, sigs: { index: number; sig: string }[]) =>
    req<{ txid: string; amount_sompi: number; fee_sompi: number }>("POST", "/api/wallet/submit", { session, sigs }),
  sign: (message: string) =>
    req<{ address: string; message: string; signature: string; note: string }>("POST", "/api/wallet/sign", { message }),
  verify: (address: string, message: string, signature: string) =>
    req<{ valid: boolean; reason: string | null }>("POST", "/api/verify", { address, message, signature }),
};
