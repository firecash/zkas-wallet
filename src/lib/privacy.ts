// One answer to one question: may this request leave the device over clearnet?
//
// Before this file, every network call site made that decision for itself by
// calling `onionSiblingBase()` — a predicate on the SHAPE OF A URL. That is only
// correct for the hosted-onion case. It is silently wrong in phone mode: there
// the wallet drives a local engine and routes it through Orbot's SOCKS proxy,
// `walletd_base` is loopback or empty, `onionSiblingBase()` returns null, and
// every one of those call sites concluded "not on Tor, use clearnet" — so the
// chain API, the explorer, the services directory, the price feed and the chat
// relay were each reached from the user's real IP while the wallet said Tor was
// on. A WebView fetch cannot use the engine's SOCKS proxy; only the engine can.
//
// So the rule is: Tor on and no onion to reach => we do not make the request.
// Degrading a figure to "unknown" is a cost. Publishing the IP of someone who
// turned Tor on is a broken promise, and a promise is the whole product here.
//
// This module imports NOTHING. It is read by `api.ts`, and `embedded.ts` already
// imports `api.ts`, so taking the Tor flag from `embedded.ts` would close an
// import cycle. Both keys are read from storage directly instead; they are the
// same keys those modules write, asserted by `privacy.test.ts`.

const TOR_KEY = "wallet_embedded_tor";
const BASE_KEY = "walletd_base";

function readKey(k: string): string {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    // Private mode or disabled storage. An unreadable Tor flag must read as
    // "unknown", and unknown is treated as off below — the user has not asked
    // for Tor, so nothing is promised and nothing is broken by proceeding.
    return "";
  }
}

/** Is the on-device engine configured to reach the network over Tor (Orbot)? */
export function torEnabled(): boolean {
  return readKey(TOR_KEY) === "1";
}

/** Any scheme, not just http(s) — the chat relay is `ws:`/`wss:`, and an
 *  http-only pattern read "wss://x.onion/..." as a host of "wss:" and answered
 *  "not an onion", which would have refused the one relay that IS private. */
function isOnion(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  const scheme = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/);
  const host = (scheme ? scheme[1] : s).split("/")[0].replace(/^\[|\]$/g, "").split(":")[0];
  return host.endsWith(".onion");
}

/** The onion origin that also serves `/chain` and `/services.v1.json` — the
 *  configured walletd base with its `/daemon` suffix removed. `null` when the
 *  wallet is not pointed at an onion.
 *
 *  Only an explicitly configured base can be an onion; the built-in default
 *  never is. Reading the raw key is therefore equivalent to `getBase()` here,
 *  without the import. */
export function onionBase(): string | null {
  const base = readKey(BASE_KEY);
  if (!base || !isOnion(base)) return null;
  return base.replace(/\/+$/, "").replace(/\/daemon$/, "");
}

export type PrivacyMode =
  /** Nothing has been asked for. Clearnet is fine. */
  | "open"
  /** Everything stays on the onion we are already talking to. */
  | "onion"
  /** Tor is on but there is no onion for public APIs: the WebView cannot reach
   *  them privately, so it must not reach them at all. */
  | "tor-only";

export function privacyMode(): PrivacyMode {
  if (onionBase()) return "onion";
  return torEnabled() ? "tor-only" : "open";
}

/** May a plain HTTPS request to a public host be made right now? */
export function clearnetAllowed(): boolean {
  return privacyMode() === "open";
}

/** Resolve a public-API path to a URL, or `null` when it must not be fetched.
 *
 *  `path` starts with a slash (`"/chain"`, `"/services.v1.json"`). `fallback` is
 *  the clearnet URL to use when nothing is being hidden. Every public endpoint in
 *  the app goes through here, so a new one cannot forget the gate. */
export function publicEndpoint(path: string, fallback: string): string | null {
  const onion = onionBase();
  if (onion) return onion + path;
  return clearnetAllowed() ? fallback : null;
}

/** Is this URL safe to open as a socket under the current mode?
 *
 *  Used by chat, whose relay is a WebSocket. A WebView socket cannot traverse
 *  the engine's SOCKS proxy, so under `tor-only` only an onion relay is
 *  reachable privately — and connecting to anything else would hand the relay
 *  the user's real IP, which is the one thing the consent screen promises is a
 *  considered choice rather than an accident. */
export function socketAllowed(url: string): boolean {
  if (clearnetAllowed()) return true;
  return isOnion(url);
}
