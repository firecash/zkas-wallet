// Adopting a view key from a link. The dangerous mistakes here are adopting into
// the wallet the user already has (replacing something spendable with something
// they can only watch), and leaving the key sitting in the address bar.

import { describe, expect, it, beforeEach, vi } from "vitest";

const watch = vi.fn(async () => ({ address: "zkas:viewed" }));
vi.mock("../src/api", async (orig) => {
  const actual = await orig<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, watch: (fvk: string, b?: number) => watch(fvk, b) } };
});

const FVK = "ab".repeat(96);
const SEED = "cd".repeat(32);

beforeEach(() => {
  localStorage.clear();
  watch.mockClear();
  location.hash = "#/";
});

describe("adopting a view key", () => {
  it("registers the key and records it locally", async () => {
    const { adoptViewKey } = await import("../src/lib/watchadopt");
    const { isWatchOnly } = await import("../src/lib/watchonly");
    const address = await adoptViewKey(FVK, 1234);
    expect(address).toBe("zkas:viewed");
    expect(watch).toHaveBeenCalledWith(FVK, 1234);
    expect(isWatchOnly()).toBe(true);
  });

  it("never adopts into a wallet the user can already spend from", async () => {
    // A device with a spending wallet that opens a view link must keep its own
    // wallet: the view goes into a NEW one.
    localStorage.setItem("wallet_token", "mine");
    localStorage.setItem("device_seed_mine", SEED);
    const { adoptViewKey } = await import("../src/lib/watchadopt");
    await adoptViewKey(FVK);
    expect(localStorage.getItem("wallet_token")).not.toBe("mine");
    expect(localStorage.getItem("device_seed_mine")).toBe(SEED); // untouched
  });

  it("refuses anything that is not a view key", async () => {
    const { adoptViewKey } = await import("../src/lib/watchadopt");
    await expect(adoptViewKey(SEED)).rejects.toThrow();
    expect(watch).not.toHaveBeenCalled();
  });

  it("takes the key out of the address bar once adopted", async () => {
    location.hash = `#/watch?key=${FVK}&b=99`;
    const { adoptViewKeyFromUrl } = await import("../src/lib/watchadopt");
    expect(await adoptViewKeyFromUrl()).toBe(true);
    expect(watch).toHaveBeenCalledWith(FVK, 99);
    expect(location.hash).not.toContain(FVK);
  });

  it("scrubs the key even when registering fails", async () => {
    watch.mockRejectedValueOnce(new Error("service down"));
    location.hash = `#/watch?key=${FVK}`;
    const { adoptViewKeyFromUrl } = await import("../src/lib/watchadopt");
    await expect(adoptViewKeyFromUrl()).rejects.toThrow(/service down/);
    expect(location.hash).not.toContain(FVK);
  });

  it("does nothing when the URL carries no key", async () => {
    const { adoptViewKeyFromUrl } = await import("../src/lib/watchadopt");
    expect(await adoptViewKeyFromUrl()).toBe(false);
    expect(watch).not.toHaveBeenCalled();
  });
});
