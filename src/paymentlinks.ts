const KEY = "zkas_pending_payment_v1";

function normalize(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("web+zkas:")) value = decodeURIComponent(value.slice("web+zkas:".length));
  if (value.length > 1_024) return null;
  const address = value.split("?", 1)[0];
  return /^(zkas|firecash)(test|sim|dev)?:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{60,80}$/.test(address) ? value : null;
}

export function queuePaymentLink(raw: string): boolean {
  const value = normalize(raw);
  if (!value) return false;
  localStorage.setItem(KEY, value);
  window.dispatchEvent(new CustomEvent("zkas-payment-link"));
  return true;
}

export function takePaymentLink(): string | null {
  const value = localStorage.getItem(KEY);
  if (!value) return null;
  localStorage.removeItem(KEY);
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
