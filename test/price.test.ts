import { beforeEach, describe, expect, it, vi } from "vitest";
import { cachedPrice, fmtFiat } from "../src/price";

/**
 * The fiat figure sits directly under the balance, so a bad rate reads as a bad balance.
 *
 * The live fetch already refused a rate that was not finite or not positive. The CACHE did
 * not — it was JSON.parse'd from localStorage and cast — so a corrupt entry became the rate
 * and reached the screen: "$NaN" for a non-numeric one, "$-62.500" for a negative. This
 * module had no tests at all.
 */
const KEY = "zkas_price_v1";

describe("a corrupt cached price", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("never becomes the rate", async () => {
    for (const junk of [
      '{"usdPerZkas":"abc"}',
      '{"usdPerZkas":null}',
      '{"usdPerZkas":-5}',
      '{"usdPerZkas":0}',
      '{"kasPerZkas":1}',
      '{"usdPerZkas":"1.5"}',   // a STRING that looks numeric is still not a number
      "null",
      '"text"',
      "[]",
      "{",
    ]) {
      localStorage.setItem(KEY, junk);
      vi.resetModules();
      const { cachedPrice: fresh } = await import("../src/price");
      expect(fresh(), junk).toBeNull();
    }
  });

  it("accepts a well-formed one", () => {
    localStorage.setItem(KEY, JSON.stringify({ usdPerZkas: 0.00215, kasPerZkas: 0.03, asOf: Date.now() }));
    expect(cachedPrice()).toMatchObject({ usdPerZkas: 0.00215, kasPerZkas: 0.03 });
  });

  it("repairs a broken timestamp rather than discarding a usable rate", async () => {
    // A non-finite asOf would make `Date.now() - asOf` NaN, and `NaN < FRESH_MS` is false,
    // so the figure would read as stale on every tick and refetch every time.
    localStorage.setItem(KEY, JSON.stringify({ usdPerZkas: 0.002, kasPerZkas: 0, asOf: "yesterday" }));
    vi.resetModules();
    const { cachedPrice: fresh } = await import("../src/price");
    const p = fresh();
    expect(p?.usdPerZkas).toBe(0.002);
    expect(Number.isFinite(p!.asOf)).toBe(true);
  });

  it("drops a negative kas rate to zero instead of showing a negative", async () => {
    localStorage.setItem(KEY, JSON.stringify({ usdPerZkas: 0.002, kasPerZkas: -1, asOf: Date.now() }));
    vi.resetModules();
    const { cachedPrice: fresh } = await import("../src/price");
    expect(fresh()?.kasPerZkas).toBe(0);
  });
});

describe("fmtFiat", () => {
  it("prints nothing when there is no price, rather than a zero", () => {
    // A missing rate is not "worth $0.00" — the caller renders nothing.
    expect(fmtFiat(12.5, null)).toBeNull();
  });

  it("never prints NaN for an unusable balance", () => {
    expect(fmtFiat(NaN, { usdPerZkas: 1, kasPerZkas: 0, asOf: 0 })).toBeNull();
    expect(fmtFiat(Infinity, { usdPerZkas: 1, kasPerZkas: 0, asOf: 0 })).toBeNull();
  });

  it("formats the ranges the wallet actually shows", () => {
    const p = { usdPerZkas: 0.00215, kasPerZkas: 0, asOf: 0 };
    expect(fmtFiat(0, p)).toBe("$0.00");
    expect(fmtFiat(1, p)).toBe("<$0.01");          // a single coin is sub-cent at this rate
    expect(fmtFiat(100, p)).toBe("$0.215");        // under a dollar keeps three places
    expect(fmtFiat(1_000_000, p)).toContain("2,150");
  });
});
