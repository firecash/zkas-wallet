import { getDeviceSeed } from "./deviceseed";

/// Watch-only wallets — a phone that can SEE the balance and never spend it.
///
/// A shielded chain separates seeing from spending. The 96-byte full viewing key
/// decrypts this wallet's notes, amounts and memos, but authorizing a spend needs
/// the spend-authorizing key, which only the seed yields. So a device holding just
/// the viewing key cannot move funds BY CONSTRUCTION — not because a button is
/// disabled, which is the kind of guarantee worth having on a phone browser.
///
/// PRIVACY, and it is not a small caveat: the viewing key discloses every amount
/// this wallet has ever received or sent, every memo, and everything it will see
/// in future. It is not a read-only password — it is the wallet's entire financial
/// history in one string. Handing it to someone is a permanent disclosure: it
/// cannot be revoked without moving the funds to a new wallet.

/// A full viewing key is 96 bytes, hex-encoded.
export function isViewKey(value: string): boolean {
  return /^[0-9a-fA-F]{192}$/.test(value.trim());
}

function watchKeyName(): string {
  return `watch_fvk_${localStorage.getItem("wallet_token") || "default"}`;
}

export function watchKey(): string {
  try {
    return localStorage.getItem(watchKeyName()) ?? "";
  } catch {
    return "";
  }
}

export function setWatchKey(fvk: string): void {
  const clean = fvk.trim().toLowerCase();
  if (!isViewKey(clean)) throw new Error("That is not a valid view key.");
  localStorage.setItem(watchKeyName(), clean);
}

export function clearWatchKey(): void {
  try {
    localStorage.removeItem(watchKeyName());
  } catch {
    /* best effort */
  }
}

/// True when this device holds a viewing key and NO spending key.
///
/// The seed check is the important half. A wallet that has both is a normal
/// wallet that merely knows its own viewing key, and must keep every spending
/// feature; only the absence of a seed makes a device genuinely unable to spend.
export function isWatchOnly(): boolean {
  return !!watchKey() && !getDeviceSeed();
}

/// The link that turns another device into a viewer of this wallet.
///
/// The key rides in the URL FRAGMENT, which browsers never send to a server — so
/// opening this link does not hand the viewing key to the host serving the page.
/// It does land in that browser's history, which is why the app strips it from
/// the address bar as soon as it has been adopted.
export function watchLink(fvk: string, birthday = 0, origin = "https://wallet.zkas.info"): string {
  if (!isViewKey(fvk)) throw new Error("That is not a valid view key.");
  // Carry the wallet's birthday. Without it the viewer registers with birthday 0
  // and the service replays the chain from genesis for a wallet that cannot have
  // history before it existed — minutes of scanning on a phone, for nothing.
  const b = Number.isFinite(birthday) && birthday > 0 ? `&b=${Math.floor(birthday)}` : "";
  return `${origin.replace(/\/$/, "")}/#/watch?key=${fvk.trim().toLowerCase()}${b}`;
}

/// The birthday carried by the current URL, if any. 0 means "scan everything".
export function birthdayFromUrl(): number {
  if (typeof location === "undefined") return 0;
  const query = (location.hash || "").split("?", 2)[1];
  if (!query) return 0;
  const raw = Number(new URLSearchParams(query).get("b") ?? "0");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/// The viewing key carried by the current URL, if any.
export function viewKeyFromUrl(): string {
  if (typeof location === "undefined") return "";
  const hash = location.hash || "";
  const query = hash.split("?", 2)[1];
  if (!query) return "";
  const raw = new URLSearchParams(query).get("key") ?? "";
  return isViewKey(raw) ? raw.trim().toLowerCase() : "";
}
