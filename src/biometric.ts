// Fingerprint (and face) unlock, layered on top of the app lock — see applock.ts.
//
// The app lock already seals every wallet's seed with a SECRET (PIN/passphrase) and
// holds it only in memory between unlock and lock. Biometrics change nothing about that
// seal: they are just a second way to release that same secret. A fingerprint proves the
// device owner is present, the OS hands back the stored secret, and `unlock(secret)` runs
// exactly as if it had been typed. The seeds stay sealed under the secret at rest, so a
// stolen device with no live fingerprint still holds nothing that can spend.
//
// The passphrase path is NEVER removed: biometric hardware can be absent, unenrolled, or
// locked out after too many failures, and a wallet must never become unspendable because a
// sensor said no. Everything here degrades to "fall back to typing the secret".
//
// Security note: `setCredentials` stores the secret in the platform's encrypted store, and
// `verifyIdentity` gates retrieval behind a real biometric prompt. This is the plugin's
// model; the secret is never in web storage and never leaves the device.

import { Capacitor } from "@capacitor/core";
import { NativeBiometric } from "capacitor-native-biometric";
import { unlock } from "./applock";

/** Namespaces the stored secret in the OS credential store. */
const SERVER = "info.zkas.wallet.applock";
/** Set once the user has bound their secret to this device's biometric. */
const FLAG = "biometric_unlock_enabled";

/** Has the user turned fingerprint unlock on (a stored secret should exist)? */
export function isBiometricConfigured(): boolean {
  return localStorage.getItem(FLAG) === "1";
}

/** Does this device have usable, enrolled biometric hardware right now? */
export async function isBiometricAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const r = await NativeBiometric.isAvailable();
    return !!r.isAvailable;
  } catch {
    return false;
  }
}

/**
 * Bind the app-lock secret to this device's biometric.
 *
 * Verifies the secret first (via `unlock`) so a wrong secret can never be stored — a
 * fingerprint that unsealed nothing would be worse than useless. Returns false when
 * biometrics are unavailable or the secret is wrong; the caller keeps the toggle off.
 */
export async function enableBiometricUnlock(secret: string): Promise<boolean> {
  if (!(await isBiometricAvailable())) return false;
  // 1. The secret must be correct — never store one that unseals nothing.
  if (!(await unlock(secret))) return false;
  // 2. A real fingerprint scan must succeed HERE, at enrol time. This binds unlock to a
  //    finger that is present now (not just "someone typed the PIN"), and it is the same
  //    gate that will guard retrieval later — so enabling and using prove the same thing.
  try {
    await NativeBiometric.verifyIdentity({
      title: "Enable fingerprint unlock",
      subtitle: "Confirm your fingerprint",
      description: "Link this fingerprint to unlock ZKas",
    });
  } catch {
    return false; // no scan, no binding — the PIN stays the only way in
  }
  await NativeBiometric.setCredentials({ username: "applock", password: secret, server: SERVER });
  localStorage.setItem(FLAG, "1");
  return true;
}

/** Turn fingerprint unlock off and erase the stored secret. Safe to call redundantly. */
export async function disableBiometricUnlock(): Promise<void> {
  localStorage.removeItem(FLAG);
  try {
    await NativeBiometric.deleteCredentials({ server: SERVER });
  } catch {
    /* nothing was stored — fine */
  }
}

/**
 * Prompt for a fingerprint, retrieve the secret, and unlock.
 *
 * Returns true only when the app is actually unlocked. Any cancel, failure, or missing
 * credential returns false so the lock screen simply keeps showing the passphrase field.
 */
export async function unlockWithBiometric(): Promise<boolean> {
  if (!isBiometricConfigured() || !(await isBiometricAvailable())) return false;
  try {
    await NativeBiometric.verifyIdentity({
      title: "Unlock ZKas",
      subtitle: "Confirm your fingerprint",
      description: "Unlock your wallet on this device",
    });
  } catch {
    return false; // cancelled, failed, or locked out — fall back to the passphrase
  }
  try {
    const creds = await NativeBiometric.getCredentials({ server: SERVER });
    if (!creds?.password) return false;
    return await unlock(creds.password);
  } catch {
    return false;
  }
}
