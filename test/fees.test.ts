import { describe, expect, it } from "vitest";
import { feeReserveSompi, minRelayFeeForSpends } from "../src/fees";
import { MAX_NOTES_PER_TX, maxFeeForSpends } from "../src/noncustodial";

// The live failure: consolidation reserved a flat 10,000,000 sompi for a fee that is
// byte-priced. A user saw "insufficient matured funds: have 3,167,861..., need
// 3,178,63..." for hours — a ~10.77M shortfall, which pins it to a 30–34 note merge.
describe("pricing a shielded transaction's fee", () => {
  it("costs far more than the old flat reserve at a full transaction", () => {
    expect(minRelayFeeForSpends(38)).toBe(24_578_600);
    expect(minRelayFeeForSpends(38)).toBeGreaterThan(2 * 10_000_000);
  });

  // The old flat reserve covered fourteen spends. Consolidation merges up to 38, so it
  // was under-reserved for almost every merge it was designed to perform.
  it("shows exactly where the old constant ran out — 14 spends", () => {
    expect(minRelayFeeForSpends(14)).toBeLessThan(10_000_000);
    expect(minRelayFeeForSpends(15)).toBeGreaterThan(10_000_000);
  });

  it("reproduces the reported shortfall for a 30-note merge", () => {
    // need - have == fee - reserve, with the old 10M reserve.
    const shortfall = minRelayFeeForSpends(30) - 10_000_000;
    expect(shortfall).toBeGreaterThan(9_000_000);
    expect(shortfall).toBeLessThan(12_000_000);
  });

  it("grows with the note count rather than sitting flat", () => {
    expect(minRelayFeeForSpends(2)).toBeLessThan(minRelayFeeForSpends(10));
    expect(minRelayFeeForSpends(10)).toBeLessThan(minRelayFeeForSpends(38));
  });

  it("reserves for a full transaction, since the daemon picks the note count", () => {
    expect(feeReserveSompi(MAX_NOTES_PER_TX)).toBe(minRelayFeeForSpends(38));
  });
});

// The ceiling is a security control: it stops a compromised daemon burning the change as
// "fee". It must clear an honest transaction while still bounding a dishonest one.
describe("the fee ceiling the device will sign", () => {
  it("clears the real cost of every legitimate transaction size", () => {
    for (const n of [2, 10, 20, 30, 38]) {
      expect(maxFeeForSpends(n)).toBeGreaterThan(minRelayFeeForSpends(n));
    }
  });

  it("still bounds an inflated fee rather than allowing anything", () => {
    expect(maxFeeForSpends(38)).toBeLessThan(10 * minRelayFeeForSpends(38));
  });

  it("scales down for a small round instead of applying the full-size cap", () => {
    expect(maxFeeForSpends(2)).toBeLessThan(maxFeeForSpends(38));
  });
});
