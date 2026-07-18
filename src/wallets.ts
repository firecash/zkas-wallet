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

export interface WalletRef {
  token: string;
  /** User-facing name. Defaults to "Wallet 1", "Wallet 2", … */
  label: string;
  /** Cached address, purely so the switcher can show something recognisable. */
  address?: string;
}

const LIST_KEY = "wallets_v1";

export function listWallets(): WalletRef[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const list = raw ? (JSON.parse(raw) as WalletRef[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list: WalletRef[]): void {
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent("wallets-changed"));
}

export function activeToken(): string | null {
  return localStorage.getItem("wallet_token");
}

/**
 * Make sure the registry knows about the currently active token. Wallets created
 * before this existed have a token but no entry, and must not appear to vanish
 * the moment a switcher shows up.
 */
export function ensureRegistered(token: string, address?: string): void {
  const list = listWallets();
  const found = list.find((w) => w.token === token);
  if (found) {
    if (address && found.address !== address) {
      found.address = address;
      save(list);
    }
    return;
  }
  list.push({ token, label: `Wallet ${list.length + 1}`, address });
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
  save(listWallets().filter((w) => w.token !== token));
}

/** Mint a token for a NEW wallet and make it active. Nothing else is touched. */
export function addWallet(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const token = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const list = listWallets();
  list.push({ token, label: `Wallet ${list.length + 1}` });
  save(list);
  localStorage.setItem("wallet_token", token);
  return token;
}

/** Switch the active wallet. The other wallets' data stays exactly where it is. */
export function switchWallet(token: string): void {
  localStorage.setItem("wallet_token", token);
}
