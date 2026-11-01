import { describe, it, expect } from "vitest";
import { scanFraction, walletStatus } from "../src/status";

// Progress is "of this wallet's own scan" — from its birthday to the tip — not "of the chain
// since genesis". Reported 1 Nov: a wallet born ~60 days back read 35% the moment its scan
// began, so a restart looked like losing half the progress.
describe("scan progress counts from the wallet's birthday", () => {
  const tip = 8_440_635;
  const birthday = 2_990_626;

  it("is 0 at the start, even when the scan begins just below the birthday (almanac)", () => {
    expect(scanFraction(2_937_597, tip, birthday)).toBe(0);
    expect(scanFraction(birthday, tip, birthday)).toBe(0);
  });

  it("measures the work done, and reaches 1 at the tip", () => {
    expect(scanFraction(5_715_630, tip, birthday)).toBeCloseTo(0.5, 3);
    expect(scanFraction(tip, tip, birthday)).toBe(1);
  });

  it("falls back to genesis when the birthday is unknown or unusable", () => {
    expect(scanFraction(4_220_317, tip, null)).toBeCloseTo(0.5, 3);
    expect(scanFraction(4_220_317, tip, 0)).toBeCloseTo(0.5, 3);
    expect(scanFraction(4_220_317, tip, tip + 5)).toBeCloseTo(0.5, 3);
  });

  it("is what the status line shows", () => {
    const base = { online: true, synced: false, warming: false, haveConfirmedBalance: true, etaSeconds: null, chainLen: tip };
    const atStart = walletStatus({ ...base, scannedBlocks: 2_937_597, scanFrom: birthday });
    expect(atStart.pctFine).toBe("0.0%");
    const genesisBased = walletStatus({ ...base, scannedBlocks: 2_937_597 });
    expect(genesisBased.pctFine).toBe("34.8%");
  });
});
