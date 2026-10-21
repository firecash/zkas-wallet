import { describe, expect, it } from "vitest";
import { sanePrice } from "../src/price";

/**
 * `num()` stripped every non-digit, so "-62.5" became 62.5 and the `usd <= 0` guards never
 * saw a negative rate — a feed reporting a negative price would have shown it as POSITIVE
 * beside the user's balance. The guards were not wrong; the sign never reached them.
 */
describe("a negative rate is rejected, not made positive", () => {
  it("rejects a negative figure outright", () => {
    expect(sanePrice({ usdPerZkas: -62.5, kasPerZkas: 1, asOf: Date.now() })).toBeNull();
  });

  it("still parses the ordinary shapes the feed sends", async () => {
    const { parseFigure } = await import("../src/price");
    expect(parseFigure("$0.00215")).toBeCloseTo(0.00215, 8);
    expect(parseFigure("1,234.56")).toBeCloseTo(1234.56, 4);
    expect(parseFigure("0.00215")).toBeCloseTo(0.00215, 8);
    // A JSON number stays exactly itself. `String(1e-7)` is "1e-7", and the strip that removes
    // the "$" and the thousands separators would have turned that into 17 — positive, finite,
    // and seventeen million times the real figure, so no guard downstream would have caught it.
    expect(parseFigure(1e-7)).toBe(1e-7);
    expect(parseFigure(0.00215)).toBe(0.00215);
  });

  it("carries the sign through so the guard can act on it", async () => {
    const { parseFigure } = await import("../src/price");
    expect(parseFigure("-62.5")).toBeLessThan(0);
    expect(parseFigure("-$62.50")).toBeLessThan(0);
    // And a negative one cannot survive sanePrice.
    expect(sanePrice({ usdPerZkas: parseFigure("-62.5"), kasPerZkas: 0, asOf: 1 })).toBeNull();
  });

  it("a negative KAS rate falls back to zero rather than negative", () => {
    const p = sanePrice({ usdPerZkas: 1, kasPerZkas: -5, asOf: 1 });
    expect(p?.kasPerZkas).toBe(0);
  });
});
