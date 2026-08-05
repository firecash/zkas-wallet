// Removing a wallet, completely.
//
// A wallet's state is scattered across storage by design — the daemon holds the
// key file and scan data, while the app holds the spending key, contacts, cached
// status, local send list, balance snapshot and (globally!) the app lock. Every
// one of those has to go together, or the next wallet inherits fragments of the
// last one and the app appears to have ignored the removal entirely.
//
// That is exactly what happened on 2026-07-18: "Use a different wallet" deleted
// the daemon-side files, and the same wallet came straight back — resurrected
// from the cached status, still holding the old device seed, under the same
// token. Hence one function that knows the whole list, in one place, so a key
// added later has an obvious home instead of being quietly forgotten here.

/** Per-wallet keys, all suffixed with the wallet token. */
const PER_WALLET_PREFIXES = [
  "status_cache_", // cached /api/status — revives a removed wallet's address+balance
  "device_seed_", // THE spending key on this device
  "contacts_", // address book
  "local_txs_", // on-device record of sends
  "last_known_", // balance snapshot shown while the daemon reloads
  "birthday_", // scan birthday remembered for backup files
  "seed_unsealed_", // flag for the plaintext fallback written when lock-sealing failed
  "app_lock_v1_", // legacy per-wallet lock record (superseded by the device lock)
];

/**
 * Keys that are global and must be left ALONE here.
 *
 * `app_lock_v2` is the device lock: one record holding the sealed seed of EVERY
 * wallet. Deleting it while removing one wallet would destroy the keys of all
 * the others — the caller drops just the removed wallet's entry via
 * `forgetWalletLock`. Listed explicitly so nobody adds it to the sweep below.
 */
const NEVER_TOUCH = ["app_lock_v2"];

/**
 * Erase every trace of the wallet identified by `token` from this device's
 * storage. Deliberately does NOT touch preferences that are about the app rather
 * than the wallet — theme, chosen node, daemon URL — since a user swapping
 * wallets has not asked to be reconfigured.
 *
 * Caller is responsible for the daemon side (Tauri `forget_wallet`) and for
 * reloading afterwards.
 */
export function wipeWalletState(token: string | null): void {
  const t = token || localStorage.getItem("wallet_token") || "default";
  for (const p of PER_WALLET_PREFIXES) localStorage.removeItem(p + t);
  void NEVER_TOUCH; // documentation of intent; see the comment above

  // QR images are cached per ADDRESS, and the address of a wallet being removed
  // is not worth reconstructing just to delete one entry — sweep the prefix.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith("qr_")) localStorage.removeItem(k);
  }

  // The token itself last: on desktop the shell rotates it and hands back a new
  // one, and in the browser a fresh one is minted on demand. Either way the next
  // wallet must not answer to the removed wallet's name.
  localStorage.removeItem("wallet_token");
  sessionStorage.clear();
}
