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
  let v = raw.replace(/[^0-9.]/g, "");
  const first = v.indexOf(".");
  if (first !== -1) v = v.slice(0, first + 1) + v.slice(first + 1).replace(/\./g, "");
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
