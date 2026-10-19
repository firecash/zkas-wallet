import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resealFallbacks` converts a plaintext fallback (written when a seal raced an auto-lock,
 * flagged `seed_unsealed_*`) into a sealed entry, then deletes the cleartext.
 *
 * It used to delete the cleartext INSIDE the loop while the sealed copy existed only in a
 * JavaScript object, with `write(rec)` running once afterwards. `write` is a bare
 * `localStorage.setItem`, which a full or blocked store throws outright — the sibling test
 * `seal-failure-fallback` exists because of that exact throw. So the cleartext was gone and
 * the sealed copy had never been persisted: the seed was in NEITHER place, and the wallet was
 * recoverable only from its recovery phrase.
 *
 * `enableLock` in the same file already had the right order — seal, write, then delete — so
 * this was the one writer that didn't.
 */
const SECRET = "correct horse battery staple";
const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SEED_A = "11".repeat(32);
const SEED_B = "22".repeat(32);

async function lockedDeviceWithFallback() {
  localStorage.clear();
  vi.resetModules();
  localStorage.setItem("wallet_token", TOKEN_A);
  localStorage.setItem(`device_seed_${TOKEN_A}`, SEED_A);
  const applock = await import("../src/applock");
  await applock.enableLock(SECRET, "passphrase");
  // enableLock seals A and removes its cleartext — the correct order, which is the point.
  expect(localStorage.getItem(`device_seed_${TOKEN_A}`)).toBeNull();
  expect(localStorage.getItem("app_lock_v2")).toBeTruthy();
  // Now the state resealFallbacks exists for: a second wallet whose seal did not land, so its
  // key is sitting in the clear with a flag asking for it to be sealed on the next unlock.
  localStorage.setItem(`device_seed_${TOKEN_B}`, SEED_B);
  localStorage.setItem(`seed_unsealed_${TOKEN_B}`, "1");
  return applock;
}

describe("re-sealing a fallback never leaves the seed nowhere", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the cleartext when the lock record cannot be written", async () => {
    const applock = await lockedDeviceWithFallback();
    const real = localStorage.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((k: string, v: string) => {
      // A full store: the record refuses to save. Everything else still works.
      if (k === "app_lock_v2") throw new DOMException("QuotaExceededError");
      real(k, v);
    });

    await applock.unlock(SECRET).catch(() => undefined);

    // THE POINT: the seed must still be somewhere. Before the fix it was in neither the
    // record (never written) nor localStorage (already deleted).
    expect(localStorage.getItem(`device_seed_${TOKEN_B}`)).toBe(SEED_B);
    expect(localStorage.getItem(`seed_unsealed_${TOKEN_B}`)).toBe("1");
  });

  it("still seals and cleans up when the write succeeds", async () => {
    const applock = await lockedDeviceWithFallback();

    expect(await applock.unlock(SECRET)).toBe(true);

    // Cleartext and flag gone, and the seed is now readable from the sealed record.
    expect(localStorage.getItem(`device_seed_${TOKEN_B}`)).toBeNull();
    expect(localStorage.getItem(`seed_unsealed_${TOKEN_B}`)).toBeNull();
    const rec = JSON.parse(localStorage.getItem("app_lock_v2") || "{}");
    expect(Object.keys(rec.wallets)).toContain(TOKEN_B);
    expect(applock.allUnlockedSeeds()?.[TOKEN_B]).toBe(SEED_B);
  });

  it("drops a flag that has no seed behind it", async () => {
    const applock = await lockedDeviceWithFallback();
    localStorage.removeItem(`device_seed_${TOKEN_B}`);   // stale flag, nothing to lose

    expect(await applock.unlock(SECRET)).toBe(true);

    expect(localStorage.getItem(`seed_unsealed_${TOKEN_B}`)).toBeNull();
  });
});
