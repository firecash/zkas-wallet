import { describe, it, expect, beforeEach, vi } from "vitest";

// "Private sends" was refused in browser mode. It is now kept on the page, reported in the
// status the settings screen reads, and applied to every payment the engine builds.
import { browserPrivateSends, setBrowserWalletResolver } from "../src/webengine";

const ADDR = "zkas:test";
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("wallet_browser_engine", "1");
  setBrowserWalletResolver(async () => ({ seedHex: "11".repeat(32), address: ADDR, birthday: 7_000_000 }));
});

describe("private sends in browser mode", () => {
  it("is set through the app's normal settings call, with nothing leaving the page", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const { api } = await import("../src/api");
    expect(browserPrivateSends(ADDR)).toBe(false);
    expect(await api.setPrivateSends(true)).toEqual({ recoverableHistory: true, privateSends: true });
    expect(browserPrivateSends(ADDR)).toBe(true);
    await api.setPrivateSends(false);
    expect(browserPrivateSends(ADDR)).toBe(false);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });

  it("the worker asks the engine for an unrecoverable payment when it is on", () => {
    const src = require("node:fs").readFileSync("src/webengine/worker.ts", "utf8") as string;
    expect(src).toContain("recoverable: msg.recoverable !== false");
    // A proof made ahead with the other setting is never reused.
    expect(src).toMatch(/keyOf = \(m: SendMessage\) => aheadKey\([^)]*recoverable === false/);
  });
});
