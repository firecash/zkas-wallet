import { beforeEach, describe, expect, it } from "vitest";
import { estimateDuration, recordDuration, remainingLabel } from "../src/timing";

const TOKEN = "wallet-a";

describe("predicting how long a payment will take", () => {
  beforeEach(() => localStorage.clear());

  // The first run of anything is genuinely unpredictable. Saying so is what makes
  // the later countdowns believable.
  it("refuses to predict before it has watched one finish", () => {
    expect(estimateDuration("prepare", TOKEN, 10)).toBeNull();
    expect(remainingLabel(null, 5_000)).toBeNull();
  });

  it("predicts from measured runs, scaled by the notes being spent", () => {
    recordDuration("prepare", TOKEN, 10, 20_000); // 2s per note
    expect(estimateDuration("prepare", TOKEN, 10)).toBe(20_000);
    // Twice the notes, twice the work — the cost driver is note count.
    expect(estimateDuration("prepare", TOKEN, 20)).toBe(40_000);
  });

  // One pathological run — a cold wallet replaying the chain, or a daemon busy
  // proving for somebody else — must not drag every later estimate up with it.
  it("is not dragged by a single outlier", () => {
    recordDuration("prepare", TOKEN, 1, 2_000);
    recordDuration("prepare", TOKEN, 1, 2_000);
    recordDuration("prepare", TOKEN, 1, 400_000); // the 392s climb
    expect(estimateDuration("prepare", TOKEN, 1)).toBe(2_000);
  });

  it("keeps wallets and operations apart", () => {
    recordDuration("prepare", TOKEN, 1, 3_000);
    expect(estimateDuration("prepare", "wallet-b", 1)).toBeNull();
    expect(estimateDuration("consolidate-pass", TOKEN, 1)).toBeNull();
  });

  it("ignores samples too small to mean anything", () => {
    recordDuration("prepare", TOKEN, 1, 10);
    recordDuration("prepare", TOKEN, 0, 5_000);
    expect(estimateDuration("prepare", TOKEN, 1)).toBeNull();
  });

  // The estimate is a median, so about half of all runs pass it. Overrunning must
  // not show a countdown stuck at zero, and certainly not a negative one.
  it("stops predicting once it has overrun, rather than lying", () => {
    expect(remainingLabel(60_000, 10_000)).toBe("about 50s left");
    expect(remainingLabel(200_000, 10_000)).toBe("about 3m 10s left");
    expect(remainingLabel(60_000, 60_000)).toBe("any moment now");
    expect(remainingLabel(60_000, 900_000)).toBe("any moment now");
  });
});
