import { readLocal, writeLocal } from "./lib/safestore";
// Several wallets on one device.
//
// The daemon has always been multi-wallet: every wallet is identified by a token
// and lives independently under it. The app, though, kept exactly one token in
// `wallet_token`, so having a second wallet meant destroying the first — which is
// why "use a different wallet" was a deletion. That was the app's limitation, not
// the protocol's.
//
// This is a registry of the wallets this device knows and which one is active.
// Every per-wallet cache is already keyed by token (`status_cache_<t>`,
// `device_seed_<t>`, `contacts_<t>`, `local_txs_<t>`, `last_known_<t>`), so
// switching the active token separates them cleanly — no data is moved, and
// nothing belonging to the other wallets is touched.

import i18n from "./i18n";

export interface WalletRef {
  token: string;
  /** User-facing name. Defaults to "Wallet 1", "Wallet 2", … */
  label: string;
  /** Cached address, purely so the switcher can show something recognisable. */
  address?: string;
  /**
   * The daemon this wallet was last seen served by, normalised.
   *
   * A token is a credential: it authenticates the FVK view of a wallet — balances,
   * payments, memos — on the daemon holding it. The registry had no idea which daemon any
   * of these belonged to, and `prewarm` touches every registered token against whatever
   * base is configured NOW, so pointing the app at a different daemon handed that daemon
   * the credentials of wallets hosted elsewhere, every 120 seconds.
   *
   * Written from the status poll, which is the moment a wallet is known to be served by
   * the current base. Absent means "not established since this field was added" and is
   * treated as a reason NOT to send the token anywhere.
   */
  base?: string;
}

/** Compare daemon URLs without tripping over a trailing slash or case. */
export function normBase(url: string | null | undefined): string {
  return (url || "").trim().replace(/\/+$/, "").toLowerCase();
}

const LIST_KEY = "wallets_v1";
/// Tokens the user has REMOVED, so a stale write cannot bring one back.
///
/// Every mutation here is read -> change -> write the WHOLE list, and two tabs share this
/// storage. Most of those races heal themselves: the status poll re-registers a row it
/// finds missing, and a freshly minted wallet becomes active and re-registers too.
/// Removal is the one that does not heal, it un-heals — tab A removes a wallet and writes
/// the shorter list, tab B writes a list it read BEFORE that, and the removed wallet is
/// back in the switcher. Its data is already wiped, so it reappears as a wallet this
/// device cannot spend from: alarming, and the opposite of what the user asked for.
///
/// A retry after writing would not close the window, because the stale write lands later.
/// A tombstone does, because it makes the removal a fact that any later list is filtered
/// against rather than a state that a later list can overwrite.
const GONE_KEY = "wallets_removed_v1";
/// Capped: this exists to beat an in-flight write from another tab, which is a matter of
/// milliseconds, not to remember every wallet ever deleted.
const GONE_MAX = 20;

function tombstones(): string[] {
  try {
    const raw = readLocal(GONE_KEY);
    const v = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function listWallets(): WalletRef[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const list = raw ? (JSON.parse(raw) as WalletRef[]) : [];
    if (!Array.isArray(list)) return [];
    const gone = new Set(tombstones());
    return gone.size ? list.filter((w) => !gone.has(w.token)) : list;
  } catch {
    return [];
  }
}

function save(list: WalletRef[]): void {
  // A storage failure here must not propagate.
  //
  // `ensureRegistered` runs INSIDE the status poll's try block, so when this threw —
  // localStorage full, or unavailable at all, which on iOS is ordinary since WKWebView
  // treats it as evictable website data, and in Safari private mode it can throw on
  // write — a perfectly good status reply was discarded as a failed poll. Five of those
  // and the wallet announced "Can't reach the wallet service" while the daemon was
  // answering every request. The symptom pointed at the network; the cause was a
  // bookkeeping write.
  //
  // Swallowing is right for THIS list and wrong a few lines away: the registry is
  // labels and addresses, rebuilt from the daemon on the next poll, whereas a seed
  // write that fails has to be loud — `setDeviceSeed` stays unguarded on purpose,
  // because silently dropping a key already cost a real user their funds (issue #4).
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    /* not persisted; the next poll re-registers from the daemon's own answer */
  }
  // Dispatched either way: listeners re-read from storage, so a failed write simply
  // leaves them on the previous list instead of desynchronising them from it.
  window.dispatchEvent(new CustomEvent("wallets-changed"));
}

export function activeToken(): string | null {
  return readLocal("wallet_token");
}

/**
 * Make sure the registry knows about the currently active token. Wallets created
 * before this existed have a token but no entry, and must not appear to vanish
 * the moment a switcher shows up.
 */
export function ensureRegistered(token: string, address?: string, base?: string): void {
  const list = listWallets();
  const b = base ? normBase(base) : undefined;
  const found = list.find((w) => w.token === token);
  if (found) {
    let dirty = false;
    if (address && found.address !== address) {
      found.address = address;
      dirty = true;
    }
    // Re-stamped rather than kept: a wallet that moved daemons (self-hosting, a restored
    // backup, pairing) belongs to the one now serving it, and a stale stamp would keep
    // sending its token to the old one.
    if (b && found.base !== b) {
      found.base = b;
      dirty = true;
    }
    if (dirty) save(list);
    return;
  }
  list.push({ token, label: i18n.t("wallets.defaultLabel", { n: nextLabelNumber(list) }), address, base: b });
  save(list);
}

export function renameWallet(token: string, label: string): void {
  const list = listWallets();
  const w = list.find((x) => x.token === token);
  if (!w) return;
  w.label = label.trim() || w.label;
  save(list);
}

/** Drop a wallet from the registry (the caller wipes its data separately). */
export function unregisterWallet(token: string): void {
  // Tombstone FIRST, so even a write that lands between these two lines cannot resurrect
  // it: the row may come back in storage, but listWallets filters it out.
  const gone = tombstones().filter((t) => t !== token);
  gone.push(token);
  writeLocal(GONE_KEY, JSON.stringify(gone.slice(-GONE_MAX)));
  save(listWallets().filter((w) => w.token !== token));
}

/// Forget a tombstone — for a token being REUSED, which is the one case where a removed
/// name legitimately comes back. Without this a reissued token would be invisible.
export function clearTombstone(token: string): void {
  const gone = tombstones().filter((t) => t !== token);
  writeLocal(GONE_KEY, JSON.stringify(gone));
}

/** Mint a token for a NEW wallet and make it active. Nothing else is touched. */
/**
 * The number for the next default label.
 *
 * NOT `list.length + 1`. Removing a wallet shortens the list, so the next one
 * reuses a number that is still on screen: remove the second of three and the
 * next "Add account" is a SECOND "Wallet 3", with the same avatar digit, both
 * rows identical in the switcher and in the wallet bar — which is the only
 * wallet identity the balance screen shows. Labels are persisted, so it
 * survives every reload. Counting past the highest number actually in use
 * keeps them unique without renumbering anything the user has already seen or
 * renamed.
 */
function nextLabelNumber(list: WalletRef[]): number {
  let highest = 0;
  for (const w of list) {
    const n = Number(w.label.match(/\d+/)?.[0] ?? 0);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return Math.max(highest + 1, list.length + 1);
}

/**
 * Mint a wallet. `activate` switches to it; pass false to create one in the
 * background.
 *
 * It always activated, which forced "Add account" to switch to the new wallet
 * BEFORE the daemon had registered it — so for as long as registration took,
 * the app was pointed at a wallet that did not exist. The bar showed the new
 * name and account number while the address and balance still came from the
 * previous wallet's state, and a registration that hung left the user there
 * for minutes.
 */
export function addWallet(activate = true): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const token = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const list = listWallets();
  list.push({ token, label: i18n.t("wallets.defaultLabel", { n: nextLabelNumber(list) }) });
  save(list);
  if (activate) writeLocal("wallet_token", token);
  return token;
}

/** Switch the active wallet. The other wallets' data stays exactly where it is. */
export function switchWallet(token: string): void {
  // writeLocal: a raw setItem threw out of the click handler that called this, so on a
  // browser with storage blocked tapping another wallet did nothing at all — not even the
  // reload that follows. It now takes effect for the session even when it cannot persist.
  writeLocal("wallet_token", token);
}
