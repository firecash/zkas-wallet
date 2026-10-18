import { looksLikeAddress } from "./lib/utils";
import { readLocal, removeLocal, writeLocal } from "./lib/safestore";

const KEY = "zkas_pending_payment_v1";

function normalize(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("web+zkas:")) value = decodeURIComponent(value.slice("web+zkas:".length));
  if (value.length > 1_024) return null;
  const address = value.split("?", 1)[0];
  // `looksLikeAddress`, not a third copy of its regex. This file carried the pattern
  // inline, byte-identical to the one in lib/utils — the same arrangement that had the
  // app running duplicate copies of this very check, and here it guards a link arriving
  // from outside the app, which is the last place two answers should be possible.
  return looksLikeAddress(address) ? value : null;
}

export function queuePaymentLink(raw: string): boolean {
  const value = normalize(raw);
  if (!value) return false;
  // This runs on the BOOT path — main.tsx calls it for a `?payment=` query and for an
  // incoming deep link — and an unguarded write throws on a full or unavailable
  // localStorage, which on iOS is ordinary and in Safari private mode can throw outright.
  // That exception escaped into startup, where there is nothing to catch it.
  //
  // Through safestore, which exists for exactly this ("localStorage that cannot take the
  // app down") — its own header records `wallet_token` being unguarded in six places and
  // leaving a blocked-storage browser on "Something went wrong ... Access is denied", with
  // a Reload button that came back to the same screen. One more inline try/catch here
  // would have been a seventh place that knows this independently.
  writeLocal(KEY, value);
  // A write that silently did nothing must not report success: the caller would send the
  // user to a payment screen that finds no link.
  if (readLocal(KEY) !== value) return false;
  window.dispatchEvent(new CustomEvent("zkas-payment-link"));
  return true;
}

export function takePaymentLink(): string | null {
  // READS can throw too, not just writes: a storage disabled by policy raises on access
  // rather than returning null, and Safari private mode is the common case. This is read
  // from the app's own startup path, so an exception here takes the screen with it — the
  // same failure the write side had, on the half nobody thought to guard.
  //
  // Clearing is inside the same try: having read a link, failing to clear it would replay
  // the same payment prompt on every open.
  const value = readLocal(KEY);
  if (!value) return null;
  // Clearing matters as much as reading: a link left behind replays the same payment
  // prompt on every open.
  removeLocal(KEY);
  return normalize(value);
}

export function internalRouteFromLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "zkas-wallet:") return null;
    if (url.hostname === "receive") return "/?tab=receive";
    if (url.hostname === "mine") return "/mine";
    if (url.hostname === "explore") return "/explore";
  } catch {
    return null;
  }
  return null;
}
