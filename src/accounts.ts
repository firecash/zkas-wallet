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

import { accountSeedHex, accountAddress } from "./signer";
import type { Network } from "./signer";
import { listWallets, type WalletRef } from "./wallets";

/// The device's master recovery phrase. Stored once, NOT per wallet — that is the
/// whole point. Per-wallet legacy seeds continue to live under `device_seed_<token>`.
const MASTER_KEY = "device_mnemonic";
/// Which account index a token maps to, for wallets derived from the phrase.
const ACCOUNT_KEY = "wallet_account_";

export function masterMnemonic(): string {
  try {
    return localStorage.getItem(MASTER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setMasterMnemonic(phrase: string): void {
  try {
    localStorage.setItem(MASTER_KEY, phrase.trim());
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

/** The lowest account index not already used by a registered wallet. */
export function nextFreeAccount(): number {
  const used = new Set<number>();
  for (const w of listWallets()) {
    const a = accountOf(w.token);
    if (a !== null) used.add(a);
  }
  let i = 0;
  while (used.has(i)) i++;
  return i;
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

/// A wallet plus how its key is obtained — used by the switcher so it can label a
/// phrase-derived wallet ("Account 2") differently from an imported standalone one.
export interface WalletOrigin extends WalletRef {
  account: number | null;
}

export function walletsWithOrigin(): WalletOrigin[] {
  return listWallets().map((w) => ({ ...w, account: accountOf(w.token) }));
}
