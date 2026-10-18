import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRegistered, listWallets } from "../src/wallets";
import { setDeviceSeed } from "../src/App";

/**
 * What the wallet does when localStorage refuses a write.
 *
 * Not an exotic condition: WKWebView treats localStorage as evictable website data, and
 * Safari private mode can throw on write outright. The two cases below must behave in
 * OPPOSITE ways, which is the whole point of the pair.
 */
describe("a localStorage write that throws", () => {
  beforeEach(() => {
    // Restore FIRST: a mock left over from the previous case would otherwise throw
    // inside this setup rather than inside the test.
    vi.restoreAllMocks();
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
  });

  it("does not let the wallet registry fail the status poll", () => {
    // ensureRegistered runs inside the poll's try block. When this threw, a good status
    // reply was thrown away as a failed poll, and five of those announced "Can't reach
    // the wallet service" for a daemon answering everything. The registry is labels and
    // addresses — the next poll rebuilds it from the daemon's own answer.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => ensureRegistered("0123456789abcdef0123456789abcdef", "zkas:test")).not.toThrow();
  });

  it("still lets a FAILED SEED write be loud", () => {
    // The opposite rule, and the more important one. A seed that cannot be stored must
    // not be swallowed: the old behaviour dropped the key quietly, a freshly created
    // wallet had nothing to spend with after reload, and the coins already sent to it
    // were unrecoverable (issue #4 / PR #8). If this ever starts passing silently,
    // that loss path is back.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => setDeviceSeed("ab".repeat(32))).toThrow();
  });

  it("keeps the registry readable after a failed write", () => {
    ensureRegistered("0123456789abcdef0123456789abcdef", "zkas:first");
    const before = listWallets().length;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    ensureRegistered("ffffffffffffffffffffffffffffffff", "zkas:second");
    vi.restoreAllMocks();
    // The new row was not persisted, and the previous list is intact rather than
    // half-written or cleared.
    expect(listWallets().length).toBe(before);
  });
});
