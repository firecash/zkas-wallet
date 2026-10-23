import { readLocal, removeLocal } from "./lib/safestore";
import { forgetSentDms } from "./lib/dmlog";
import { forgetSendDraft } from "./lib/senddraft";
import { forgetScanReceipt } from "./scanreceipt";
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
  // Which account of the master phrase this token was derived at. Left behind, a
  // stale mapping on a reused token makes RevealSeedCard/DeviceSeedBackup show the
  // MASTER PHRASE as that wallet's backup even when its key is unrelated — the
  // user then backs up the wrong secret.
  "wallet_account_",
  "backup_pending_", // "this wallet's phrase was never written down" — meaningless once it is gone
  // The VIEW KEY of a watch-only wallet. `lib/watchonly.ts` calls it "the
  // wallet's entire financial history in one string", and the disclosure is
  // permanent — so leaving it behind on removal is the worst omission here.
  "watch_fvk_",
  "local_receipts_", // what this device has announced as arriving
  "last_final_balance_", // arrival baseline; revives a removed wallet's figure
  "maintenance_last_run_", // unattended-consolidation clock
  // The user's own note about what each payment WAS. This was a GLOBAL key, so it was not
  // swept at all and survived the removal of the wallet it described — and on a shielded
  // chain a label is often the entire disclosure, since the chain itself says nothing.
  "zkas_tx_labels_v1_",
];

/**
 * Per-wallet keys whose token is not a simple suffix of a fixed prefix, so they
 * need a scan rather than one `removeItem`.
 *
 * `device_seed_stray_<token>_<ts>` is the important one: `shelveMismatchedSeed`
 * writes a SPENDING KEY there, in the clear when no lock is on, and the exact-key
 * removal of `device_seed_<token>` never matched it. A removed — or explicitly
 * erased — wallet could leave its spending key on the device.
 */
function sweepScattered(token: string): void {
  // Private messages this wallet sent. Keyed inside one JSON blob rather than by
  // key name, so it needs its own removal rather than a prefix match.
  try {
    forgetSentDms(token);
  } catch {
    /* ignore */
  }
  // The Send form's saved draft: the recipient, amount and memo of a payment this wallet was
  // about to make. Global key with the token inside the value, so the prefix sweep below
  // cannot reach it — the same reason the transaction labels were missed.
  try {
    forgetSendDraft(token);
  } catch {
    /* ignore */
  }
  // Guarded: `localStorage.length` throws on a browser with site data blocked, and this is
  // "Remove wallet" — a handler that must not die partway through, leaving some of a
  // removed wallet's keys behind.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(`device_seed_stray_${token}_`)) localStorage.removeItem(k);
      // timing_<op>_<token>: the token is the suffix, not the prefix.
      else if (k.startsWith("timing_") && k.endsWith(`_${token}`)) localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable: nothing enumerable to sweep */
  }
}

/**
 * Keys that are global and must be left ALONE here.
 *
 * `app_lock_v2` is the device lock: one record holding the sealed seed of EVERY
 * wallet. Deleting it while removing one wallet would destroy the keys of all
 * the others — the caller drops just the removed wallet's entry via
 * `forgetWalletLock`. Listed explicitly so nobody adds it to the sweep below.
 */
const NEVER_TOUCH = ["app_lock_v2"];

/** The removed wallet's address, from its cached status or the registry (`wallets_v1`). */
function addressOf(token: string): string {
  try {
    const raw = localStorage.getItem(`status_cache_${token}`);
    const cached = raw ? (JSON.parse(raw) as { address?: string | null }).address : null;
    if (cached) return cached;
    return registry().find((w) => w.token === token)?.address ?? "";
  } catch {
    return "";
  }
}

function registeredElsewhere(token: string, address: string): boolean {
  return registry().some((w) => w.token !== token && w.address === address);
}

function registry(): { token: string; address?: string }[] {
  try {
    const list = JSON.parse(localStorage.getItem("wallets_v1") || "[]") as { token: string; address?: string }[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/// Every wallet token this device holds, for redacting them out of text the user may share.
///
/// walletd logs the token on a great many lines (`log::info!("wallet '{token}': …")`), the
/// embedded engine IS walletd, and its buffer is surfaced behind a Copy button whose whole
/// purpose is pasting into a support channel. A token authenticates the FVK view of a wallet:
/// every balance, every payment, every memo. Redaction has to happen before the text reaches
/// the screen, and it has to be driven by the tokens this device actually holds — by VALUE,
/// because a token's shape is a block hash's too, and the hashes are the part of a log that
/// makes it worth sending.
///
/// The two ends mint one DIFFERENTLY: the browser makes 32 hex characters (`getToken`), while
/// the desktop shell makes 32 ASCII ALPHANUMERICS (`valid_wallet_token` in
/// src-tauri/src/lib.rs) and desktop.ts writes that into this same key. `parsePairingUri`
/// already learned what a hex-only rule costs here — "32 random alphanumerics are hex only by
/// astronomical accident" — and in this function it cost more: lowercasing a mixed-case token
/// and then dropping everything non-hex left the list EMPTY on every desktop install, so the
/// Copy button and the diagnostic log's known-secret pass (src/diag/instrument.ts) had nothing
/// to redact by value at all. Each token therefore goes in as the daemon knows it, and the
/// lowercase form this used to return goes in beside it, so nothing that was redacted before
/// stops being redacted now.
export function knownWalletTokens(): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    out.add(t);
    out.add(t.toLowerCase());
  };
  const active = readLocal("wallet_token");
  if (active) add(active);
  for (const w of registry()) if (w.token) add(String(w.token));
  return [...out].filter((t) => /^[0-9a-z]{16,128}$/i.test(t));
}

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
  const t = token || readLocal("wallet_token") || "default";
  // The birthday is also kept per ADDRESS (`birthday_addr_<address>`, see
  // rememberBirthday in lib/deviceseed). Find the address before the status cache
  // that names it is gone, and leave the copy alone when another registered wallet
  // on this device still holds the same address.
  const address = addressOf(t);
  // removeLocal throughout: this runs from "Remove wallet", and a throw partway through
  // leaves some of the removed wallet's keys behind — worse than not sweeping at all. It
  // also clears what safestore holds for each key, which a raw removeItem does not.
  for (const p of PER_WALLET_PREFIXES) removeLocal(p + t);
  sweepScattered(t);
  if (address && !registeredElsewhere(t, address)) {
    removeLocal(`birthday_addr_${address}`);
    // The cross-device scan stash is keyed by ADDRESS inside a global key, so the prefix
    // sweep above cannot reach it. Adoption is already address-guarded, so a leftover could
    // not be misapplied — but it held this wallet's address and scan receipt after the user
    // removed it. Third global key found this way, after the labels and the Send draft.
    try {
      forgetScanReceipt(address);
    } catch {
      /* ignore */
    }
  }
  void NEVER_TOUCH; // documentation of intent; see the comment above

  // QR images are cached per ADDRESS, and the address of a wallet being removed
  // is not worth reconstructing just to delete one entry — sweep the prefix.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith("qr_")) removeLocal(k);
    }
  } catch {
    /* storage unavailable: no cached QR images to sweep */
  }

  // The token itself last, and ONLY if the wallet being wiped is the active one.
  //
  // This removed it unconditionally, so wiping any OTHER wallet signed the user
  // out of the one they were using: `getToken()` mints a fresh token on demand,
  // which then registers itself as a new empty wallet and becomes active. A
  // failed "Add account" rolling back its half-made wallet ejected the user into
  // a brand-new "Wallet 2" — strictly worse than the failure it was cleaning up.
  //
  // When it IS the active wallet, removal stands: on desktop the shell rotates
  // the token and hands back a new one, and in the browser a fresh one is minted
  // on demand. Either way the next wallet must not answer to the removed one's
  // name.
  const wipingActive = t === (readLocal("wallet_token") || "default");
  if (wipingActive) {
    // removeLocal, not the raw accessor. safestore holds what a blocked store refused for
    // the lifetime of the page, and a raw removeItem does not touch that copy — so on such
    // a browser the removed wallet's token came straight back on the next read, and the
    // wallet the user had just deleted answered to its own name again.
    removeLocal("wallet_token");
    // Session state belongs to the wallet that was on screen, so it only goes
    // when that is the wallet being wiped.
    sessionStorage.clear();
  }
}
