import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * When sealing a secret FAILS, the plaintext fallback must still be written.
 *
 * setDeviceSeed's own comment records why: the old drop-the-key behaviour left a freshly
 * created wallet with no spendable key after reload, and the coins already sent to it were
 * unrecoverable (issue #4 / PR #8). The fallback is the deliberate lesser evil and it
 * self-heals — resealFallbacks re-seals it and deletes the cleartext on the next unlock.
 *
 * That defence handled a RESOLVED false and not a REJECTION. `sealNewSeed` has two ways to
 * reject: `await seal(...)` is WebCrypto, and the `write(rec)` after it is an unguarded
 * localStorage.setItem which throws on a full or blocked store. So on a storage-full device
 * the seal threw, the `.then` never ran, the fallback was never written, and the key was
 * neither sealed nor stored — the exact loss the comment warns about, through the one door
 * nobody had closed.
 */
describe("a seal that REJECTS still leaves the key recoverable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
  });

  it("writes the plaintext fallback when the lock record cannot be stored", async () => {
    // A real lock record, so isLockEnabled() is true and the seal path is taken.
    localStorage.setItem(
      "app_lock_v2",
      JSON.stringify({ v: 2, kind: "pin", wallets: { x: { ct: "a", iv: "b", salt: "c" } } }),
    );
    const applock = await import("../src/applock");
    // Seal rejects, exactly as it does when write()'s setItem throws on a full store.
    vi.spyOn(applock, "sealNewSeed").mockRejectedValue(new DOMException("QuotaExceededError"));

    const { setDeviceSeed } = await import("../src/App");
    const seed = "ab".repeat(32);
    setDeviceSeed(seed);
    await new Promise((r) => setTimeout(r, 0));   // let the rejection settle

    // The key survives, flagged, rather than vanishing.
    expect(localStorage.getItem("device_seed_0123456789abcdef0123456789abcdef")).toBe(seed);
    expect(localStorage.getItem("seed_unsealed_0123456789abcdef0123456789abcdef")).toBe("1");
  });

  it("still writes it when the seal merely RESOLVES false", async () => {
    // The case that was already handled; pinned so the refactor to a shared `fallback`
    // did not lose it.
    localStorage.setItem(
      "app_lock_v2",
      JSON.stringify({ v: 2, kind: "pin", wallets: { x: { ct: "a", iv: "b", salt: "c" } } }),
    );
    const applock = await import("../src/applock");
    vi.spyOn(applock, "sealNewSeed").mockResolvedValue(false);

    const { setDeviceSeed } = await import("../src/App");
    const seed = "cd".repeat(32);
    setDeviceSeed(seed);
    await new Promise((r) => setTimeout(r, 0));

    expect(localStorage.getItem("device_seed_0123456789abcdef0123456789abcdef")).toBe(seed);
  });
});
