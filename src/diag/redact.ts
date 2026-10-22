// THE redaction layer of the diagnostic log. Everything the app records passes through
// here before it is stored, shown, copied or exported.
//
// ZKas is a privacy wallet, and a diagnostic log is a document written to be handed to
// someone else. So the rule is not "avoid logging secrets" — it is that this module makes
// it impossible for one to survive, whatever a call site passes:
//
//   - seeds, phrases, passphrases, PINs, viewing keys, signatures, memos: dropped by field
//     name, and by shape wherever they appear in free text (hex runs, phrase-shaped runs)
//   - addresses, txids, tokens, hashes: replaced by a SHORT SALTED pseudonym, so two lines
//     about the same payment still correlate while the value itself cannot be recovered or
//     confirmed by anyone without this device's salt (which is never exported)
//   - amounts: replaced by an order-of-magnitude bucket — enough to tell a dust payment
//     from a large one, never the figure
//   - URLs: path template and host class only
//
// The Rust shell (src-tauri/src/diag.rs) and Android (DiagRedact.kt) carry ports of the
// free-text rules for the few strings they write themselves (panic messages, crash
// descriptions). All three are held to test/diag-redaction-vectors.json, so the ports
// cannot drift from this file silently.

import { sha256Hex } from "./sha256";

let salt = "";
const knownSecrets = new Set<string>();

/// Install this device's salt. Pseudonyms are stable for as long as it is.
export function setSalt(hex: string): void {
  salt = hex;
}

export function getSaltForTests(): string {
  return salt;
}

/// Values that must never appear even if no shape rule would catch them (wallet tokens are
/// 32 alphanumerics, which the long-token rule catches, but a known-value pass costs
/// nothing and survives a future token format).
export function setKnownSecrets(values: Iterable<string>): void {
  knownSecrets.clear();
  for (const v of values) if (v && v.length >= 8) knownSecrets.add(v);
}

/// Short salted pseudonym: 8 hex chars of SHA-256(salt ":" kind ":" value).
export function pseudonym(kind: string, value: string): string {
  return sha256Hex(`${salt}:${kind}:${value.trim().toLowerCase()}`).slice(0, 8);
}

// ---- amounts --------------------------------------------------------------------

const DECADES: [number, string][] = [
  [0.001, "<0.001"],
  [0.01, "0.001-0.01"],
  [0.1, "0.01-0.1"],
  [1, "0.1-1"],
  [10, "1-10"],
  [100, "10-100"],
  [1_000, "100-1k"],
  [10_000, "1k-10k"],
  [100_000, "10k-100k"],
  [1_000_000, "100k-1M"],
];

/// Order-of-magnitude bucket for an amount in ZKAS.
export function bucketAmount(zkas: number): string {
  if (!Number.isFinite(zkas)) return "?";
  const v = Math.abs(zkas);
  if (v === 0) return "0";
  for (const [limit, name] of DECADES) if (v < limit) return (zkas < 0 ? "-" : "") + name;
  return (zkas < 0 ? "-" : "") + ">=1M";
}

// ---- free text ------------------------------------------------------------------

/// Hosts that are the project's own public infrastructure. Naming them in a log says
/// nothing about the user; anything else (their own node, their LAN, a custom service)
/// is pseudonymised.
const PUBLIC_HOSTS = new Set([
  "seed.zkas.info",
  "wallet.zkas.info",
  "zkas.info",
  "explorer.zkas.info",
  "services.zkas.info",
  "api.zkas.info",
  "185.147.157.125",
  "160.187.211.153",
  "142.248.80.23",
  "127.0.0.1",
  "localhost",
  "plqu6zzg5u6lkofv76m3pnnxzbaus6pgs4thced4wejdroi7z7exd6qd.onion",
]);

const ADDRESS_RE = /\b(?:zkas|zkastest|zkasdev|zkassim|firecash|kaspa|kaspatest|kaspadev|kaspasim):[a-z0-9]{20,}/gi;
// NO lookbehind/lookahead anywhere in this file: older WebKit (the macOS 10.15 floor) fails
// to PARSE a regex literal that uses lookbehind, which would take the whole bundle down at
// load, and the Rust port's `regex` crate has no lookaround either. Conditions that would
// need it are checked in the replacement callbacks instead.
const HEX64_RE = /\b[0-9a-fA-F]{64}\b/g;
// Deliberately unanchored: a hex run glued to other characters is still a secret.
const HEX_RE = /[0-9a-fA-F]{16,}/g;
// Long base64/base58/bech32-ish runs: tokens, keys, bare address bodies. A run that is
// letters only is a word (or a CamelCase identifier), not a secret, so a digit AND a letter
// are required — checked in `isToken`.
const LONG_TOKEN_RE = /[A-Za-z0-9+_=-]{32,}/g;
/// A hex run counts only if it has a letter: a run of digits alone is a NUMBER (a float's
/// 17 significant digits, a timestamp), not a key — and mangling one inside a JSON line made
/// the line invalid (found in a real run: `"cpu_pct":0.x:acbb9140`).
function isHex(m: string): boolean {
  return /[a-fA-F]/.test(m);
}
function isToken(m: string): boolean {
  return /\d/.test(m) && /[A-Za-z]/.test(m);
}
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const ONION_RE = /\b[a-z2-7]{16,56}\.onion\b/gi;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
// Twelve or more short lowercase words in a row: the shape of a recovery phrase.
const PHRASE_RE = /\b(?:[a-z]{3,8}[ \t]+){11,}[a-z]{3,8}\b/g;
// A figure next to a unit. Sompi is converted to ZKAS before bucketing.
// The leading group stands in for a lookbehind: a figure right after "~", "-", "<", "=" or a
// word character is part of a bucket ("~10-100 ZKAS") or of a word, and is left alone —
// which is also what makes this rule idempotent.
const MONEY_RE = /(^|[^~\w.<>=-])(-?\d[\d,_]*(?:\.\d+)?)\s*(ZKAS|KAS|sompi|FC)\b/gi;

/// Product tokens of a user agent. A dotted four-part number right after one of these
/// ("Chrome/130.0.6723.92", "Edg/130.0.2849.80") is a browser or WebView version, not an
/// address — and on Windows the WebView2 version is exactly what a crash report needs.
/// Checked with endsWith on the text before the match (no lookbehind; see above). Ported
/// verbatim to diag.rs and DiagRedact.kt and pinned by a shared vector.
export const UA_PRODUCTS = [
  "Chrome", "Chromium", "CriOS", "Edg", "EdgA", "EdgiOS", "Edge", "Firefox", "FxiOS", "OPR", "Opera",
  "Version", "Safari", "AppleWebKit", "SamsungBrowser", "YaBrowser", "Electron", "Gecko", "Mobile",
];
function afterUaProduct(before: string): boolean {
  return UA_PRODUCTS.some((p) => before.endsWith(`${p}/`));
}

function privateIpv4(a: number, b: number): boolean {
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/// Redact free text. Idempotent: running it over its own output changes nothing.
export function redactText(input: string, max = 300): string {
  let s = String(input);
  for (const secret of knownSecrets) if (s.includes(secret)) s = s.split(secret).join(`x:${pseudonym("secret", secret)}`);
  // Fast path for the common case — a short string of words. Every rule below needs a
  // digit, a colon, an "@" or (the phrase rule) at least 47 characters, so a shorter string
  // with none of them cannot match any of them.
  // (A letters-only hex run and a letters-only onion are the two shapes without a digit.)
  if (s.length < 47 && !/[\d:@]/.test(s) && !/[a-fA-F]{16}/.test(s) && !s.includes(".onion")) return s;
  s = s.replace(PHRASE_RE, "[phrase]");
  s = s.replace(ADDRESS_RE, (m) => `addr:${pseudonym("addr", m)}`);
  s = s.replace(ONION_RE, (m) => (PUBLIC_HOSTS.has(m.toLowerCase()) ? m : `onion:${pseudonym("host", m)}`));
  s = s.replace(EMAIL_RE, "[email]");
  s = s.replace(HEX64_RE, (m) => (isHex(m) ? `h:${pseudonym("hash", m)}` : m));
  s = s.replace(HEX_RE, (m) => (isHex(m) ? `x:${pseudonym("hex", m)}` : m));
  s = s.replace(LONG_TOKEN_RE, (m: string, offset: number, whole: string) => {
    if (!isToken(m)) return m;
    // The project's own onion is public infrastructure, already let through above.
    if (whole.startsWith(".onion", offset + m.length) && PUBLIC_HOSTS.has(`${m.toLowerCase()}.onion`)) return m;
    return `b:${pseudonym("tok", m)}`;
  });
  s = s.replace(IPV4_RE, (m: string, a: string, b: string, _c: string, _d: string, offset: number, whole: string) => {
    if (PUBLIC_HOSTS.has(m)) return m;
    if (afterUaProduct(whole.slice(Math.max(0, offset - 20), offset))) return m;
    const na = Number(a), nb = Number(b);
    if ([a, b].some((x: string) => Number(x) > 255)) return m;
    return `${privateIpv4(na, nb) ? "lan" : "ip"}:${pseudonym("ip", m)}`;
  });
  s = s.replace(MONEY_RE, (_m, lead: string, num: string, unit: string) => {
    const n = Number(num.replace(/[,_]/g, ""));
    const zkas = /sompi/i.test(unit) ? n / 1e8 : n;
    return `${lead}~${bucketAmount(zkas)} ${/sompi/i.test(unit) ? "ZKAS" : unit.toUpperCase()}`;
  });
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

// ---- URLs -----------------------------------------------------------------------

export type HostClass = "loopback" | "lan" | "onion" | "zkas" | "custom" | "ipc" | "none";

export function hostClass(host: string): HostClass {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return "none";
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost")) return "loopback";
  if (h.endsWith(".onion")) return "onion";
  if (h === "zkas.info" || h.endsWith(".zkas.info") || PUBLIC_HOSTS.has(h)) return "zkas";
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m && privateIpv4(Number(m[1]), Number(m[2]))) return "lan";
  if (/^(fc|fd|fe80)/.test(h) && h.includes(":")) return "lan";
  return "custom";
}

/// Replace identifier-like path segments with placeholders. `/explore/tx/<txid>` becomes
/// `/explore/tx/:hash`; query strings keep their key names only.
export function templatePath(path: string): string {
  const [p, q] = path.split("?", 2);
  const segs = p.split("/").map((seg) => {
    if (!seg) return seg;
    if (/^[0-9a-fA-F]{64}$/.test(seg)) return ":hash";
    if (/^[0-9a-fA-F]{16,}$/.test(seg)) return ":hex";
    if (/^(?:zkas|zkastest|zkasdev|zkassim|firecash|kaspa)(?::|%3A)/i.test(seg)) return ":addr";
    if (/^\d+$/.test(seg)) return ":n";
    if (seg.length > 24 || /\d{4,}/.test(seg)) return ":id";
    return seg;
  });
  let out = segs.join("/");
  if (q) {
    const keys = q
      .split("&")
      .map((kv) => kv.split("=")[0])
      .filter((k) => /^[a-z_]{1,24}$/i.test(k));
    if (keys.length) out += `?${keys.map((k) => `${k}=*`).join("&")}`;
  }
  return out;
}

/// `{host, path}` safe to log for any URL string. Unknown hosts are classed, not named.
export function describeUrl(raw: string): { host: HostClass; hostName?: string; scheme: string; path: string } {
  try {
    const u = new URL(raw, "http://relative.invalid");
    const scheme = u.protocol.replace(/:$/, "");
    if (u.hostname === "relative.invalid") return { host: "none", scheme: "rel", path: templatePath(u.pathname + (u.search ? u.search : "")) };
    if (scheme === "ipc" || u.hostname === "ipc.localhost") return { host: "ipc", scheme, path: templatePath(u.pathname) };
    const cls = hostClass(u.hostname);
    const out: { host: HostClass; hostName?: string; scheme: string; path: string } = {
      host: cls,
      scheme,
      path: templatePath(u.pathname + (u.search ? u.search : "")),
    };
    if (cls === "zkas") out.hostName = u.hostname.toLowerCase();
    return out;
  } catch {
    return { host: "none", scheme: "?", path: "?" };
  }
}

// ---- structured fields ---------------------------------------------------------

/// Field names whose VALUE is never written, whatever its type.
const DROP_KEY = /(seed|mnemonic|phrase|passphrase|password|passwd|^pin$|^pin_|_pin$|secret|fvk|view_?key|viewing|privkey|priv_key|private_key|spend_?key|memo|^sigs?$|signature|alpha|bundle|disclosure|spend_auth|sighash|^body$|cookie|authorization|bearer|credential|^text$|^value_text$|contact|^label$|^note$)/i;
/// Field names that identify something: written as a pseudonym.
const HASH_KEY = /(address|^addr|^to$|recipient|payee|txid|^tx$|^txs$|hash|token|^session|^wallet$|wallet_id|nullifier|commitment|cmx|^host$|^url$|^base$)/i;
/// Field names that carry money: written as a magnitude bucket.
const MONEY_KEY = /(amount|balance|^value$|_value$|fee|sompi|spendable|maturing|pending_in|pending_out|pending_change|zkas$|_fc$|^fc$|price|paid|owed)/i;

function moneyBucket(key: string, v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(String(v).replace(/[,_\s]/g, ""));
  if (!Number.isFinite(n)) return "?";
  return bucketAmount(/sompi/i.test(key) ? n / 1e8 : n);
}

/// Redact one field. Unknown shapes become strings and go through `redactText`.
export function redactField(key: string, value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (DROP_KEY.test(key)) return "[redacted]";
  if (MONEY_KEY.test(key) && (typeof value === "number" || typeof value === "bigint" || typeof value === "string")) return moneyBucket(key, value);
  if (HASH_KEY.test(key) && (typeof value === "string" || typeof value === "number")) {
    const s = String(value);
    return s ? `#${pseudonym("id", s)}` : s;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return redactText(value, /stack$/i.test(key) ? 4_000 : key === "line" ? 600 : 300);
  if (depth >= 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactField(key, v, depth + 1));
  if (value instanceof Error) return redactError(value);
  if (typeof value === "object") return redactFields(value as Record<string, unknown>, depth + 1);
  return redactText(String(value));
}

export function redactFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (n++ >= 60) break;
    out[k] = redactField(k, v, depth);
  }
  return out;
}

/// An error, as something safe to write: its class, its message and its stack, all redacted.
export function redactError(e: unknown): { name: string; message: string; stack?: string } {
  if (e instanceof Error) {
    return {
      name: e.name || "Error",
      message: redactText(e.message || ""),
      stack: e.stack ? redactText(e.stack, 4_000) : undefined,
    };
  }
  if (typeof e === "string") return { name: "string", message: redactText(e) };
  try {
    return { name: typeof e, message: redactText(JSON.stringify(e) ?? String(e)) };
  } catch {
    return { name: typeof e, message: redactText(String(e)) };
  }
}

/// A UI label that is safe to keep: letters, spaces and light punctuation only. Anything
/// with a digit, a colon or a long run could be a figure or an identifier, so it is dropped
/// rather than "cleaned" — a label is a convenience, the element id is the identity.
export function safeLabel(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || s.length > 40) return undefined;
  if (!/^[\p{L}\p{M} '’&\-.,!?()/]+$/u.test(s)) return undefined;
  return s;
}

// ---- the checker ---------------------------------------------------------------

/// Everything a stored line must never contain. Used by the tests on every entry point,
/// and by scripts/diag-check.mjs on an exported log from a real run.
export const FORBIDDEN: { name: string; test: (line: string) => boolean }[] = [
  { name: "address", test: (l) => /\b(?:zkas|zkastest|zkasdev|zkassim|firecash|kaspa|kaspatest):[a-z0-9]{20,}/i.test(l) },
  { name: "hex16+", test: (l) => (l.match(/[0-9a-fA-F]{16,}/g) ?? []).some(isHex) },
  {
    name: "long-token",
    test: (l) => [...l.matchAll(/[A-Za-z0-9+_=-]{32,}/g)].some((m) => isToken(m[0]) && !(l.startsWith(".onion", (m.index ?? 0) + m[0].length) && PUBLIC_HOSTS.has(`${m[0].toLowerCase()}.onion`))),
  },
  { name: "phrase", test: (l) => /\b(?:[a-z]{3,8}[ \t]+){11,}[a-z]{3,8}\b/.test(l) },
  // A bucket is written "~1-10 ZKAS": the figure before the unit follows "~", "-", "<" or
  // "=", or is the "M" of ">=1M". A bare figure before a unit is a leaked amount.
  { name: "money", test: (l) => /(^|[^~\w.<>=-])\d[\d,_]*(\.\d+)?\s*(ZKAS|KAS|sompi)\b/i.test(l) },
  { name: "email", test: (l) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(l) },
];

/// The violations in one line, empty when clean. `secrets` are exact values that must not
/// appear (the test corpus, or a device's own tokens).
export function violations(line: string, secrets: string[] = []): string[] {
  const out: string[] = [];
  for (const f of FORBIDDEN) if (f.test(line)) out.push(f.name);
  for (const s of secrets) if (s && line.includes(s)) out.push(`secret:${s.slice(0, 4)}…`);
  return out;
}
