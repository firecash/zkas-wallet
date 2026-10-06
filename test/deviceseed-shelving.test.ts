// Shelving a seed is destructive, so it needs a DEFINITE answer.
//
// `secretOwnsAddress` could not tell "this is another wallet's key" from "I
// cannot derive anything right now", and `resolveDeviceSeed` shelved on both:
// it moved `device_seed_<token>` to a `device_seed_stray_<token>_<ts>` copy and
// told the screen this device held no key. So a signer that failed to load — a
// wasm chunk 404ing after a deploy, an out-of-memory phone, an offline first
// run — detached the user's own seed from their wallet. And the stray copy was
// written in the clear even on a locked device, where the only thing that ever
// swept such copies up was `enableLock()`, which runs once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADDRESS = "zkas:p8a4neush78c56rcqraed3esy280ar2xatee3zucz39hyyxgjz80ph6mfj0430v4r3ek6qgj8dkk0ll";
const OTHER = "zkas:pxqyg2wne2q87knpg2z046azzvr6rfrlues72te646kx2ws0vmskk4q8ntweayy6ps6c9vg97fphz7y";
const SEED = "cd".repeat(32);

/** What the mocked signer does when asked to derive an address. */
let derive: (seed: string) => Promise<string>;

vi.mock("../src/signer", () => ({
  addressFromSeed: (seed: string) => derive(seed),
  accountAddress: (seed: string) => derive(seed),
  accountSeedHex: async () => SEED,
}));

/** Whether the mocked app lock is on, and whether sealing succeeds. */
let lockOn = false;
let sealOk = true;
const sealed: Record<string, string> = {};

vi.mock("../src/applock", () => ({
  isLockEnabled: () => lockOn,
  sealNewSeed: async (token: string, seedHex: string) => {
    if (!sealOk) return false;
    sealed[token] = seedHex;
    return true;
  },
  // With the lock on, the seed in hand comes from the SEALED record, unlocked for
  // this session — `getDeviceSeed()` does not read plaintext at all in that mode.
  // That is what made the old behaviour a leak and not just untidiness: it took a
  // sealed seed and wrote a plaintext copy of it.
  unlockedDeviceSeed: () => (lockOn ? SEED : null),
  allUnlockedSeeds: () => sealed,
  sealNewMnemonic: async () => true,
  unlockedMnemonic: () => null,
}));

function strayKeys(): string[] {
  return Object.keys(localStorage).filter((k) => k.startsWith("device_seed_stray_"));
}

beforeEach(() => {
  localStorage.clear();
  for (const k of Object.keys(sealed)) delete sealed[k];
  lockOn = false;
  sealOk = true;
  derive = async () => ADDRESS;
  localStorage.setItem("wallet_token", "tok");
  localStorage.setItem("device_seed_tok", SEED);
  vi.resetModules();
});

afterEach(() => localStorage.clear());

describe("resolveDeviceSeed", () => {
  it("returns the seed when it derives the wallet on screen", async () => {
    const { resolveDeviceSeed } = await import("../src/lib/deviceseed");
    await expect(resolveDeviceSeed(ADDRESS)).resolves.toBe(SEED);
    expect(localStorage.getItem("device_seed_tok")).toBe(SEED);
    expect(strayKeys()).toEqual([]);
  });

  it("leaves the seed alone when ownership cannot be decided", async () => {
    // The signer is unavailable — nothing can be derived, so nothing is known.
    derive = async () => {
      throw new Error("wasm failed to load");
    };
    const { resolveDeviceSeed, SEED_REQUIRED } = await import("../src/lib/deviceseed");
    await expect(resolveDeviceSeed(ADDRESS)).rejects.toThrow(SEED_REQUIRED);
    // The whole point: still here, still under the active token, no stray copy.
    expect(localStorage.getItem("device_seed_tok")).toBe(SEED);
    expect(strayKeys()).toEqual([]);
  });

  it("recovers on the next attempt once the signer works", async () => {
    derive = async () => {
      throw new Error("wasm failed to load");
    };
    const { resolveDeviceSeed, SEED_REQUIRED } = await import("../src/lib/deviceseed");
    await expect(resolveDeviceSeed(ADDRESS)).rejects.toThrow(SEED_REQUIRED);
    derive = async () => ADDRESS;
    await expect(resolveDeviceSeed(ADDRESS)).resolves.toBe(SEED);
  });

  it("still shelves a seed that definitely belongs to another wallet", async () => {
    // Decidable, and the answer is no: this really is someone else's key.
    derive = async () => OTHER;
    const { resolveDeviceSeed, SEED_REQUIRED } = await import("../src/lib/deviceseed");
    await expect(resolveDeviceSeed(ADDRESS)).rejects.toThrow(SEED_REQUIRED);
    expect(localStorage.getItem("device_seed_tok")).toBeNull();
    expect(strayKeys()).toHaveLength(1);
    expect(localStorage.getItem(strayKeys()[0])).toBe(SEED);
  });
});

describe("a shelved seed on a locked device", () => {
  it("is sealed, never written in the clear", async () => {
    lockOn = true;
    derive = async () => OTHER;
    const { resolveDeviceSeed, SEED_REQUIRED } = await import("../src/lib/deviceseed");
    await expect(resolveDeviceSeed(ADDRESS)).rejects.toThrow(SEED_REQUIRED);
    // No plaintext copy anywhere. This is the assertion that fails on the old code.
    expect(strayKeys()).toEqual([]);
    // Moved into the sealed record instead, under its own stray token, so the
    // orphan scan can still find it (it merges `allUnlockedSeeds()`).
    const strayToken = Object.keys(sealed).find((k) => k.startsWith("stray_"));
    expect(strayToken).toBeDefined();
    expect(sealed[strayToken as string]).toBe(SEED);
  });

  it("stays in place rather than being written in the clear when sealing fails", async () => {
    // Locked with no session secret: there is no way to seal right now. Leaving
    // the seed misfiled is recoverable; writing it in plaintext is not.
    lockOn = true;
    sealOk = false;
    derive = async () => OTHER;
    const { resolveDeviceSeed, SEED_REQUIRED } = await import("../src/lib/deviceseed");
    await expect(resolveDeviceSeed(ADDRESS)).rejects.toThrow(SEED_REQUIRED);
    expect(strayKeys()).toEqual([]);
    // Nothing was moved and nothing was sealed: the seed is still exactly where
    // it was, which is recoverable. A plaintext copy would not have been.
    expect(Object.keys(sealed)).toEqual([]);
  });
});

describe("secretOwnsAddress", () => {
  it("answers true, false and null — not just true and false", async () => {
    const { secretOwnsAddress, secretDefinitelyOwns } = await import("../src/lib/deviceseed");
    expect(await secretOwnsAddress(SEED, ADDRESS)).toBe(true);
    // A DIFFERENT secret, because a decided answer is cached per (secret, address).
    derive = async () => OTHER;
    expect(await secretOwnsAddress("ab".repeat(32), ADDRESS)).toBe(false);
    derive = async () => {
      throw new Error("no signer");
    };
    // Not cached, so this is re-asked and comes back undecidable.
    expect(await secretOwnsAddress("ef".repeat(32), ADDRESS)).toBeNull();
    // And the safe wrapper still collapses undecidable to "no".
    expect(await secretDefinitelyOwns("ef".repeat(32), ADDRESS)).toBe(false);
  });
});
