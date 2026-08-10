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

import { WALLET_SERVICE_PORT } from "./ports";

function defaultBase(): string {
  // Native mobile (Capacitor) loads the bundle from the device, so there is no
  // same-origin server to proxy `/daemon` to — reach the hosted daemon directly.
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) return "https://wallet.zkas.info/daemon";
  // Tauri desktop: the embedded daemon's real port is installed into
  // walletd_base by initDesktop before the app mounts. If it is ever missing,
  // same-origin would pass the startsWith("http") test on Windows (the origin
  // there is http://tauri.localhost) and route wallet calls INTO the app
  // bundle. Loopback is the only honest fallback on desktop.
  if ("__TAURI_INTERNALS__" in globalThis) return "http://127.0.0.1:8501";
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

export function getWalletdBearer(): string {
  return localStorage.getItem("walletd_bearer") ?? "";
}

export function setWalletdBearer(token: string) {
  const clean = token.trim();
  if (clean) localStorage.setItem("walletd_bearer", clean);
  else localStorage.removeItem("walletd_bearer");
}

/** The default port a self-hosted `zkas-walletd` listens on. */
export const DEFAULT_WALLETD_PORT = WALLET_SERVICE_PORT;

/** True for installed shells, where a user-selected HTTP walletd is not mixed
 * content from a remote web page and is useful for private LAN deployments. */
export function allowsInsecureWalletd(): boolean {
  return "__TAURI_INTERNALS__" in globalThis || isNative();
}

/**
 * Turn whatever the user typed into their own node's box into a full wallet-service
 * URL. The point is that "just paste your node's IP" works — nobody should have to
 * remember a scheme or `:8501`. Installed apps use HTTP for LAN nodes; the web
 * wallet uses HTTPS because an HTTPS page cannot safely load a cleartext daemon:
 *   native: 185.147.157.125     → http://185.147.157.125:8501
 *   web:    wallet.example.com  → https://wallet.example.com (HTTPS/443 proxy)
 *   185.147.157.125:8501       → http://185.147.157.125:8501   (explicit port kept)
 *   mynode.example.com         → http://mynode.example.com:8501
 *   http(s)://…                → passed through (only trailing slash trimmed)
 * Returns "" for empty input (meaning: fall back to the hosted default).
 */
export function normalizeDaemonInput(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  // Already a URL — respect the user's scheme/port exactly.
  if (/^https?:\/\//i.test(s)) return s;
  const localApp = allowsInsecureWalletd();
  // Bare host or host:port. IPv6 must be bracketed in a URL. In particular,
  // `::1` is an ADDRESS, not the host `:` with port 1 — the old final-`:digits`
  // test produced the invalid URL `http://::1`. An explicit IPv6 port remains
  // unambiguous only in the normal `[2001:db8::1]:9000` form.
  if (s.startsWith("[")) {
    if (!/^\[[^\]]+\](?::\d+)?$/.test(s)) return "";
    if (localApp && !/:\d+$/.test(s)) s = `${s}:${DEFAULT_WALLETD_PORT}`;
  } else if ((s.match(/:/g) || []).length > 1) {
    s = `[${s}]${localApp ? `:${DEFAULT_WALLETD_PORT}` : ""}`;
  } else if (localApp && !/:\d+$/.test(s)) {
    s = `${s}:${DEFAULT_WALLETD_PORT}`;
  }
  return `${localApp ? "http" : "https"}://${s}`;
}

/** Candidate URLs for a user-entered wallet-service address. Installed apps
 * try both transports for a bare private/LAN host. Public hosts do not silently
 * downgrade from HTTPS; an explicit scheme stays authoritative. */
export function daemonEndpointCandidates(raw: string): string[] {
  const entered = raw.trim().replace(/\/+$/, "");
  if (!entered) return [];
  if (/^https?:\/\//i.test(entered)) return [normalizeDaemonInput(entered)].filter(Boolean);

  const primary = normalizeDaemonInput(entered);
  if (!primary || !allowsInsecureWalletd()) return primary ? [primary] : [];

  let host = "";
  try {
    host = new URL(primary).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return [];
  }
  const privateLan =
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    (() => {
      const match = host.match(/^172\.(\d+)\./);
      return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
    })();
  const http = primary.replace(/^https:/i, "http:");
  const https = primary.replace(/^http:/i, "https:");
  return privateLan ? [http, https] : [https];
}

/** A wallet service that answered, but refused this caller's credentials. Kept
 * distinct from every other failure because the remedy is completely different:
 * the address, port and network are all correct and only the access token is
 * wrong — advice about firewalls and IP addresses would send the user hunting
 * for a problem that does not exist. */
export class WalletdUnauthorizedError extends Error {
  constructor(public url: string) {
    super("That wallet service is reachable, but it rejected the access token. Copy the token from the Host screen of the computer running it.");
    this.name = "WalletdUnauthorizedError";
  }
}

async function probe(url: string, path: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = globalThis.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(`${url}${path}`, { signal: ctl.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every sensible transport and return the URL whose authenticated status
 * endpoint actually answers. Callers persist only this successful URL.
 *
 * `/health` is probed first because it is the one endpoint no bearer gate covers.
 * Reaching it proves the address, port, network route and CORS configuration are
 * all sound, which narrows a subsequent 401 to exactly one cause — the token —
 * instead of leaving the user with a bare "failed to fetch" that is equally
 * consistent with a typo, a firewall, a sleeping machine and a wrong port. */
export async function findReachableDaemon(raw: string, accessToken = "", timeoutMs = 5_000): Promise<string> {
  const candidates = daemonEndpointCandidates(raw);
  if (!candidates.length) throw new Error("Enter a valid wallet-service address.");
  const failures: string[] = [];
  const describe = (error: unknown) =>
    (error as Error).name === "AbortError" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (error as Error).message;

  for (const url of candidates) {
    const transportError = walletdTransportError(url);
    if (transportError) {
      failures.push(`${url}: ${transportError}`);
      continue;
    }
    try {
      const health = await probe(url, "/health", {}, timeoutMs);
      if (!health.ok) throw new Error(`answered ${health.status} on /health`);
    } catch (error) {
      failures.push(`${url}: ${describe(error)}`);
      continue;
    }
    // The service is definitely there. From here a failure is about THIS caller,
    // so report it rather than silently trying the next transport and blaming the
    // last one's error message.
    const headers: Record<string, string> = { "X-Wallet-Token": getToken() };
    if (accessToken.trim()) headers.Authorization = `Bearer ${accessToken.trim()}`;
    const response = await probe(url, "/api/status", headers, timeoutMs).catch((error: unknown) => {
      throw new Error(`${url} is reachable but refused the wallet API request (${describe(error)}).`);
    });
    if (response.status === 401 || response.status === 403) throw new WalletdUnauthorizedError(url);
    if (!response.ok) throw new Error(`The wallet service at ${url} answered ${response.status}.`);
    return url;
  }
  throw new Error(`Could not reach a wallet service. Tried ${failures.join("; ")}`);
}

/** Explain a transport choice before fetch turns it into an opaque mixed-content
 * failure. Native shells permit HTTP; a browser connection must use HTTPS. */
export function walletdTransportError(url: string): string | null {
  if (!url || allowsInsecureWalletd()) return null;
  try {
    if (new URL(url).protocol !== "https:") {
      return "The web wallet can connect only to an HTTPS wallet service. Use an HTTPS URL, or use the installed desktop/mobile app for a plain HTTP LAN connection.";
    }
  } catch {
    return "Enter a valid HTTPS wallet-service URL.";
  }
  return null;
}

/** Point this device at a specific wallet on the daemon.
 *
 * Only pairing uses this. The wallet token SELECTS a wallet — the daemon keeps one
 * wallet file per token — so a device connecting to someone else's wallet service
 * with its own token reaches a real, authenticated, empty wallet. Adopting the
 * paired token is what makes the phone show the SAME wallet as the computer serving
 * it, rather than a blank one that reads as lost funds. */
export function setToken(token: string) {
  const clean = token.trim().toLowerCase();
  if (/^[0-9a-f]{16,128}$/.test(clean)) localStorage.setItem("wallet_token", clean);
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
  // Whether the daemon would ACCEPT a spend right now — the same condition `/prepare`
  // enforces, which `synced` alone does not capture: a wallet borrowing the shared
  // chain tree is scanned up to the tip yet still has no valid mirror tree, and
  // `/prepare` answers "wallet is still catching up with the shared chain state".
  // Reading `synced` for this is what let the balance card say "Ready · 1.27 ZKAS"
  // while Send refused seconds later. Older daemons omit it; absent means "trust
  // `synced`", which is the old behaviour and no worse than it was.
  spend_ready?: boolean;
  // The wallet's view was rebuilt through a node that has PRUNED part of its
  // history: notes older than the node's pruning point exist on-chain but cannot
  // be seen here, so the balance is a lower bound. The UI must say so — silence
  // here is how "my coins vanished" happens. Older daemons omit it.
  missing_history?: boolean;
  // Watch-only wallet: the daemon holds the viewing key only. Surfaced as a badge
  // so a restored/read-only wallet never looks like it can spend. Older daemons omit it.
  watch_only?: boolean;
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
  pending_in_sompi?: string;
  pending_out_fc?: string;
  pending_out_sompi?: string;
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
const statusCacheWrites = new Map<string, { meaningful: string; at: number }>();
export function saveStatusCache(s: Status) {
  // Only a status that shows a real wallet is worth reviving; caching a
  // transient "no wallet" answer would flash the onboarding screen at startup.
  if (!s.has_wallet || !s.address) return;
  try {
    const key = statusCacheKey();
    // `updated_unix` and scan counters move constantly. Writing their fresh JSON
    // synchronously every second wore localStorage (and blocked the UI thread) for
    // no visible benefit. Balance/state changes still persist immediately; pure
    // scan progress gets a five-second checkpoint.
    const meaningful = [
      s.address,
      s.synced,
      s.warming,
      s.node_connected,
      s.balance_sompi,
      s.spendable_sompi,
      s.maturing_sompi,
      s.pending_in_sompi,
      s.pending_out_sompi,
      s.note_count,
      s.error,
      s.missing_history,
      s.watch_only,
    ].join("|");
    const now = Date.now();
    const previous = statusCacheWrites.get(key);
    if (previous?.meaningful === meaningful && now - previous.at < 5_000) return;
    localStorage.setItem(key, JSON.stringify(s));
    statusCacheWrites.set(key, { meaningful, at: now });
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
  /// How many notes the wallet holds. Always present.
  note_count: number;
  /// The full per-note list — sent ONLY when the request asks for it (`?notes=1`).
  ///
  /// It used to come back on every poll: ~10.5 MB on a wallet with 273K notes, on
  /// the most frequently called endpoint in the app, serialised while the daemon
  /// held that wallet's lock. Nothing here ever read it — this interface declared
  /// it and no component touched it — so the daemon now omits it by default.
  /// Ask for it only if something genuinely needs per-note detail.
  notes?: { position: number; value: number }[];
  updated_unix: number;
  error: string | null;
}

export interface PrepareResp {
  session: string;
  sighash: string;
  value_balance: number;
  amount_sompi: number;
  fee_sompi: number;
  /// Sompi of the requested amount this transaction does NOT cover (0 when complete).
  /// Only ever non-zero when `allow_partial` was passed.
  remaining_sompi: number;
  // Exact decimal-string forms of the figures above, immune to JS float loss.
  // Newer daemons always send them; fall back to the numbers when absent.
  amount_sompi_exact?: string;
  fee_sompi_exact?: string;
  remaining_sompi_exact?: string;
  spend_auth: { index: number; alpha: string }[];
  // False when the daemon had to fall back to a watch-only chain replay for this
  // prepare (minutes on a long chain) instead of its live wallet view — usually a
  // token↔FVK mismatch. Older daemons omit it; treat absent as fast.
  fast_path?: boolean;
  bundle_hex: string;
  disclosure: {
    spend_value: number;
    out_value: number;
    out_recipient: string;
    out_rseed: string;
    rcv: string;
  }[];
}

async function req<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  let status: number;
  let statusText = "";
  let text: string;
  const headers: Record<string, string> = { "X-Wallet-Token": getToken() };
  const bearer = getWalletdBearer();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body) headers["Content-Type"] = "application/json";

  // Desktop embeds walletd in the Rust process. Route its calls through Tauri
  // instead of the WebView network stack: Host access can restart walletd on a
  // different port and add a bearer gate, and Rust is the single authoritative
  // owner of both values. This removes stale-port/CORS/auth races while keeping
  // the exact same HTTP API boundary. Web/mobile still talk to walletd directly.
  if ("__TAURI_INTERNALS__" in globalThis) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const response = await invoke<{ status: number; body: string }>("wallet_api_request", {
        method,
        path,
        body: body ?? null,
        walletToken: getToken(),
        timeoutMs,
      });
      status = response.status;
      text = response.body;
    } catch (e) {
      const detail = typeof e === "string" ? e : (e as Error)?.message || String(e);
      throw new Error("Cannot reach the embedded wallet engine. (" + detail + ")");
    }
  } else {
    let res: Response;
    // Hard ceiling on every daemon call: `status` runs inside the 1-second poll, and
    // one hung connection (mobile network, sleeping proxy) used to freeze the whole
    // poll — balance, sync, and sends all stuck behind it. Slow calls (proving,
    // cold wallet loads) pass a larger `timeoutMs`; chainTx has its own 4s bound.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      res = await fetch(getBase() + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      if (ctl.signal.aborted) throw new Error("The wallet service is not responding (timed out).");
      throw new Error("Cannot reach the wallet daemon. (" + (e as Error).message + ")");
    } finally {
      clearTimeout(timer);
    }
    status = res.status;
    statusText = res.statusText;
    text = await res.text();
  }
  // A proxy error page (nginx 502, captive portal) is HTML, not JSON — parsing it
  // raw threw `SyntaxError: Unexpected token '<'` straight at the user. Report the
  // HTTP status instead; only parse when there is a body to parse.
  let data: { error?: string } & Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`The wallet service returned an invalid response (${status}).`);
    }
  }
  if (status < 200 || status >= 300) throw new Error(typeof data.error === "string" ? data.error : `${status} ${statusText}`.trim());
  return data as T;
}

export const api = {
  status: () => req<Status>("GET", "/api/status"),
  balance: () => req<Balance>("GET", "/api/wallet/balance"),
  // Wallet registration/load can take minutes on the hosted daemon (a cold wallet
  // loads its scan state from disk, then catches up to the tip) — hence 2-3 min
  // ceilings here vs the 10s default for lightweight calls.
  create: () =>
    req<{ address: string; seed_hex: string; network: string; warning: string }>("POST", "/api/wallet/create", {}, 120_000),
  // Register a WATCH-ONLY wallet: the daemon gets the 96-byte viewing key only —
  // enough to sync the wallet and prove spends, powerless to authorize them. The
  // seed stays on this device. This is how the wallet is created/restored now;
  // `create`/`import` (which put the seed on the server) remain only for a
  // self-hosted daemon you run yourself.
  watch: (fvk_hex: string, birthday?: number) =>
    req<{ address: string }>("POST", "/api/wallet/watch", { fvk_hex, birthday: birthday ?? 0 }, 180_000),
  reveal: () => req<{ address: string; seed_hex: string; network: string }>("GET", "/api/wallet/reveal", undefined, 30_000),
  import: (seed_hex: string, birthday?: number) =>
    req<{ address: string; seed_hex: string; network: string; warning: string }>(
      "POST",
      "/api/wallet/import",
      {
        seed_hex,
        birthday: birthday && birthday > 0 ? Math.floor(birthday) : 0,
      },
      120_000,
    ),
  // `memo` rides inside the recipient's encrypted note — readable by them, and by
  // this wallet only if recoverable history is on. The daemon has always accepted
  // it; the UI simply never offered it. Custodial send proves in-daemon — allow
  // the same 5-minute ceiling as prepare.
  send: (to: string, amount_fc: number, fee?: number, memo?: string) =>
    req<{ txid: string; amount_sompi: number; fee_sompi: number }>(
      "POST",
      "/api/wallet/send",
      {
        to,
        amount_fc,
        fee,
        memo: memo?.trim() ? memo.trim() : undefined,
      },
      300_000,
    ),
  // Efficient multi-recipient payout for a SELF-HOSTED custodial walletd. The
  // hosted/default wallet is watch-only and correctly refuses this endpoint;
  // non-custodial batch signing needs a prepare-many protocol and must never be
  // emulated by uploading the seed.
  sendMany: (payees: { to: string; amount_sompi: string; memo?: string }[], fee?: string) =>
    req<{ txids: string[]; tx_count: number; payees: number; paid_sompi: number; fee_sompi: number }>(
      "POST",
      "/api/wallet/send_many",
      { payees, fee },
      900_000,
    ),
  // One server-side note merge. As above, this exists only when walletd owns a
  // local seed. The normal app never sends its device seed to unlock this.
  consolidate: (fee?: number) =>
    req<{ txid: string; consolidated: number; value_sompi: number; notes_remaining: number }>(
      "POST",
      "/api/wallet/consolidate",
      { fee },
      600_000,
    ),
  // Non-custodial payment (mobile / hardened): the daemon builds the proof from the
  // FVK and returns per-spend randomizers to sign on-device; see noncustodial.ts.
  // `allow_partial` opts into chunking: one standard transaction can spend at most
  // ~38 notes (the node's 500,000-mass standard cap), so a wallet holding many small
  // notes cannot always pay a large amount at once. With it the
  // daemon pays what one transaction carries and reports `remaining_sompi`; the caller
  // repeats until 0 only after the user explicitly accepts split delivery. Normal
  // Send leaves it false, so the daemon rejects before signing/broadcasting and a
  // bill can never be silently paid only in part.
  // `amountSompi` is an exact integer (bigint), sent as a decimal string so no
  // floating-point coin amount ever crosses the wire. The one float→integer
  // conversion happens where the user's decimal input is parsed, not here.
  // Proving is the slow step (~seconds per note) — 5-minute ceiling.
  prepare: (fvk_hex: string, to: string, amountSompi: bigint, fee?: number, memo?: string, allow_partial?: boolean) =>
    req<PrepareResp>(
      "POST",
      "/api/wallet/prepare",
      {
        fvk_hex,
        to,
        amount_sompi: amountSompi.toString(),
        fee,
        memo: memo?.trim() ? memo.trim() : undefined,
        allow_partial,
      },
      300_000,
    ),
  submit: (session: string, sigs: { index: number; sig: string }[]) =>
    req<{ txid: string; amount_sompi: number; fee_sompi: number }>("POST", "/api/wallet/submit", { session, sigs }, 60_000),
  sign: (message: string) =>
    req<{ address: string; message: string; signature: string; note: string }>("POST", "/api/wallet/sign", { message }, 15_000),
  // Chain-derived history: recovered from the blocks themselves during scan
  // (coinbase mints, received notes, and — via the OVK — own sends), so unlike
  // the device-local send list it survives a seed restore and other devices.
  history: () => req<ChainHistory>("GET", "/api/wallet/history", undefined, 30_000),
  // History is opt-in: enabling stores a readable transaction record in the
  // wallet's scan data (and makes sends OVK-recoverable); disabling erases it.
  setHistoryEnabled: (on: boolean) =>
    req<{ recoverableHistory: boolean }>("POST", "/api/wallet/settings", { recoverable_history: on }, 15_000),
  // Re-derive the wallet from the chain itself (from its birthday): backfills
  // history rows and recovers anything the incremental view lost.
  rescan: () => req<{ rescanning: boolean }>("POST", "/api/wallet/rescan", {}, 30_000),
  verify: (address: string, message: string, signature: string) =>
    req<{ valid: boolean; reason: string | null }>("POST", "/api/verify", { address, message, signature }, 15_000),
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

/// Base URL of the public chain (explorer) API.
///
/// On the hosted web page it is same-origin (`/chain`, nginx-proxied). Anywhere
/// the page is NOT served from wallet.zkas.info — the Capacitor mobile shell
/// (capacitor://localhost) AND the Tauri desktop shell (tauri://localhost) — that
/// same-origin path resolves to a scheme that serves no such route, the fetch
/// fails, and every broadcast payment is stuck reading "0-conf" forever because
/// its confirmation lookup can never succeed. Detecting only Capacitor missed the
/// desktop app entirely. Both native shells must reach the public host directly.
function chainBase(): string {
  const native = isNative() || "__TAURI_INTERNALS__" in globalThis;
  return native ? "https://wallet.zkas.info/chain" : window.location.origin + "/chain";
}

/** Confirmations for a broadcast txid, or null if the chain doesn't know it yet.
 * Hard 4s timeout: this runs inside the wallet's 1-second status poll, and one
 * hung request (mobile network, sleeping proxy) used to stall the ENTIRE poll —
 * balance, sync state, and every other row's confirmations froze with it. */
export async function chainTx(txid: string): Promise<ChainTx | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`${chainBase()}/transactions/${txid}`, { signal: ctl.signal });
    if (!r.ok) return null; // not mined yet (the API 502s on an unknown tx)
    return (await r.json()) as ChainTx;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
