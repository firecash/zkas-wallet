import { api, type ChainHistoryRow } from "../api";
import { displayName } from "../contacts";
import type { Network } from "../signer";
import type { Status } from "../api";

// navigator.clipboard is absent or throws in some native WebViews; fall back to a
// hidden textarea so "copy" never dies with an unhandled rejection on a phone.
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// A zkas: shielded address is bech32 with an "orchard" version byte; a full
// decode happens on-device at send time, but this catches the obvious typo/paste
// mistakes instantly so the user gets a red/green cue while typing.
export function looksLikeAddress(a: string): boolean {
  const s = a.trim();
  return /^(zkas|firecash)(test|sim|dev)?:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{60,80}$/.test(s);
}

// A scanned QR may be a bare address ("zkas:pxvt…") or a payment URI carrying
// an amount ("zkas:pxvt…?amount=1.5"). Split off the address and, if present,
// a numeric amount the caller can prefill.
export function parsePaymentUri(text: string): { address: string; amount?: string; memo?: string; label?: string } {
  const s = text.trim();
  const q = s.indexOf("?");
  if (q === -1) return { address: s };
  const address = s.slice(0, q);
  const p = new URLSearchParams(s.slice(q + 1));
  const amount = p.get("amount");
  return {
    address,
    amount: amount && /^\d*\.?\d+$/.test(amount) ? amount : undefined,
    memo: p.get("memo") || undefined,
    label: p.get("label") || undefined,
  };
}

export type PasteResult = { ok: true; text: string } | { ok: false; reason: "unavailable" | "denied" | "empty" };

export async function pasteText(): Promise<PasteResult> {
  // Android's WebView does not implement the async clipboard READ api at all — writing
  // works, reading is simply absent — so Paste could never work in the installed app and
  // told users "this browser won't share the clipboard" while they stood in a wallet,
  // not a browser. The native shell has to be asked through the platform plugin instead.
  //
  // Tried first, and only on the native shell, so browsers keep the standard path.
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) {
    try {
      const { Clipboard } = await import("@capacitor/clipboard");
      const { value } = await Clipboard.read();
      const native = (value ?? "").trim();
      return native ? { ok: true, text: native } : { ok: false, reason: "empty" };
    } catch {
      // Plugin missing (an older shell) or the read refused — fall through to the web
      // path, which at worst reports the same failure this would have.
    }
  }
  if (!navigator.clipboard?.readText) return { ok: false, reason: "unavailable" };
  let text: string;
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    return { ok: false, reason: "denied" };
  }
  return text ? { ok: true, text } : { ok: false, reason: "empty" };
}

// Keep a money field to something that can actually be a number: digits, one
// decimal point, at most 8 places (a sompi is 1e-8 ZKAS — more digits are not
// representable and silently round).
export function sanitizeAmountInput(raw: string): string {
  // Separators first, and this is not cosmetic. Stripping every non-[0-9.] turned
  // "1,5" into "15" — a TEN-TIMES overpayment, typed by anyone who writes decimals
  // with a comma, which is most of Europe and Latin America and the majority of
  // the 24 languages this wallet ships in. Nothing on screen ever said 1.5.
  //
  // Both marks can appear together ("1.000,50", "1,000.50"), so the LAST one is
  // the decimal separator and anything earlier is grouping. Arabic-Indic and
  // Persian digits, and the Arabic decimal mark, map to their ASCII forms —
  // otherwise an Arabic or Farsi keyboard produces an empty field.
  const digits = raw
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u066b\u066c]/g, (m) => (m === "\u066b" ? "." : ","));
  // Which mark is the DECIMAL one:
  //  - both present ("1.000,50", "1,000.50") -> the last one; the other groups.
  //  - one kind, repeated ("1.234.567")      -> grouping, there is no decimal.
  //    Treating the last as the decimal here gave 1234.567 for 1.234.567 — a
  //    thousand-fold error on a perfectly ordinary European amount.
  //  - one kind, once ("1,5" / "0.5")        -> the decimal.
  const dots = (digits.match(/\./g) ?? []).length;
  const commas = (digits.match(/,/g) ?? []).length;
  let decimalAt = -1;
  if (dots > 0 && commas > 0) decimalAt = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  else if (dots === 1) decimalAt = digits.lastIndexOf(".");
  else if (commas === 1) decimalAt = digits.lastIndexOf(",");
  let v =
    decimalAt === -1
      ? digits.replace(/[^0-9]/g, "")
      : digits.slice(0, decimalAt).replace(/[^0-9]/g, "") + "." + digits.slice(decimalAt + 1).replace(/[^0-9]/g, "");
  const dot = v.indexOf(".");
  if (dot !== -1) v = v.slice(0, dot + 1 + 8);
  return v;
}

// "12.34500000" or "12.345" -> 12.345 (number); NaN if not a clean amount.
export function parseAmount(s: string): number {
  if (!/^\d*\.?\d*$/.test(s.trim()) || s.trim() === "" || s.trim() === ".") return NaN;
  return parseFloat(s);
}

export function trimFc(fc: string): string {
  if (!fc.includes(".")) return fc;
  const [w, f] = fc.split(".");
  const trimmed = f.replace(/0+$/, "");
  return trimmed ? `${w}.${trimmed}` : w;
}

export function shortAddr(a: string): string {
  const body = a.replace(/^(zkas|firecash)(test)?:/, "");
  return body.length > 20 ? `${a.slice(0, 16)}…${a.slice(-6)}` : a;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function historyCsv(rows: ChainHistoryRow[]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = ["kind", "amount_zkas", "fee_zkas", "time_utc", "daa_score", "counterparty", "memo", "txid"];
  const lines = rows.map((r) =>
    [
      r.kind,
      r.amountZkas.toFixed(8),
      (r.feeSompi / 1e8).toFixed(8),
      r.timestamp > 0 ? new Date(r.timestamp).toISOString() : "",
      String(r.daaScore),
      displayName(r.recipient, r.recipient ?? ""),
      r.memo ?? "",
      r.txid,
    ]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

export function networkOf(status: Status | null): Network {
  return status?.network === "testnet" ? "testnet" : "mainnet";
}
