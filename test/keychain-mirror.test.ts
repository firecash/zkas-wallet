import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldMirror } from "../src/securestore";

/**
 * On iOS, localStorage is evictable website data — the system can empty it — and this
 * mirror is the copy that survives. So the set of mirrored keys IS the set of things a
 * wallet can lose, and it was wrong: it listed "applock_v1", a key that exists nowhere in
 * the app. The real record is `app_lock_v2`.
 *
 * That is a total loss path, not an inconvenience. With the lock ON the seed is sealed
 * INSIDE the lock record and the cleartext device_seed_ copy is deleted, so mirroring
 * device_seed_ captured nothing while the sealed copy was not mirrored at all. One eviction
 * and a locked wallet was unrecoverable without its recovery phrase.
 *
 * These assertions read the REAL constants out of the source, so renaming a key without
 * updating the mirror fails here rather than on somebody's phone.
 */
const applock = readFileSync("src/applock.ts", "utf8");
const constant = (name: string) => {
  const m = new RegExp(`const ${name} = "([^"]+)"`).exec(applock);
  if (!m) throw new Error(`${name} not found in applock.ts`);
  return m[1];
};

describe("the Keychain mirror covers everything a locked wallet needs", () => {
  it("mirrors the CURRENT lock record, by its real name", () => {
    const key = constant("LOCK_KEY");
    expect(key).toBe("app_lock_v2");           // if this changes, the next line is why it matters
    expect(shouldMirror(key), `${key} is not mirrored`).toBe(true);
  });

  it("mirrors legacy lock records too", () => {
    const prefix = constant("LEGACY_PREFIX");
    expect(shouldMirror(`${prefix}sometoken`), `${prefix}* is not mirrored`).toBe(true);
  });

  it("mirrors the phrase and its unsealed flag", () => {
    expect(shouldMirror(constant("MNEMONIC_KEY"))).toBe(true);
    expect(shouldMirror(constant("MNEMONIC_UNSEALED_FLAG"))).toBe(true);
  });

  it("mirrors a seed AND the flag that makes it readable", () => {
    // getDeviceSeed only returns the plaintext fallback when the flag is present, so a
    // seed restored without its flag is a key the app refuses to use.
    expect(shouldMirror("device_seed_abc")).toBe(true);
    expect(shouldMirror("seed_unsealed_abc")).toBe(true);
  });

  it("mirrors the wallet registry and account bookkeeping", () => {
    expect(shouldMirror("wallets_v1")).toBe(true);
    expect(shouldMirror("wallet_account_abc")).toBe(true);
    expect(shouldMirror("account_high_water")).toBe(true);
  });

  it("does NOT mirror things that are caches or preferences", () => {
    // The Keychain is small and shared; only what cannot be rebuilt belongs in it.
    for (const k of ["qr_zkas:abc", "status_cache_abc", "theme", "local_txs_abc", "contacts_abc", "walletd_base"]) {
      expect(shouldMirror(k), `${k} should not be mirrored`).toBe(false);
    }
  });
});
