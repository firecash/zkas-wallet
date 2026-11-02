import { describe, it, expect, beforeEach, vi } from "vitest";

// While the engine ingests, a History request waits for it. It used to wait 10 s and answer an
// EMPTY list ("Nothing yet" over a wallet with payments; a user log, 2 Nov: 10,001 ms).
vi.mock("../src/signer", async (orig) => {
  const actual = await orig<typeof import("../src/signer")>();
  return { ...actual, fvkHex: async () => "ab".repeat(96) };
});
vi.mock("../src/webengine/store", async (orig) => {
  const actual = await orig<typeof import("../src/webengine/store")>();
  return { ...actual, walletIdFor: async () => "id" };
});

let last: FakeWorker | null = null;
class FakeWorker {
  listeners: ((ev: MessageEvent) => void)[] = [];
  posted: { type: string; id?: number }[] = [];
  onmessage: unknown = null;
  constructor() {
    last = this;
  }
  postMessage(m: { type: string; id?: number }) {
    this.posted.push(m);
  }
  terminate() {}
  addEventListener(_t: string, f: (ev: MessageEvent) => void) {
    this.listeners.push(f);
  }
  answer(id: number, json: string) {
    for (const f of this.listeners) f({ data: { type: "history", id, json } } as MessageEvent);
  }
}

import { browserHistory, browserServiceStatus, setBrowserWalletResolver, stopBrowserEngine, HISTORY_BUSY_WAIT_MS } from "../src/webengine";

const ADDR = "zkas:test";
const ROWS = JSON.stringify({ recoverableHistory: true, total: 1, rows: [{ txid: "t1" }] });
const NEWER = JSON.stringify({ recoverableHistory: true, total: 2, rows: [{ txid: "t2" }, { txid: "t1" }] });

beforeEach(async () => {
  stopBrowserEngine();
  localStorage.clear();
  vi.useRealTimers();
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ virtual_daa_score: 1 })));
  setBrowserWalletResolver(async () => ({ seedHex: "11".repeat(32), address: ADDR, birthday: 5 }));
  await browserServiceStatus();
});

const lastId = () => last!.posted.filter((m) => m.type === "history").at(-1)!.id!;

describe("History while the browser engine is busy", () => {
  it("answers the last list after a short wait, never an empty one", async () => {
    localStorage.setItem(`browser_history:${ADDR}:500:0`, ROWS);
    const t0 = Date.now();
    const got = await browserHistory(500, 0);
    expect(got).toBe(ROWS);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(HISTORY_BUSY_WAIT_MS - 50);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("uses and remembers the engine's answer when it comes", async () => {
    const p = browserHistory(500, 0);
    last!.answer(lastId(), NEWER);
    expect(await p).toBe(NEWER);
    expect(localStorage.getItem(`browser_history:${ADDR}:500:0`)).toBe(NEWER);
  });

  it("a stopped engine never overwrites the list with an empty one", async () => {
    localStorage.setItem(`browser_history:${ADDR}:500:0`, ROWS);
    const p = browserHistory(500, 0);
    stopBrowserEngine();
    expect(await p).toBe(ROWS);
    expect(localStorage.getItem(`browser_history:${ADDR}:500:0`)).toBe(ROWS);
  });
});
