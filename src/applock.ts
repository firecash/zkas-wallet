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

interface LockRecord {
  version: 2;
  /** "pin" | "passphrase" — only affects what the UI asks for. */
  kind: "pin" | "passphrase";
  /** wallet token → that wallet's sealed seed. */
  wallets: Record<string, Sealed>;
  /** The device master recovery phrase (ZIP-32), sealed under the same secret.
   * Derives EVERY account, so it must be sealed exactly like a per-wallet seed;
   * leaving it in plaintext (its original home, `device_mnemonic`) let a locked
   * device still yield every account's spend key. Optional: absent on records
   * written before this field existed and on devices with no phrase. */
  mnemonic?: Sealed;
}

/** Unsealed seeds by token, in memory only — never written back to storage. */
let unlocked: Record<string, string> | null = null;
/** The master recovery phrase, in memory only for this session (null while
 * locked). Mirrors `unlocked`: sealed at rest, cleartext only between unlock
 * and lock. `accounts.ts` reads it through `unlockedMnemonic()`. */
let sessionMnemonic: string | null = null;
/** Where the phrase lives in the clear when there is no lock. Kept in sync with
 * `accounts.ts`'s own `MASTER_KEY`. */
const MNEMONIC_KEY = "device_mnemonic";
const MNEMONIC_UNSEALED_FLAG = "mnemonic_unsealed";
/**
 * The passphrase for this session, in memory only.
 *
 * Held because a wallet can be CREATED while the device is unlocked, and sealing
 * its seed requires the secret. Without it `sealNewSeed` could only keep the key
 * in RAM — so the wallet worked until reload and then had no key at all, which
 * is the fund-loss this lock exists to avoid causing. Cleared by `lock()`, and
 * never written anywhere.
 */
let sessionSecret: string | null = null;

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

/** The master recovery phrase held for this session, or null while locked /
 * none set. `accounts.ts` prefers this over the plaintext key whenever a lock
 * exists, so a locked device exposes no phrase. */
export function unlockedMnemonic(): string | null {
  return sessionMnemonic;
}

/** Every unsealed seed this session, by token (null while locked). Lets the
 * wallet recover a seed orphaned under a stale token — see findOrphanedSeed. */
export function allUnlockedSeeds(): Record<string, string> | null {
  return unlocked;
}

/**
 * Seal a seed that arrived while the device is unlocked — a wallet just created,
 * imported or restored. Without this, `setDeviceSeed` had nowhere to put a new
 * wallet's key with the lock on and silently dropped it, which loses the wallet.
 * Returns false when the device is locked (the caller must not keep cleartext).
 */
export async function sealNewSeed(token: string, seedHex: string, secret?: string): Promise<boolean> {
  const rec = record();
  const key = secret ?? sessionSecret;
  if (!rec || !unlocked || !key) return false;
  rec.wallets[token] = await seal(seedHex, key);
  write(rec);
  unlocked[token] = seedHex;
  return true;
}

/** Seal a phrase that arrived (or changed) while the device is unlocked. Mirrors
 * `sealNewSeed`. Returns false when locked, so the caller keeps the plaintext
 * fallback rather than dropping the phrase (a dropped phrase loses every account). */
export async function sealNewMnemonic(phrase: string, secret?: string): Promise<boolean> {
  const rec = record();
  const key = secret ?? sessionSecret;
  if (!rec || unlocked === null || !key) return false;
  rec.mnemonic = await seal(phrase, key);
  write(rec);
  sessionMnemonic = phrase;
  return true;
}

/** Re-seal any plaintext-fallback seed/phrase (written when a seal raced an
 * auto-lock, flagged `seed_unsealed_*` / `mnemonic_unsealed`) now that the
 * secret is verified and held, and remove the cleartext. Best-effort and
 * idempotent — a wallet with no fallback is untouched. */
async function resealFallbacks(secret: string): Promise<void> {
  const rec = record();
  if (!rec) return;
  let changed = false;
  const flags: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("seed_unsealed_")) flags.push(k);
  }
  for (const flag of flags) {
    const token = flag.slice("seed_unsealed_".length);
    const seedHex = localStorage.getItem(`device_seed_${token}`);
    if (seedHex) {
      rec.wallets[token] = await seal(seedHex, secret);
      if (unlocked) unlocked[token] = seedHex;
      localStorage.removeItem(`device_seed_${token}`);
      changed = true;
    }
    localStorage.removeItem(flag);
  }
  if (localStorage.getItem(MNEMONIC_UNSEALED_FLAG)) {
    const phrase = localStorage.getItem(MNEMONIC_KEY);
    if (phrase) {
      rec.mnemonic = await seal(phrase, secret);
      sessionMnemonic = phrase;
      localStorage.removeItem(MNEMONIC_KEY);
      changed = true;
    }
    localStorage.removeItem(MNEMONIC_UNSEALED_FLAG);
  }
  if (changed) write(rec);
}

/** Turn the lock on: seal every wallet's seed and drop the cleartext copies. */
export async function enableLock(secret: string, kind: "pin" | "passphrase"): Promise<void> {
  const seeds = { ...plaintextSeeds(), ...(unlocked ?? {}) };
  const wallets: Record<string, Sealed> = {};
  for (const [token, seedHex] of Object.entries(seeds)) wallets[token] = await seal(seedHex, secret);
  const phrase = sessionMnemonic ?? localStorage.getItem(MNEMONIC_KEY) ?? "";
  const rec: LockRecord = { version: 2, kind, wallets };
  if (phrase) rec.mnemonic = await seal(phrase, secret);
  write(rec);
  for (const token of Object.keys(seeds)) {
    localStorage.removeItem(`device_seed_${token}`);
    localStorage.removeItem(`seed_unsealed_${token}`); // sealed properly now — the fallback flag must not outlive it
  }
  // The phrase is now sealed in the record; its plaintext home must not remain.
  localStorage.removeItem(MNEMONIC_KEY);
  localStorage.removeItem(MNEMONIC_UNSEALED_FLAG);
  unlocked = seeds; // stay usable for the rest of this session
  sessionMnemonic = phrase || null;
  sessionSecret = secret;
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
    if (rec.mnemonic) {
      const phrase = await unseal(rec.mnemonic, secret);
      if (phrase === null) return false;
      sessionMnemonic = phrase;
    } else {
      // Migration: a phrase set before this field existed still sits in the
      // clear. Seal it under the now-verified secret and remove the plaintext.
      const legacyPhrase = localStorage.getItem(MNEMONIC_KEY);
      if (legacyPhrase) {
        rec.mnemonic = await seal(legacyPhrase, secret);
        write(rec);
        localStorage.removeItem(MNEMONIC_KEY);
        localStorage.removeItem(MNEMONIC_UNSEALED_FLAG);
        sessionMnemonic = legacyPhrase;
      }
    }
    unlocked = out;
    sessionSecret = secret;
    // OB-ZKW-02: heal any plaintext fallback written when a seal raced an
    // auto-lock. Now that the secret is verified and held, re-seal those seeds
    // and the phrase and drop their cleartext, so a flagged-but-unsealed key
    // does not linger in storage indefinitely.
    await resealFallbacks(secret);
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
  sessionSecret = secret;
  return true;
}

/** Forget the in-memory seeds. The sealed copies on disk are untouched. */
export function lock(): void {
  unlocked = null;
  sessionMnemonic = null;
  sessionSecret = null;
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
  if (sessionMnemonic) localStorage.setItem(MNEMONIC_KEY, sessionMnemonic);
  localStorage.removeItem(LOCK_KEY);
  sessionSecret = null;
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
 * Compatibility hook for the app boot sequence. Automatic background locking
 * is intentionally disabled; explicit lock still works.
 */
export function installAutoLock(onLocked: () => void): void {
  // Automatic background locking is disabled. The user can still lock the app
  // explicitly; keeping this hook as a no-op preserves the boot API and avoids
  // surprise relocks while switching tabs or returning to a mobile app.
  void onLocked;
}
