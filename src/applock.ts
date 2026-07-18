// App lock: a PIN or passphrase that ENCRYPTS the spending key at rest.
//
// The wallet is non-custodial — the seed lives on this device (localStorage),
// which on a phone means it survives in app storage and in any backup of it. A
// lock screen that merely hides the UI would leave that seed readable to anyone
// holding the device's data, so this does the thing that actually matters: the
// seed is stored sealed (PBKDF2-SHA256 600k → AES-256-GCM, the same construction
// as the backup file) and only exists in cleartext in memory, between unlock and
// lock.
//
// Consequences, stated plainly because they are the point:
//   - locked, the app holds nothing that can spend;
//   - a wrong PIN fails on the GCM tag, so there is no way to "partially" unlock;
//   - forgetting the PIN means the seed phrase or a backup file is the only way
//     back in — there is nothing to reset, because nothing knows the PIN.
//
// Biometrics fit ON TOP of this, not instead of it: a fingerprint would release
// a stored passphrase from the OS keystore, and the seed would still be sealed
// with that passphrase at rest. Nothing here needs to change to add it.

import { seal, unseal, type Sealed } from "./backup";

/// Per wallet, not global. As one global record it sealed whichever wallet was
/// active and its cleanup deleted EVERY `device_seed_*` — which, once a device
/// can hold several wallets, means locking one wallet destroys the keys of the
/// others. Keyed by token, each wallet's lock is its own.
function lockKey(): string {
  return `app_lock_v1_${localStorage.getItem("wallet_token") || "default"}`;
}
/** Re-lock after this long in the background. Phones get put down, handed over. */
const AUTO_LOCK_MS = 3 * 60 * 1000;

interface LockRecord extends Sealed {
  version: 1;
  /** "pin" | "passphrase" — only affects what the UI asks for. */
  kind: "pin" | "passphrase";
}

/** The unlocked seed, in memory only — never written back to storage. */
let unlockedSeed: string | null = null;
let backgroundedAt = 0;

function record(): LockRecord | null {
  const raw = localStorage.getItem(lockKey());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LockRecord;
  } catch {
    return null;
  }
}

/** Is the seed on this device sealed behind a PIN/passphrase? */
export function isLockEnabled(): boolean {
  return record() !== null;
}

export function lockKind(): "pin" | "passphrase" {
  return record()?.kind ?? "pin";
}

/** Unlocked in this session (seed available for signing)? */
export function isUnlocked(): boolean {
  return unlockedSeed !== null;
}

/** The seed for signing, or null while locked. */
export function unlockedDeviceSeed(): string | null {
  return unlockedSeed;
}

/**
 * Turn the lock on: seal `seedHex` under `secret` and drop every cleartext copy.
 * The caller must have the seed already (it is the wallet's own).
 */
export async function enableLock(seedHex: string, secret: string, kind: "pin" | "passphrase"): Promise<void> {
  const sealed = await seal(seedHex, secret);
  const rec: LockRecord = { version: 1, kind, ...sealed };
  localStorage.setItem(lockKey(), JSON.stringify(rec));
  clearPlaintextSeeds();
  unlockedSeed = seedHex; // stay usable for the rest of this session
}

/** Verify `secret` and hold the seed in memory for this session. */
export async function unlock(secret: string): Promise<boolean> {
  const rec = record();
  if (!rec) return false;
  const seed = await unseal(rec, secret);
  if (seed === null) return false;
  unlockedSeed = seed;
  return true;
}

/** Forget the in-memory seed. The sealed copy on disk is untouched. */
export function lock(): void {
  unlockedSeed = null;
}

/**
 * Turn the lock off, restoring the plaintext seed for the wallet's normal
 * storage. Requires the current secret — otherwise "disable the lock" would be
 * a way around it.
 */
export async function disableLock(secret: string): Promise<string | null> {
  const rec = record();
  if (!rec) return null;
  const seed = await unseal(rec, secret);
  if (seed === null) return null;
  localStorage.removeItem(lockKey());
  unlockedSeed = seed;
  return seed;
}

/** Remove the cleartext copy of THIS wallet's seed once it is sealed. Only this
 *  wallet's: the others are separate wallets whose keys are none of its business. */
function clearPlaintextSeeds(): void {
  localStorage.removeItem(`device_seed_${localStorage.getItem("wallet_token") || "default"}`);
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
