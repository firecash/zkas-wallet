// Connecting a phone to a wallet service you run yourself, without typing secrets.
//
// Reaching another machine's wallet service needs THREE things, not one:
//
//   * where it is            — http://192.168.1.20:8501
//   * the access token       — `Authorization: Bearer …`, which gates the API
//   * the WALLET token       — `X-Wallet-Token: …`, which selects WHICH wallet
//
// The third is the one everybody misses. The daemon keeps one wallet file per wallet
// token, so a device that connects with its own freshly minted token reaches a real,
// authenticated, completely EMPTY wallet. That looks exactly like a failure, and no
// amount of re-checking the address or the access token fixes it — the connection was
// fine, it was just pointed at a different wallet.
//
// So a pairing string carries all three. The user scans a QR or pastes one line; the
// alternative is transcribing two 64-character hex secrets on a phone keyboard, which
// is why "just enter the token" was never a real answer.
//
// Format (matching `zkas-walletd`'s `selfhost::pairing_uri`, plus the wallet selector):
//
//   zkas+http://192.168.1.20:8501#token=<access>&wallet=<wallet>&net=mainnet
//
// The secrets live in the FRAGMENT, which is never sent to a server and never appears
// in a request line or an access log if the string is pasted somewhere careless.

export interface Pairing {
  /// Base URL to talk to, scheme included.
  url: string;
  /// Bearer token for the API gate. Empty when the service has no gate.
  accessToken: string;
  /// Which wallet on that service to open. Empty means "keep this device's own".
  walletToken: string;
  network: string;
}

/// Tokens are opaque ASCII-alphanumeric secrets, and the two ends mint them
/// DIFFERENTLY: the browser makes a 32-character hex wallet token, while the desktop
/// shell makes a 32-character *alphanumeric* one (`valid_wallet_token`, and its access
/// token is 64 hex). A hex-only rule therefore rejected essentially every real desktop
/// pairing code — 32 random alphanumerics are hex only by astronomical accident — so
/// scanning a valid QR reported "not a pairing code" and the user was sent back to
/// typing two long secrets by hand, which is the exact task this exists to remove.
/// Keep this in step with `valid_wallet_token` in the desktop shell.
const TOKEN_RE = /^[0-9a-z]{16,128}$/i;

export function isPairingUri(raw: string): boolean {
  return /^zkas\+https?:\/\//i.test(raw.trim());
}

/**
 * Parse a pairing string. Returns null for anything that is not one, so a caller can
 * fall through to treating the input as a plain address.
 *
 * Rejects rather than repairs: a pairing string with a malformed secret would otherwise
 * connect to the right machine and silently open the wrong (empty) wallet, which is the
 * confusing failure this whole mechanism exists to remove.
 */
export function parsePairingUri(raw: string): Pairing | null {
  const text = raw.trim();
  if (!isPairingUri(text)) return null;
  const secure = /^zkas\+https:/i.test(text);
  // Re-scheme it so the URL parser handles host/port/IPv6 for us rather than a regex.
  const asHttp = text.replace(/^zkas\+http(s?):\/\//i, (_m, s) => (s ? "https://" : "http://"));
  let parsed: URL;
  try {
    parsed = new URL(asHttp);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;

  const frag = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const accessToken = (frag.get("token") ?? "").trim();
  const walletToken = (frag.get("wallet") ?? "").trim();
  const network = (frag.get("net") ?? "mainnet").trim();
  if (accessToken && !TOKEN_RE.test(accessToken)) return null;
  if (walletToken && !TOKEN_RE.test(walletToken)) return null;
  if (!/^[a-z0-9-]{1,20}$/i.test(network)) return null;

  const port = parsed.port ? `:${parsed.port}` : "";
  return {
    url: `${secure ? "https" : "http"}://${parsed.hostname}${port}`,
    accessToken,
    walletToken,
    network,
  };
}

/** Build the string a host shows for pairing. Kept here so the two ends cannot drift. */
export function formatPairingUri(p: Pairing): string {
  const scheme = p.url.startsWith("https://") ? "zkas+https" : "zkas+http";
  const hostPort = p.url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const frag = new URLSearchParams();
  if (p.accessToken) frag.set("token", p.accessToken);
  if (p.walletToken) frag.set("wallet", p.walletToken);
  frag.set("net", p.network || "mainnet");
  return `${scheme}://${hostPort}#${frag.toString()}`;
}
