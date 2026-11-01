import { describe, it, expect, vi, beforeEach } from "vitest";

// prewarm warmed EVERY other wallet every 120 s; on a daemon that keeps 4 wallets resident for
// the whole fleet that was the eviction thrash it meant to prevent. It now warms only the
// wallet switched away from last, and nothing while the app is hidden.
const touched: string[] = [];
vi.mock("../src/api", async (orig) => {
  const actual = await orig<typeof import("../src/api")>();
  return { ...actual, getBase: () => "https://d.test", touchWallet: async (t: string) => (touched.push(t), true) };
});

import { ensureRegistered, switchWallet, previousToken } from "../src/wallets";
import { startPrewarm, stopPrewarm } from "../src/prewarm";

const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);

beforeEach(() => {
  localStorage.clear();
  touched.length = 0;
  for (const t of [A, B, C]) ensureRegistered(t, undefined, "https://d.test");
});

async function oneRound() {
  vi.useFakeTimers();
  startPrewarm();
  await vi.advanceTimersByTimeAsync(8_100);
  await vi.advanceTimersByTimeAsync(10_000);
  stopPrewarm();
  vi.useRealTimers();
}

describe("prewarm", () => {
  it("warms only the wallet just left", async () => {
    switchWallet(A);
    switchWallet(B);
    switchWallet(C);
    expect(previousToken()).toBe(B);
    await oneRound();
    expect(touched).toEqual([B]);
  });

  it("warms nothing without a previous wallet", async () => {
    switchWallet(A);
    await oneRound();
    expect(touched).toEqual([]);
  });

  it("warms nothing while the app is hidden", async () => {
    switchWallet(A);
    switchWallet(B);
    const d = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      await oneRound();
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
      if (d) Object.defineProperty(Document.prototype, "hidden", d);
    }
    expect(touched).toEqual([]);
  });
});
