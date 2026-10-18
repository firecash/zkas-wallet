import { beforeEach, describe, expect, it, vi } from "vitest";

const { addressFromSeed, accountAddress, accountSeedHex } = vi.hoisted(() => ({
  addressFromSeed: vi.fn(),
  accountAddress: vi.fn(),
  accountSeedHex: vi.fn(async (s: string) => s),
}));
vi.mock("../src/signer", () => ({ addressFromSeed, accountAddress, accountSeedHex }));

import { deviceCanSign } from "../src/lib/deviceseed";

const OTHER = "zkas:p" + "b".repeat(80);
/**
 * A FRESH address per case. `secretOwnsAddress` memoises per (secret, address) on purpose
 * — the resolver runs on every send and status refresh — and that cache is module-level,
 * so reusing one address let an earlier case's answer decide a later one. The first draft
 * of these tests "passed" on a stale `true`.
 */
let n = 0;
const freshMine = () => `zkas:p${String(n++).padStart(3, "0")}${"a".repeat(77)}`;

/**
 * "Can anything on this device spend what arrives at this address?"
 *
 * Read by the Receive screen, which until now showed an address with no hint that the key
 * for it was missing — the mismatch only surfaced at "Confirm & send", after someone could
 * already have funded it.
 *
 * The three states are the whole point. A wrong "can't spend" on a healthy wallet is worse
 * than the late failure it replaces, so anything short of a definite answer must stay
 * silent.
 */
describe("deviceCanSign", () => {
  beforeEach(() => {
    localStorage.clear();
    addressFromSeed.mockReset();
    accountAddress.mockReset();
  });

  it("is true when a stored secret derives the address", async () => {
    const MINE = freshMine();
    localStorage.setItem("device_seed_tok1", "ab".repeat(32));
    addressFromSeed.mockResolvedValue(MINE);
    await expect(deviceCanSign(MINE)).resolves.toBe(true);
  });

  it("is false when every stored secret derives something else", async () => {
    const MINE = freshMine();
    localStorage.setItem("device_seed_tok1", "cd".repeat(32));
    addressFromSeed.mockResolvedValue(OTHER);
    await expect(deviceCanSign(MINE)).resolves.toBe(false);
  });

  it("finds a key filed under ANOTHER token, which is not a mismatch", async () => {
    const MINE = freshMine();
    // The key sitting under a stale token is an ordinary state the app repairs silently;
    // reporting it as "cannot spend" would be a false alarm on a recoverable wallet.
    localStorage.setItem("device_seed_tok1", "cd".repeat(32));
    localStorage.setItem("device_seed_tok2", "ab".repeat(32));
    addressFromSeed.mockImplementation(async (s: string) => (s === "ab".repeat(32) ? MINE : OTHER));
    await expect(deviceCanSign(MINE)).resolves.toBe(true);
  });

  it("is NULL, never false, when the signer cannot answer", async () => {
    const MINE = freshMine();
    // The safety property. An unavailable signer must not be read as a missing key.
    localStorage.setItem("device_seed_tok1", "ab".repeat(32));
    addressFromSeed.mockRejectedValue(new Error("signer not ready"));
    await expect(deviceCanSign(MINE)).resolves.toBeNull();
  });

  it("stays null when ONE candidate is undecidable, even if another says no", async () => {
    const MINE = freshMine();
    // The undecidable one may be the owner, so no definite answer exists yet.
    localStorage.setItem("device_seed_tok1", "cd".repeat(32));
    localStorage.setItem("device_seed_tok2", "ef".repeat(32));
    addressFromSeed.mockImplementation(async (s: string) => {
      if (s === "cd".repeat(32)) return OTHER;
      throw new Error("signer not ready");
    });
    await expect(deviceCanSign(MINE)).resolves.toBeNull();
  });

  it("is false when the device holds nothing at all", async () => {
    const MINE = freshMine();
    await expect(deviceCanSign(MINE)).resolves.toBe(false);
  });

  it("says nothing without an address", async () => {
    await expect(deviceCanSign("")).resolves.toBeNull();
  });
});
