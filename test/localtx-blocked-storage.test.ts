import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTxs, recordSend } from "../src/localtx";
import { loadSnapshot, saveSnapshot } from "../src/localtx";

/**
 * `loadTxs` already read through safestore while `save` wrote raw, so the session copy that
 * reader consults could never be populated for this key. On a browser with site storage
 * blocked — ordinary in Safari private mode, and on iOS where WKWebView treats localStorage as
 * evictable website data — a send recorded the instant after it was broadcast vanished from
 * history immediately, instead of surviving the page.
 *
 * Contacts states the rule for the same reason: "safestore holds what a blocked store refused,
 * and a raw read here would not see it, so a contact would vanish the instant it was saved."
 * This file had it the other way round, and the snapshot read AND wrote raw.
 */
function blockStorage() {
  const throwing = {
    getItem: () => { throw new DOMException("blocked"); },
    setItem: () => { throw new DOMException("blocked"); },
    removeItem: () => { throw new DOMException("blocked"); },
    key: () => { throw new DOMException("blocked"); },
    get length(): number { throw new DOMException("blocked"); },
    clear: () => { throw new DOMException("blocked"); },
  };
  vi.stubGlobal("localStorage", throwing);
}

describe("a send survives a blocked store for the life of the page", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    localStorage.setItem("wallet_token", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("records and returns a send even when every accessor throws", () => {
    blockStorage();
    const list = recordSend({ txid: "a".repeat(64), amountFc: 1.5, ts: Date.now() } as never);
    expect(list.some((t) => t.txid === "a".repeat(64))).toBe(true);
    // And the reader sees it, which is the whole point — the write populates what it consults.
    expect(loadTxs().some((t) => t.txid === "a".repeat(64))).toBe(true);
  });

  it("keeps the last-known-balance snapshot too", () => {
    blockStorage();
    saveSnapshot({ balanceFc: 12.5, spendableFc: 10, maturingFc: 2.5, noteCount: 3, ts: Date.now() });
    expect(loadSnapshot()?.balanceFc).toBe(12.5);
  });

  it("does not throw out of the caller when storage is blocked", () => {
    blockStorage();
    expect(() => recordSend({ txid: "b".repeat(64), amountFc: 1, ts: Date.now() } as never)).not.toThrow();
    expect(() => saveSnapshot({ balanceFc: 1, spendableFc: 1, maturingFc: 0, noteCount: 1, ts: Date.now() })).not.toThrow();
  });

  it("uses no raw accessor for its own keys any more", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/localtx.ts", "utf8")).not.toMatch(/localStorage\./);
  });
});
