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

/**
 * Anything worth MIRRORING is worth ERASING.
 *
 * Those two lists live in different files — shouldMirror in securestore.ts, the per-wallet
 * prefixes in walletstate.ts and the device-wide keys inline in AppLockScreen's "erase this
 * device" — and nothing tied them together. They are two statements about the same set: the
 * things that survive losing localStorage, and the things an erase has to remove. If the
 * mirror protects a key the erase misses, "erase this device" leaves it in the Keychain
 * and a restore brings it back; if the erase clears one the mirror does not protect, the
 * wallet can lose it to an ordinary iOS eviction.
 *
 * `applock_v1` got into the mirror precisely because no test compared it with anything.
 */
describe("the erase path covers everything the mirror protects", () => {
  const walletstate = readFileSync("src/walletstate.ts", "utf8");
  const lockScreen = readFileSync("src/AppLockScreen.tsx", "utf8");

  const perWalletPrefixes = [...walletstate.matchAll(/^\s*"([a-z0-9_]+_)",/gim)].map((m) => m[1]);
  const deviceWide = [
    ...[...lockScreen.matchAll(/removeLocal\("([a-z0-9_]+)"\)/gi)].map((m) => m[1]),
    ...[...lockScreen.matchAll(/for \(const k of \[([^\]]+)\]\)/gi)].flatMap((m) =>
      [...m[1].matchAll(/"([a-z0-9_]+)"/gi)].map((x) => x[1]),
    ),
  ];

  const erased = (key: string) =>
    deviceWide.includes(key) || perWalletPrefixes.some((p) => key.startsWith(p));

  it("found both lists in the source", () => {
    // If a refactor moves them, this fails loudly rather than the checks below passing
    // vacuously against empty arrays.
    expect(perWalletPrefixes.length).toBeGreaterThan(5);
    expect(deviceWide.length).toBeGreaterThan(3);
  });

  it("erases every key the mirror would restore", () => {
    const mirrored = [
      "device_seed_sometoken",
      "device_mnemonic",
      "app_lock_v2",
      "app_lock_v1_sometoken",
      "seed_unsealed_sometoken",
      "mnemonic_unsealed",
      "wallets_v1",
      "wallet_account_sometoken",
      "account_high_water",
    ];
    for (const k of mirrored) {
      expect(shouldMirror(k), `${k} should be mirrored`).toBe(true);
      expect(erased(k), `${k} is mirrored but "erase this device" does not remove it`).toBe(true);
    }
  });
});
