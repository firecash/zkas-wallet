// Opening a view-only link on a fresh phone browser. This is the path the user
// actually walks, and none of the unit tests touch it.

import { describe, expect, it, beforeEach, vi } from "vitest";

const watch = vi.fn(async () => ({ address: "zkas:viewer" }));
vi.mock("../src/api", async (orig) => {
  const actual = await orig<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, watch } };
});

const FVK = "ab".repeat(96);
const SEED = "cd".repeat(32);

beforeEach(() => {
  localStorage.clear();
  watch.mockClear();
  location.hash = "#/";
});

describe("adopting a view key from a link", () => {
  it("registers the key and leaves the device unable to spend", async () => {
    location.hash = `#/watch?key=${FVK}`;
    const { adoptViewKeyFromUrl } = await import("../src/lib/watchadopt");
    const { isWatchOnly, watchKey } = await import("../src/lib/watchonly");

    expect(await adoptViewKeyFromUrl()).toBe(true);
    expect(watch).toHaveBeenCalledWith(FVK, 0);
    expect(watchKey()).toBe(FVK);
    expect(isWatchOnly()).toBe(true);
  });

  it("scrubs the key from the address bar once adopted", async () => {
    location.hash = `#/watch?key=${FVK}`;
    const { adoptViewKeyFromUrl } = await import("../src/lib/watchadopt");
    await adoptViewKeyFromUrl();
    // The fragment never reaches a server, but leaving it on screen invites it
    // into a screenshot or a synced tab.
    expect(location.hash).not.toContain(FVK);
  });

  it("does nothing at all when the URL carries no key", async () => {
    const { adoptViewKeyFromUrl } = await import("../src/lib/watchadopt");
    expect(await adoptViewKeyFromUrl()).toBe(false);
    expect(watch).not.toHaveBeenCalled();
  });

  it("refuses a seed pasted where a view key belongs", async () => {
    const { adoptViewKey } = await import("../src/lib/watchadopt");
    await expect(adoptViewKey(SEED)).rejects.toThrow(/view key/i);
    expect(watch).not.toHaveBeenCalled();
  });

  it("never adopts into the wallet already on this device", async () => {
    // A phone that already holds a spending wallet must not have it replaced by
    // a wallet it can only watch.
    localStorage.setItem("wallet_token", "mine");
    localStorage.setItem("device_seed_mine", SEED);
    const { adoptViewKey } = await import("../src/lib/watchadopt");
    await adoptViewKey(FVK);

    expect(localStorage.getItem("wallet_token")).not.toBe("mine");
    expect(localStorage.getItem("device_seed_mine")).toBe(SEED); // untouched
    const { isWatchOnly } = await import("../src/lib/watchonly");
    expect(isWatchOnly()).toBe(true);   // the NEW wallet is the viewer
  });

  it("scrubs the URL even if registering fails", async () => {
    watch.mockRejectedValueOnce(new Error("service unreachable"));
    location.hash = `#/watch?key=${FVK}`;
    const { adoptViewKeyFromUrl } = await import("../src/lib/watchadopt");
    await expect(adoptViewKeyFromUrl()).rejects.toThrow();
    expect(location.hash).not.toContain(FVK);
  });
});
