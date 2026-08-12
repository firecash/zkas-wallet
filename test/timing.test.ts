import { beforeEach, describe, expect, it } from "vitest";
import { estimateDuration, recordDuration, remainingLabel } from "../src/timing";

describe("predicting how long a payment will take", () => {
  beforeEach(() => localStorage.clear());

  // The live report: a send predicted "about 3 minutes" and finished in ~40 seconds.
  // The old model derived a per-note RATE from a cold run and applied it to a warm one,
  // so the entire cold witness rebuild was priced into a payment that never did one.
  it("does not price a cold run into a warm one", () => {
    recordDuration("prepare", "w", 1, 180_000, false); // cold: witness rebuild
    // Only cold samples exist, so a warm payment has nothing honest to predict from.
    expect(estimateDuration("prepare", "w", 1, true)).toBeNull();
  });

  it("predicts a warm payment from warm samples", () => {
    recordDuration("prepare", "w", 1, 40_000, true);
    recordDuration("prepare", "w", 1, 44_000, true);
    recordDuration("prepare", "w", 1, 180_000, false); // a cold run must not drag it up
    const est = estimateDuration("prepare", "w", 1, true);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(35_000);
    expect(est!).toBeLessThan(60_000);
  });

  // The structural error: cost is `fixed + perNote × notes`, so dividing a one-note
  // duration by 1 and multiplying by 5 charges the fixed cost five times.
  it("treats cost as fixed-plus-marginal, not proportional", () => {
    recordDuration("prepare", "w", 1, 40_000, true);
    const five = estimateDuration("prepare", "w", 5, true)!;
    expect(five).toBeGreaterThan(40_000); // more notes really is more work
    expect(five).toBeLessThan(5 * 40_000); // but nothing like five times
  });

  it("fits a slope once it has seen different sizes", () => {
    recordDuration("prepare", "w", 2, 12_000, true);
    recordDuration("prepare", "w", 10, 28_000, true); // +8 notes = +16s -> 2s/note, 8s fixed
    const est = estimateDuration("prepare", "w", 6, true)!;
    expect(est).toBeGreaterThan(15_000);
    expect(est!).toBeLessThan(25_000);
  });

  it("says nothing at all until it has watched one finish", () => {
    expect(estimateDuration("prepare", "fresh", 3, true)).toBeNull();
  });

  it("keeps wallets apart", () => {
    recordDuration("prepare", "a", 1, 40_000, true);
    expect(estimateDuration("prepare", "b", 1, true)).toBeNull();
  });

  it("refuses to extrapolate wildly beyond anything observed", () => {
    recordDuration("prepare", "w", 1, 5_000, true);
    const est = estimateDuration("prepare", "w", 38, true);
    if (est !== null) expect(est).toBeLessThanOrEqual(4 * 5_000);
  });
});

describe("what the countdown says", () => {
  it("stops predicting once it overruns instead of going negative", () => {
    expect(remainingLabel(30_000, 45_000)).toBe("any moment now");
  });

  it("shows elapsed-only when there is no estimate", () => {
    expect(remainingLabel(null, 5_000)).toBeNull();
  });

  it("reads naturally either side of a minute", () => {
    expect(remainingLabel(40_000, 10_000)).toBe("about 30s left");
    expect(remainingLabel(150_000, 10_000)).toBe("about 2m 20s left");
  });
});
