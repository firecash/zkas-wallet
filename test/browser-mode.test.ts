import { describe, it, expect, beforeEach, vi } from "vitest";

// "Run in this browser" must never contact a wallet service: no registration, no viewing key,
// no payment preparation. Status comes from the in-page engine (the chain tip from the public
// gateway when no wallet exists yet), registration stays on the page, and every other
// wallet-service call is refused before any request leaves it.
vi.mock("../src/webengine/pkg/zkas_web_engine.js", () => ({
  default: async () => undefined,
  address_of_fvk: (fvk: string) => `zkas:test${fvk.slice(0, 6)}`,
}));
vi.mock("../src/webengine/pkg/zkas_web_engine_bg.wasm?url", () => ({ default: "engine.wasm" }));

import { api, setBase } from "../src/api";
import { browserBirthday, browserModeChosen, setBrowserModeChosen, setBrowserWalletResolver } from "../src/webengine";

const tipFetch = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
    if (String(u).endsWith("/chain-gateway/tip") || String(u).endsWith("/tip")) return new Response(JSON.stringify({ virtual_daa_score: 8_450_000 }));
    throw new Error(`unexpected request ${String(u)}`);
  });
const walletServiceCalls = (spy: ReturnType<typeof tipFetch>) => spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/"));

describe("browser mode", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setBrowserWalletResolver(async () => null);
  });

  it("with no wallet in this browser: the welcome screen, and the tip for a new wallet's birthday", async () => {
    setBrowserModeChosen(true);
    const spy = tipFetch();
    const s = await api.status();
    expect(s.has_wallet).toBe(false);
    expect(s.daa_score).toBe(8_450_000);
    expect(walletServiceCalls(spy)).toEqual([]);
  });

  it("registers a wallet on the page: an address, a birthday, and no request", async () => {
    setBrowserModeChosen(true);
    const spy = tipFetch();
    const r = await api.watch("ab".repeat(96), 8_000_000);
    expect(r.address).toBe("zkas:testababab");
    expect(browserBirthday(r.address)).toBe(8_000_000);
    // A later re-registration never moves the birthday forward (it would skip history).
    await api.watch("ab".repeat(96), 8_400_000);
    expect(browserBirthday(r.address)).toBe(8_000_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses sending without a request", async () => {
    setBrowserModeChosen(true);
    const spy = tipFetch();
    await expect(api.send("zkas:x", 1)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("is left when the user chooses a wallet service", () => {
    setBrowserModeChosen(true);
    setBase("https://wallet.zkas.info/daemon");
    expect(browserModeChosen()).toBe(false);
  });

  it("is off by default", () => {
    expect(browserModeChosen()).toBe(false);
  });
});
