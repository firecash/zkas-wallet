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
