import { describe, it, expect, beforeEach, vi } from "vitest";

// A reload restores the checkpoint and the engine reports "starting" for a moment. Read as not
// synced, that flashed "Catching up 0.0%" over a wallet that was up to date a second earlier
// (seen end-to-end in Chromium, 1 in 4 reloads). A recent synced report at the same position
// keeps the wallet up to date, though not spend-ready until the engine re-checks the tip.
vi.mock("../src/signer", async (orig) => {
  const actual = await orig<typeof import("../src/signer")>();
  return { ...actual, fvkHex: async () => "ab".repeat(96) };
});
vi.mock("../src/webengine/store", async (orig) => {
  const actual = await orig<typeof import("../src/webengine/store")>();
  return { ...actual, walletIdFor: async () => "id" };
});

class SilentWorker {
  onmessage: unknown = null;
  postMessage() {}
  terminate() {}
  addEventListener() {}
}

import { browserServiceStatus, setBrowserWalletResolver, stopBrowserEngine } from "../src/webengine";

const ADDR = "zkas:test";
const last = (phase: string, ageMs: number) => {
  localStorage.setItem(`browser_last_status:${ADDR}`, JSON.stringify({ phase, scanned: 8_497_598, tip: 8_497_648, birthday: 8_497_615, balanceSompi: "5", notes: 1, at: Date.now() - ageMs, spendReady: true }));
  if (phase === "synced") localStorage.setItem(`browser_last_synced:${ADDR}`, JSON.stringify({ scanned: 8_497_598, at: Date.now() - ageMs }));
};

beforeEach(() => {
  stopBrowserEngine();
  localStorage.clear();
  vi.stubGlobal("Worker", SilentWorker);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ virtual_daa_score: 8_497_700 })));
  setBrowserWalletResolver(async () => ({ seedHex: "11".repeat(32), address: ADDR, birthday: 8_497_615 }));
});

describe("a reloaded browser wallet", () => {
  it("stays up to date while the engine restarts where it was", async () => {
    last("synced", 2_000);
    const st = await browserServiceStatus();
    expect(st.synced).toBe(true);
    expect(st.spend_ready).toBe(false);
    expect(st.scanned_blocks).toBe(8_497_598);
    expect(st.balance_sompi).toBe("5");
  });

  it("is catching up when the last report is old", async () => {
    last("synced", 11 * 60_000);
    expect((await browserServiceStatus()).synced).toBe(false);
  });

  it("is catching up when it was catching up", async () => {
    last("tip", 2_000);
    expect((await browserServiceStatus()).synced).toBe(false);
  });

  it("stays up to date through the catch-up report right after, against the last synced one", async () => {
    // The restart's first catch-up report overwrote the last report with phase "tip".
    last("synced", 3_000);
    localStorage.setItem(`browser_last_status:${ADDR}`, JSON.stringify({ phase: "tip", scanned: 8_497_598, tip: 8_497_700, birthday: 8_497_615, balanceSompi: "5", notes: 1, at: Date.now() }));
    expect((await browserServiceStatus()).synced).toBe(true);
  });
});
