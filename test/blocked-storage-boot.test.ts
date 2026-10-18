import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSnapshot, saveSnapshot } from "../src/localtx";
import { readLocal } from "../src/lib/safestore";

/**
 * A browser with site storage BLOCKED — Safari "Block all cookies", Chrome "Don't allow
 * sites to save data". The accessor itself throws `SecurityError`; it does not return
 * null. safestore.ts exists for that, and its header records the cost of missing it:
 * `wallet_token` read raw left such a browser on "Something went wrong — Access is
 * denied", with a Reload button back to the same screen.
 *
 * These pin the two places found still reading it raw after that migration.
 */
function blockStorage() {
  // Both halves throw, which is what a blocked store actually does.
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Access is denied for this document.", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Access is denied for this document.", "SecurityError");
  });
}

describe("site storage blocked entirely", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("readLocal answers null instead of throwing", () => {
    blockStorage();
    expect(() => readLocal("wallet_token")).not.toThrow();
    expect(readLocal("wallet_token")).toBeNull();
  });

  it("the snapshot degrades to absent rather than taking its callers with it", () => {
    // snapKey() read the accessor directly while key() in the same file used readLocal.
    // The callers catch, so this was never a crash — but the last-known-balance net was
    // gone entirely on the browsers most likely to need it, instead of falling back to
    // the default token.
    blockStorage();
    expect(() => saveSnapshot({ balanceFc: 1, spendableFc: 1, maturingFc: 0, noteCount: 1, ts: Date.now() })).not.toThrow();
    expect(() => loadSnapshot()).not.toThrow();
    expect(loadSnapshot()).toBeNull();
  });

  it("a working store still round-trips the snapshot", () => {
    // The guard must not cost the normal path.
    const snap = { balanceFc: 12.5, spendableFc: 12.5, maturingFc: 0, noteCount: 3, ts: Date.now() };
    saveSnapshot(snap);
    expect(loadSnapshot()).toMatchObject({ balanceFc: 12.5, noteCount: 3 });
  });
});

describe("the wallet stays coherent for a session when storage is blocked", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  it("keeps ONE wallet token across calls instead of minting a new one each time", async () => {
    // getToken runs on every request. With storage blocked it mints a token, and a raw
    // setItem THREW there, so the wallet could not issue a single call. Writing without
    // remembering would have been worse than the throw: every request would carry a
    // different token and the daemon would answer each with a different empty wallet —
    // a balance could not stay still between two polls.
    blockStorage();
    const { getToken } = await import("../src/api");
    const first = getToken();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(getToken()).toBe(first);
    expect(getToken()).toBe(first);
  });

  it("lets a wallet switch take effect for the session", async () => {
    blockStorage();
    const { switchWallet, activeToken } = await import("../src/wallets");
    expect(() => switchWallet("ff".repeat(16))).not.toThrow();
    // A raw setItem threw out of the click handler, so tapping another wallet did nothing
    // — not even the reload that follows it.
    expect(activeToken()).toBe("ff".repeat(16));
  });

  it("does not resurrect a key that was deliberately removed", async () => {
    // The fallback has to be cleared by removeLocal too, or a deleted value comes back on
    // the next read — which for a wallet token would resurrect a wallet the user removed.
    const { readLocal, writeLocal, removeLocal } = await import("../src/lib/safestore");
    blockStorage();
    writeLocal("k", "v");
    expect(readLocal("k")).toBe("v");
    removeLocal("k");
    expect(readLocal("k")).toBeNull();
  });

  it("prefers a WORKING store over a stale session value", async () => {
    const { readLocal, writeLocal } = await import("../src/lib/safestore");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    writeLocal("k2", "fallback");      // held in session
    spy.mockRestore();
    writeLocal("k2", "stored");        // storage works again
    expect(readLocal("k2")).toBe("stored");
    // And the fallback is gone, so the two cannot disagree later.
    localStorage.removeItem("k2");
    expect(readLocal("k2")).toBeNull();
  });
});

describe("reads that happen during RENDER", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  it("the receipt baseline answers null instead of throwing", async () => {
    // App.tsx reads this in a useRef initialiser, which runs during render, so a throw
    // here takes the whole wallet screen down rather than degrading. saveBaseline beside
    // it already wrapped its write; only the read was bare.
    blockStorage();
    const { loadBaseline } = await import("../src/receipts");
    expect(() => loadBaseline()).not.toThrow();
    expect(loadBaseline()).toBeNull();
  });

  it("a baseline still round-trips within the session when storage is blocked", async () => {
    blockStorage();
    const { loadBaseline, saveBaseline } = await import("../src/receipts");
    saveBaseline(12.5);
    // Held by safestore for this page, so arrival detection keeps working instead of
    // treating every poll as the first one it has ever seen.
    expect(loadBaseline()).toBe(12.5);
  });

  it("forgetting a wallet's receipts does not leave them to come back", async () => {
    const { saveBaseline, forgetReceipts, loadBaseline } = await import("../src/receipts");
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
    saveBaseline(9);
    forgetReceipts("0123456789abcdef0123456789abcdef");
    expect(loadBaseline()).toBeNull();
  });
});
