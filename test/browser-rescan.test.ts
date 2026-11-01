import { describe, it, expect, beforeEach, vi } from "vitest";

// Rescan / recover history was refused in browser mode, so a browser wallet could not be
// rebuilt at all. It now runs on the page: the checkpoint goes, the engine restarts from the
// chosen birthday (genesis when none, as the wallet service does), nothing leaves the page.
const deleted: string[] = [];
vi.mock("../src/webengine/store", async (orig) => {
  const actual = await orig<typeof import("../src/webengine/store")>();
  return { ...actual, deleteCheckpoint: async (id: string) => void deleted.push(id), walletIdFor: async (f: string) => `id-${f.slice(0, 4)}` };
});
vi.mock("../src/signer", async (orig) => {
  const actual = await orig<typeof import("../src/signer")>();
  return { ...actual, fvkHex: async () => "abcd" + "0".repeat(188) };
});

import { browserRescan, browserRescanFrom, setBrowserWalletResolver } from "../src/webengine";

const ADDR = "zkas:test";
beforeEach(() => {
  localStorage.clear();
  deleted.length = 0;
  setBrowserWalletResolver(async () => ({ seedHex: "11".repeat(32), address: ADDR, birthday: 7_000_000 }));
});

describe("rescan in browser mode", () => {
  it("drops the checkpoint and the last report, and records the chosen start", async () => {
    localStorage.setItem(`browser_last_status:${ADDR}`, JSON.stringify({ scanned: 8_000_000 }));
    expect(await browserRescan(6_500_000)).toEqual({ rescanning: true });
    expect(deleted).toEqual(["id-abcd"]);
    expect(localStorage.getItem(`browser_last_status:${ADDR}`)).toBeNull();
    expect(browserRescanFrom(ADDR)).toBe(6_500_000);
  });

  it("without a birthday starts from genesis, like the wallet service", async () => {
    await browserRescan();
    expect(browserRescanFrom(ADDR)).toBe(0);
  });

  it("refuses when this browser holds no wallet", async () => {
    setBrowserWalletResolver(async () => null);
    await expect(browserRescan(1)).rejects.toThrow(/no wallet/);
  });

  it("is reached through the app's normal rescan call, with no request leaving the page", async () => {
    localStorage.setItem("wallet_browser_engine", "1");
    const f = vi.spyOn(globalThis, "fetch");
    const { api } = await import("../src/api");
    await api.rescan(6_000_000);
    expect(browserRescanFrom(ADDR)).toBe(6_000_000);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });
});
