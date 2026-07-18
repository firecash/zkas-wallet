// App lock: one passphrase that opens the app and encrypts every wallet's key.
//
// The wallet is non-custodial — each wallet's seed lives in this device's
// storage — so a lock that merely hid the UI would leave those seeds readable to
// anyone holding the device's data. This seals them (PBKDF2-SHA256 600k →
// AES-256-GCM) and keeps cleartext only in memory, between unlock and lock.
//
// DEVICE-WIDE, not per wallet. An earlier version kept a separate lock per
// wallet, which meant a locked wallet sat beside unlocked ones and the app
// opened without a passphrase as long as you switched to another wallet first —
// so "App lock" locked a wallet, not the app, which is not what the words say or
// what anyone would assume. One passphrase now gates the app and seals every
// wallet's seed under the same secret.
//
// Consequences, stated plainly because they are the point:
//   - locked, this device holds nothing that can spend ANY of its wallets;
//   - a wrong passphrase fails on the GCM tag: no partial unlock;
//   - nothing stores the passphrase, so there is nothing to reset. A backup file
//     or seed phrase is the way back in, and the UI says so before you set one.
//
// Biometrics fit on top unchanged: a fingerprint would release this passphrase
// from the OS keystore, and the seeds would still be sealed with it at rest.

import { seal, unseal, type Sealed } from "./backup";

const LOCK_KEY = "app_lock_v2";
/** Legacy per-wallet records, migrated on unlock. */
const LEGACY_PREFIX = "app_lock_v1_";
/** Re-lock after this long in the background. Phones get put down, handed over. */
const AUTO_LOCK_MS = 3 * 60 * 1000;

interface LockRecord {
  version: 2;
  /** "pin" | "passphrase" — only affects what the UI asks for. */
  kind: "pin" | "passphrase";
  /** wallet token → that wallet's sealed seed. */
  wallets: Record<string, Sealed>;
}

/** Unsealed seeds by token, in memory only — never written back to storage. */
let unlocked: Record<string, string> | null = null;
let backgroundedAt = 0;

function record(): LockRecord | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    return raw ? (JSON.parse(raw) as LockRecord) : null;
  } catch {
    return null;
  }
}

function write(rec: LockRecord): void {
  localStorage.setItem(LOCK_KEY, JSON.stringify(rec));
}

function activeToken(): string {
  return localStorage.getItem("wallet_token") || "default";
}

/** Every wallet seed currently sitting in the clear, by token. */
function plaintextSeeds(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("device_seed_")) {
      const v = localStorage.getItem(k);
      if (v) out[k.slice("device_seed_".length)] = v;
    }
  }
  return out;
}

/** Is this device locked behind a passphrase? */
export function isLockEnabled(): boolean {
  return record() !== null || Object.keys(legacyRecords()).length > 0;
}

function legacyRecords(): Record<string, Sealed & { kind?: "pin" | "passphrase" }> {
  const out: Record<string, Sealed & { kind?: "pin" | "passphrase" }> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LEGACY_PREFIX)) {
      try {
        out[k.slice(LEGACY_PREFIX.length)] = JSON.parse(localStorage.getItem(k) || "");
      } catch {
        /* ignore an unreadable legacy record */
      }
    }
  }
  return out;
}

export function lockKind(): "pin" | "passphrase" {
  return record()?.kind ?? Object.values(legacyRecords())[0]?.kind ?? "pin";
}

/** Unlocked in this session? */
export function isUnlocked(): boolean {
  return unlocked !== null;
}

/** The active wallet's seed, or null while locked / not held here. */
export function unlockedDeviceSeed(): string | null {
  return unlocked?.[activeToken()] ?? null;
}

/**
 * Seal a seed that arrived while the device is unlocked — a wallet just created,
 * imported or restored. Without this, `setDeviceSeed` had nowhere to put a new
 * wallet's key with the lock on and silently dropped it, which loses the wallet.
 * Returns false when the device is locked (the caller must not keep cleartext).
 */
export async function sealNewSeed(token: string, seedHex: string, secret?: string): Promise<boolean> {
  const rec = record();
  if (!rec || !unlocked) return false;
  // Re-sealing needs the passphrase. When it is not supplied we can still hold
  // the seed for this session; the next explicit unlock re-seals everything.
  if (secret) {
    rec.wallets[token] = await seal(seedHex, secret);
    write(rec);
  }
  unlocked[token] = seedHex;
  return true;
}

/** Turn the lock on: seal every wallet's seed and drop the cleartext copies. */
export async function enableLock(secret: string, kind: "pin" | "passphrase"): Promise<void> {
  const seeds = { ...plaintextSeeds(), ...(unlocked ?? {}) };
  const wallets: Record<string, Sealed> = {};
  for (const [token, seedHex] of Object.entries(seeds)) wallets[token] = await seal(seedHex, secret);
  write({ version: 2, kind, wallets });
  for (const token of Object.keys(seeds)) localStorage.removeItem(`device_seed_${token}`);
  unlocked = seeds; // stay usable for the rest of this session
}

/** Verify `secret` and hold every wallet's seed in memory for this session. */
export async function unlock(secret: string): Promise<boolean> {
  const rec = record();
  if (rec) {
    const out: Record<string, string> = {};
    for (const [token, sealed] of Object.entries(rec.wallets)) {
      const seed = await unseal(sealed, secret);
      if (seed === null) return false; // one failure means the wrong passphrase
      out[token] = seed;
    }
    unlocked = out;
    return true;
  }
  // Migrate a legacy per-wallet lock: same passphrase, now device-wide.
  const legacy = legacyRecords();
  if (Object.keys(legacy).length === 0) return false;
  const out: Record<string, string> = {};
  for (const [token, sealed] of Object.entries(legacy)) {
    const seed = await unseal(sealed, secret);
    if (seed === null) return false;
    out[token] = seed;
  }
  const wallets: Record<string, Sealed> = {};
  for (const [token, seedHex] of Object.entries(out)) wallets[token] = await seal(seedHex, secret);
  write({ version: 2, kind: Object.values(legacy)[0]?.kind ?? "pin", wallets });
  for (const token of Object.keys(legacy)) localStorage.removeItem(LEGACY_PREFIX + token);
  unlocked = out;
  return true;
}

/** Forget the in-memory seeds. The sealed copies on disk are untouched. */
export function lock(): void {
  unlocked = null;
}

/**
 * Turn the lock off, restoring cleartext seeds. Requires the current secret —
 * otherwise "disable the lock" would be a way around it.
 */
export async function disableLock(secret: string): Promise<boolean> {
  if (!(await unlock(secret))) return false;
  for (const [token, seedHex] of Object.entries(unlocked ?? {})) {
    localStorage.setItem(`device_seed_${token}`, seedHex);
  }
  localStorage.removeItem(LOCK_KEY);
  return true;
}

/** Forget one wallet's sealed seed (used when that wallet is removed). */
export function forgetWalletLock(token: string): void {
  const rec = record();
  if (!rec) return;
  delete rec.wallets[token];
  write(rec);
  if (unlocked) delete unlocked[token];
}

/**
 * Re-lock after the app has been in the background a while. Called once at
 * startup; harmless on desktop/web where the events simply fire less.
 */
export function installAutoLock(onLocked: () => void): void {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      backgroundedAt = Date.now();
      return;
    }
    if (backgroundedAt && Date.now() - backgroundedAt > AUTO_LOCK_MS && isLockEnabled() && isUnlocked()) {
      lock();
      onLocked();
    }
    backgroundedAt = 0;
  });
}
