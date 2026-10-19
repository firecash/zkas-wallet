import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connection profiles are written from user actions: adding a daemon, pairing a desktop,
 * saving a mining endpoint. `walletdProfiles.save` is handed to `switchWalletd` as a
 * callback, so a raw `localStorage.setItem` throwing on a full or blocked store propagates
 * out of a switch that has ALREADY connected — failing an action that actually succeeded,
 * and leaving the user unable to add their own daemon at all.
 *
 * contacts.ts states the rule and the trap in it: go through safestore in BOTH directions,
 * because safestore keeps what a blocked store refused and a raw read would not see it, so a
 * profile would vanish the instant it was saved. Mixing the two accessors on one key is the
 * specific mistake.
 */
describe("saving a connection profile survives a blocked store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  it("does not throw out of the caller when the store refuses", async () => {
    const { walletdProfiles } = await import("../src/connection-profiles");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => walletdProfiles.save("mine", "https://d.example", "bearer")).not.toThrow();
  });

  it("still shows the profile it just saved, from the session copy", async () => {
    const { walletdProfiles } = await import("../src/connection-profiles");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    walletdProfiles.save("mine", "https://d.example");
    // A raw read here would miss what safestore held, and the row would vanish on save.
    expect(walletdProfiles.load().some((p) => p.address === "https://d.example")).toBe(true);
  });

  it("round-trips normally when the store works", async () => {
    const { walletdProfiles } = await import("../src/connection-profiles");
    walletdProfiles.save("mine", "https://d.example", "tok");
    const saved = walletdProfiles.load();
    expect(saved).toHaveLength(1);
    expect(saved[0].bearer).toBe("tok");
    walletdProfiles.remove(saved[0].id);
    expect(walletdProfiles.load()).toHaveLength(0);
  });

  it("uses no raw localStorage accessor for these keys", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/connection-profiles.ts", "utf8");
    expect(src).not.toMatch(/localStorage\.(get|set|remove)Item/);
    expect(src).toContain('from "./lib/safestore"');
  });
});
