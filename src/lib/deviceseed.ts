import { type Status } from "../api";
import { addressFromSeed, type Network } from "../signer";
import { unlockedDeviceSeed, isLockEnabled, sealNewSeed, allUnlockedSeeds } from "../applock";

/// Cheap shape test for a stored wallet secret: a legacy 64-hex seed, or a
/// recovery phrase (BIP-39 words are lowercase letters separated by spaces).
/// Deliberately permissive — callers confirm by deriving the address.
export function isSecretShaped(v: string): boolean {
  const s = v.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return true;
  const words = s.split(/\s+/);
  return words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]+$/i.test(w));
}

function deviceSeedKey(): string {
  return `device_seed_${localStorage.getItem("wallet_token") || "default"}`;
}

export function getDeviceSeed(): string {
  const unlocked = unlockedDeviceSeed();
  if (unlocked) return unlocked;
  if (isLockEnabled()) {
    const token = localStorage.getItem("wallet_token") || "default";
    if (localStorage.getItem(`seed_unsealed_${token}`)) return localStorage.getItem(deviceSeedKey()) || "";
    return "";
  }
  return localStorage.getItem(deviceSeedKey()) || "";
}

export async function setDeviceSeed(seed: string): Promise<void> {
  if (!seed) return;
  if (isLockEnabled()) {
    const token = localStorage.getItem("wallet_token") || "default";
    const ok = await sealNewSeed(token, seed);
    if (!ok) {
      // Sealing failed (device is locked). Do not write the key in plain text.
      // The caller must ask the user to unlock first and then retry.
      throw new Error(SEED_REQUIRED);
    }
    return;
  }
  localStorage.setItem(deviceSeedKey(), seed);
}

function birthdayKey(): string {
  return `birthday_${localStorage.getItem("wallet_token") || "default"}`;
}

export function rememberBirthday(daa: number): void {
  if (!(daa > 0)) return;
  try {
    localStorage.setItem(birthdayKey(), String(Math.floor(daa)));
  } catch {
    /* best-effort */
  }
}

export function walletBirthday(): number {
  const v = Number(localStorage.getItem(birthdayKey()) || "0");
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

async function findOrphanedSeed(expectedAddress: string): Promise<string> {
  const candidates = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("device_seed_")) {
      const v = localStorage.getItem(k);
      // A stored secret is either a legacy 64-hex seed or a recovery phrase.
      // Accept both shapes here: this is only a cheap pre-filter, and the
      // address-derivation check below is what actually decides. Rejecting
      // phrases here would make an orphaned mnemonic wallet unrecoverable.
      if (v && isSecretShaped(v)) candidates.add(v.trim());
    }
  }
  for (const v of Object.values(allUnlockedSeeds() ?? {})) candidates.add(v.trim());
  if (candidates.size === 0) return "";
  const net: Network = expectedAddress.startsWith("zkastest:") ? "testnet" : "mainnet";
  for (const seed of candidates) {
    try {
      if ((await addressFromSeed(seed, net)) === expectedAddress) return seed;
    } catch {
      /* not a usable seed — keep looking */
    }
  }
  return "";
}

export const SEED_REQUIRED = "SEED_REQUIRED";

export async function resolveDeviceSeed(expectedAddress?: string): Promise<string> {
  const stored = getDeviceSeed();
  if (stored) return stored;
  if (expectedAddress) {
    const orphan = await findOrphanedSeed(expectedAddress);
    if (orphan) {
      await setDeviceSeed(orphan);
      return orphan;
    }
  }
  // No custodial fallback. The wallet service is viewing-key-only and holds no
  // seed to hand back, so asking it for one could only ever help a wallet from
  // the old custodial model — at the cost of a path that pulls a spending key
  // over the network. The device asks the user to restore instead.
  throw new Error(SEED_REQUIRED);
}
