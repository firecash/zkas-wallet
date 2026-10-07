// "Max" must produce an amount the daemon will actually accept.
//
// The Send form reserved a flat 0.045 ZKAS — the fee for SIX spent notes — while
// the per-transaction cap is 38. The curve is steep, so any wallet holding more
// than six notes got a Max figure the daemon refuses with "insufficient matured
// funds", and tapping Max again refilled the same unpayable number.

import { describe, expect, it } from "vitest";
import { feeReserveSompi, minRelayFeeForSpends } from "../src/fees";

const ZKAS = (sompi: number) => sompi / 1e8;
const OLD_FLAT_RESERVE = 0.045;
const MAX_NOTES_PER_TX = 38;

describe("the fee curve the old flat reserve ignored", () => {
  it("rises steeply with the note count", () => {
    expect(ZKAS(minRelayFeeForSpends(2))).toBeCloseTo(0.018554, 6);
    expect(ZKAS(minRelayFeeForSpends(6))).toBeCloseTo(0.043802, 6);
    expect(ZKAS(minRelayFeeForSpends(7))).toBeCloseTo(0.050114, 6);
    expect(ZKAS(minRelayFeeForSpends(MAX_NOTES_PER_TX))).toBeCloseTo(0.245786, 6);
  });

  it("outgrows the old flat reserve at SEVEN notes, well under the 38 cap", () => {
    expect(ZKAS(minRelayFeeForSpends(6))).toBeLessThan(OLD_FLAT_RESERVE);
    expect(ZKAS(minRelayFeeForSpends(7))).toBeGreaterThan(OLD_FLAT_RESERVE);
  });
});

describe("reserving for the notes a wallet actually holds", () => {
  // Mirrors the Send form: clamp the wallet's note count into the per-tx cap.
  const reserveFor = (noteCount: number | undefined) =>
    ZKAS(feeReserveSompi(Math.max(1, Math.min(noteCount ?? MAX_NOTES_PER_TX, MAX_NOTES_PER_TX))));

  it("covers the relay minimum for every note count up to the cap", () => {
    for (let n = 1; n <= MAX_NOTES_PER_TX; n++) {
      expect(reserveFor(n)).toBeGreaterThanOrEqual(ZKAS(minRelayFeeForSpends(n)));
    }
  });

  it("would have left a 10-note wallet short under the old rule", () => {
    const needed = ZKAS(minRelayFeeForSpends(10));
    expect(OLD_FLAT_RESERVE).toBeLessThan(needed); // the bug
    expect(reserveFor(10)).toBeGreaterThanOrEqual(needed); // the fix
  });

  it("reserves the worst case when the note count is not known yet", () => {
    expect(reserveFor(undefined)).toBeCloseTo(ZKAS(minRelayFeeForSpends(MAX_NOTES_PER_TX)), 8);
  });

  it("does not over-reserve a small wallet — Max leaves less behind than before", () => {
    expect(reserveFor(2)).toBeLessThan(OLD_FLAT_RESERVE);
  });
});
