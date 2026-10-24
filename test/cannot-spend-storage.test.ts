import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * "This device can't spend from this address" is shown on Receive, above the address,
 * and it tells someone their funds need a recovery phrase they may think they have lost.
 * `deviceCanSign` is documented to set it only from a DEFINITE answer — `null` means
 * undecidable and stays silent.
 *
 * The gap: when a browser blocks site storage, `lib/storage-shim` substitutes an in-memory
 * store, so reads SUCCEED and return nothing. "No key found" then looked identical to a
 * device that holds no key, and the warning appeared over a wallet whose seed is on disk
 * and merely unreachable for that session.
 */
describe("deviceCanSign with no visible secrets", () => {
  beforeEach(() => {
    vi.resetModules();
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* nothing to clear */
    }
  });

  it("is UNDECIDABLE when storage is ephemeral, so the warning stays silent", async () => {
    vi.doMock("../src/lib/storage-shim", () => ({ storageIsEphemeral: () => true }));
    const { deviceCanSign } = await import("../src/lib/deviceseed");
    // A real-shaped address; no secrets are present in this environment.
    const answer = await deviceCanSign("zkas:p8ydxzxc72s72kpw6kwu3ezpnf6m4pzfeylxykg77mt4rh5ypzmszslmq9mt40588jj3yxgmm279x9n");
    expect(answer).toBeNull();
  });

  it("is still a definite no when storage is real and genuinely holds nothing", async () => {
    vi.doMock("../src/lib/storage-shim", () => ({ storageIsEphemeral: () => false }));
    const { deviceCanSign } = await import("../src/lib/deviceseed");
    const answer = await deviceCanSign("zkas:p8ydxzxc72s72kpw6kwu3ezpnf6m4pzfeylxykg77mt4rh5ypzmszslmq9mt40588jj3yxgmm279x9n");
    expect(answer).toBe(false);
  });
});
