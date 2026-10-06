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
  sessionStorage.clear();
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

  it("holds the key for confirmation instead of adopting it, and scrubs the bar", async () => {
    // The link must not act on its own: opening one someone sent used to
    // register THEIR key with this device's wallet service and start scanning,
    // with nothing asked. It is now held until the user answers.
    location.hash = `#/watch?key=${FVK}&b=99`;
    const { takePendingViewKey, readPendingViewKey } = await import("../src/lib/watchadopt");
    expect(takePendingViewKey()).toEqual({ key: FVK, birthday: 99 });
    expect(watch).not.toHaveBeenCalled();
    expect(location.hash).not.toContain(FVK);
    // And it survives the reload that follows, so the question can still be asked.
    expect(readPendingViewKey()).toEqual({ key: FVK, birthday: 99 });
  });

  it("forgets a declined key", async () => {
    location.hash = `#/watch?key=${FVK}`;
    const { takePendingViewKey, clearPendingViewKey, readPendingViewKey } = await import("../src/lib/watchadopt");
    takePendingViewKey();
    clearPendingViewKey();
    expect(readPendingViewKey()).toBeNull();
    expect(watch).not.toHaveBeenCalled();
  });

  it("does not resurrect a key that is not a view key", async () => {
    sessionStorage.setItem("zkas_pending_view_key", JSON.stringify({ key: SEED, birthday: 0 }));
    const { readPendingViewKey } = await import("../src/lib/watchadopt");
    expect(readPendingViewKey()).toBeNull();
  });

  it("does nothing when the URL carries no key", async () => {
    const { takePendingViewKey } = await import("../src/lib/watchadopt");
    expect(takePendingViewKey()).toBeNull();
    expect(watch).not.toHaveBeenCalled();
  });
});
