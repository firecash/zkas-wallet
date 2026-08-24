import { describe, expect, it } from "vitest";
import { feeReserveSompi } from "../src/fees";
import { MAX_NOTES_PER_TX } from "../src/noncustodial";

// The allocation consolidateNonCustodial uses per round. Kept as a pure function
// here so the arithmetic that decides how a user's balance is split can be
// checked directly: getting it wrong either strands value or mints dust.
function share(available: bigint, targetNotes: number, produced: number): bigint {
  const sweepable = available - BigInt(feeReserveSompi(MAX_NOTES_PER_TX));
  if (sweepable <= 0n) return 0n;
  const stillWanted = Math.max(1, targetNotes - produced);
  const s = stillWanted > 1 ? sweepable / BigInt(stillWanted) : sweepable;
  const floor = BigInt(feeReserveSompi(MAX_NOTES_PER_TX)) * 2n;
  return s < floor ? sweepable : s;
}

const RESERVE = BigInt(feeReserveSompi(MAX_NOTES_PER_TX));
const BIG = 1_000_000_000_000n; // plenty, so the dust floor never trips

describe("consolidation split", () => {
  it("targetNotes = 1 sweeps everything, exactly as before", () => {
    expect(share(BIG, 1, 0)).toBe(BIG - RESERVE);
  });

  it("splits into equal shares and gives the remainder to the last note", () => {
    // Round 1 of 3 takes a third; round 2 takes half of what is left; round 3 the rest.
    const first = share(BIG, 3, 0);
    expect(first).toBe((BIG - RESERVE) / 3n);
    const afterFirst = BIG - first;
    const second = share(afterFirst, 3, 1);
    expect(second).toBe((afterFirst - RESERVE) / 2n);
    const afterSecond = afterFirst - second;
    expect(share(afterSecond, 3, 2)).toBe(afterSecond - RESERVE); // remainder, nothing stranded
  });

  it("never mints dust — a share below two fees takes the whole sweep instead", () => {
    const tiny = RESERVE * 3n; // sweepable is ~2 fees; a third of it would be dust
    expect(share(tiny, 3, 0)).toBe(tiny - RESERVE);
  });

  it("stops when there is nothing meaningful left", () => {
    expect(share(RESERVE, 3, 0)).toBe(0n);
    expect(share(RESERVE - 1n, 3, 0)).toBe(0n);
  });

  it("every share stays within what the wallet can actually spend", () => {
    for (const n of [1, 2, 3, 5]) {
      const s = share(BIG, n, 0);
      expect(s).toBeGreaterThan(0n);
      expect(s).toBeLessThanOrEqual(BIG - RESERVE);
    }
  });
});
