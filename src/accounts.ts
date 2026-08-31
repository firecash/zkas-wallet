// One recovery phrase, many wallets.
//
// Before this, every wallet on the device was independent: its own random token
// AND its own secret. With recovery phrases that model is hostile — "add another
// wallet" would mean another twelve words to write down and keep safe, and a user
// who backed up only the first phrase would silently lose the rest.
//
// ZIP-32 solves it. One phrase is the device's master secret; each wallet is an
// ACCOUNT under it (`m/32'/coin'/account'`). Accounts are independent and
// unlinkable on-chain, but all of them restore from the same twelve words — so
// there is exactly ONE backup, made once, covering every wallet the user ever adds.
//
// Backward compatibility is the constraint that shapes the rest of this file. A
// wallet that predates phrases keeps its own raw seed at `device_seed_<token>`,
// and MUST keep resolving to that seed, untouched. So the secret for a wallet is
// looked up in this order:
//
//   1. `device_seed_<token>`      — a legacy or separately-imported wallet
//   2. master phrase + its account index — a wallet derived from the phrase
//
// Nothing migrates, nothing is rewritten, and an old wallet never notices.

import { accountSeedHex, accountAddress, isValidMnemonic } from "./signer";
import type { Network } from "./signer";
import { listWallets, type WalletRef } from "./wallets";
import { unlockedMnemonic, isLockEnabled, sealNewMnemonic } from "./applock";

/// The device's master recovery phrase. Stored once, NOT per wallet — that is the
/// whole point. Per-wallet legacy seeds continue to live under `device_seed_<token>`.
const MASTER_KEY = "device_mnemonic";
/// Which account index a token maps to, for wallets derived from the phrase.
const ACCOUNT_KEY = "wallet_account_";

export function masterMnemonic(): string {
  // With a lock present the phrase lives sealed; the only cleartext copy is the
  // in-memory one held for this session (null while locked). Mirrors
  // `getDeviceSeed`, so a locked device yields no phrase — and thus no account
  // spend key. The `mnemonic_unsealed` flag is the same fail-open the seed path
  // uses: a phrase whose seal raced an auto-lock stays readable so it is not lost.
  const held = unlockedMnemonic();
  if (held) return held;
  try {
    if (isLockEnabled()) {
      return localStorage.getItem("mnemonic_unsealed") ? (localStorage.getItem(MASTER_KEY) ?? "") : "";
    }
    return localStorage.getItem(MASTER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setMasterMnemonic(phrase: string): void {
  const clean = phrase.trim();
  if (!clean) return;
  // Lock on → seal it, never write the phrase in the clear. If sealing fails
  // (an auto-lock raced this write) fall back to plaintext AND flag it, so the
  // phrase survives and the state is discoverable — losing every account is a
  // worse outcome than a flagged plaintext copy. Same principle as setDeviceSeed.
  if (isLockEnabled()) {
    void sealNewMnemonic(clean).then((ok) => {
      if (!ok) {
        try {
          localStorage.setItem(MASTER_KEY, clean);
          localStorage.setItem("mnemonic_unsealed", "1");
        } catch {
          /* storage full/private — caller still holds the phrase */
        }
      }
    });
    return;
  }
  try {
    localStorage.setItem(MASTER_KEY, clean);
  } catch {
    /* storage full/private — the caller still holds the phrase to show the user */
  }
}

export function hasMaster(): boolean {
  return masterMnemonic().length > 0;
}

/** The account index this token was derived at, or null if it isn't phrase-derived. */
export function accountOf(token: string): number | null {
  try {
    const v = localStorage.getItem(ACCOUNT_KEY + token);
    if (v === null) return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function setAccountOf(token: string, account: number): void {
  try {
    localStorage.setItem(ACCOUNT_KEY + token, String(account));
    reserveAccount(account);
  } catch {
    /* best effort */
  }
}

export function clearAccountOf(token: string): void {
  try {
    localStorage.removeItem(ACCOUNT_KEY + token);
  } catch {
    /* best effort */
  }
}

/// Highest account index ever handed out on this device. It only ever goes UP.
const HWM_KEY = "account_high_water";

function highWater(): number {
  const n = Number(localStorage.getItem(HWM_KEY) ?? "-1");
  return Number.isInteger(n) ? n : -1;
}

/**
 * The next account index to use — and NEVER one that has been used before.
 *
 * Scanning only the registered wallets is not enough, because removing a wallet
 * drops it from the registry and would free its index for reuse. The next "new"
 * account would then derive the SAME key as the wallet the user just removed, and
 * its balance and history would reappear under a name suggesting a fresh account.
 * A high-water mark that only increases makes an index single-use for the life of
 * the device, so "add account" always means a genuinely new account.
 */
export function nextFreeAccount(): number {
  const used = new Set<number>();
  for (const w of listWallets()) {
    const a = accountOf(w.token);
    if (a !== null) used.add(a);
  }
  let i = highWater() + 1;
  while (used.has(i)) i++;
  return i;
}

/// Record that an index has been handed out, so it is never issued again.
export function reserveAccount(account: number): void {
  try {
    if (account > highWater()) localStorage.setItem(HWM_KEY, String(account));
  } catch {
    /* best effort */
  }
}

/**
 * The spending secret for a phrase-derived wallet, as the same 64-hex string every
 * existing code path already consumes. Returns "" when this token is not derived
 * from the master phrase (legacy/imported wallets resolve their own stored seed).
 */
export async function derivedSecret(token: string): Promise<string> {
  const phrase = masterMnemonic();
  const account = accountOf(token);
  if (!phrase || account === null) return "";
  return accountSeedHex(phrase, account);
}

/** Address of an account of the master phrase, for previews and discovery. */
export async function addressOfAccount(account: number, network: Network): Promise<string> {
  const phrase = masterMnemonic();
  if (!phrase) return "";
  return accountAddress(phrase, network, account);
}

/**
 * Adopt the wallet this device already holds as account 0 of the master phrase.
 *
 * Without this, accounts never switch on for anyone who already had a wallet: the
 * master is only written when a wallet is CREATED, so an existing user's "add
 * wallet" kept falling back to the old independent-wallet behaviour and the whole
 * feature was invisible to them.
 *
 * Two cases:
 *  - the stored secret IS a recovery phrase (any wallet made since phrases shipped)
 *    -> promote it to master and mark this wallet account 0. Nothing else changes:
 *       the derived account-0 key is the same key the wallet already uses.
 *  - the stored secret is a legacy 64-hex seed -> leave it completely alone. A raw
 *    key cannot be turned into a phrase (the words encode the entropy, and that
 *    entropy is gone), so pretending otherwise would be a lie. That wallet keeps
 *    working exactly as before; any wallet added later starts a phrase of its own.
 *
 * Safe to call on every boot: it does nothing once a master exists.
 */
export async function adoptExistingPhrase(token: string, secret: string): Promise<void> {
  if (hasMaster() || !token || !secret.trim()) return;
  const phrase = secret.trim();
  // Only a real, checksum-valid phrase may become the master.
  if (!(await isValidMnemonic(phrase))) return;
  setMasterMnemonic(phrase);
  if (accountOf(token) === null) setAccountOf(token, 0);
}

/// A wallet plus how its key is obtained — used by the switcher so it can label a
/// phrase-derived wallet ("Account 2") differently from an imported standalone one.
export interface WalletOrigin extends WalletRef {
  account: number | null;
}

export function walletsWithOrigin(): WalletOrigin[] {
  return listWallets().map((w) => ({ ...w, account: accountOf(w.token) }));
}
