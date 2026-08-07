import { describe, it, expect } from "vitest";
import { walletStatus, formatDuration, type StatusInput } from "../src/status";

const base: StatusInput = {
  online: true,
  synced: true,
  scannedBlocks: 1_000_000,
  chainLen: 1_000_000,
  warming: false,
  haveConfirmedBalance: true,
  etaSeconds: null,
};

describe("what the wallet tells the user it is doing", () => {
  // The rule that matters most. A scan reports what it has found SO FAR, climbing
  // from zero. Shown as a headline it reads as theft: a user watched "34.75 ZKAS"
  // under a small "syncing 44%", and a pool wallet showed 29,703 against a true
  // 423,997. Nothing partial may ever be presented as the balance.
  it("never calls a partial count a balance", () => {
    const firstScan = walletStatus({ ...base, synced: false, scannedBlocks: 440_000, haveConfirmedBalance: false });
    expect(firstScan.balanceIsFinal).toBe(false);
    expect(firstScan.phase).toBe("setting-up");

    const catchingUp = walletStatus({ ...base, synced: false, scannedBlocks: 990_000, haveConfirmedBalance: true });
    expect(catchingUp.balanceIsFinal).toBe(false);

    const opening = walletStatus({ ...base, synced: false, scannedBlocks: 0, haveConfirmedBalance: false });
    expect(opening.balanceIsFinal).toBe(false);

    expect(walletStatus(base).balanceIsFinal).toBe(true);
  });

  // The daemon answers zeros while it loads a wallet. That is "I don't know yet",
  // not "you have nothing" — and it must never be phrased as progress through the
  // chain, because 0 of 1,000,000 looks like everything was lost.
  it("treats a loading wallet as loading, not as 0% scanned", () => {
    const v = walletStatus({ ...base, synced: false, scannedBlocks: 0, haveConfirmedBalance: true });
    expect(v.phase).toBe("opening");
    expect(v.pct).toBeNull();
  });

  it("shows progress and a time only when it genuinely knows them", () => {
    const noRate = walletStatus({ ...base, synced: false, scannedBlocks: 500_000, haveConfirmedBalance: false });
    expect(noRate.pct).toBe(50);
    expect(noRate.eta).toBeNull(); // no measured rate yet — say nothing rather than guess

    const withRate = walletStatus({
      ...base,
      synced: false,
      scannedBlocks: 500_000,
      haveConfirmedBalance: false,
      etaSeconds: 600,
    });
    expect(withRate.eta).toBe("about 10 minutes left");
  });

  it("keeps spending disabled until the wallet knows about all its coins", () => {
    expect(walletStatus({ ...base, synced: false, haveConfirmedBalance: true }).canSpend).toBe(false);
    expect(walletStatus({ ...base, warming: true }).canSpend).toBe(true);
    expect(walletStatus(base).canSpend).toBe(true);
  });

  it("says the network is unreachable without implying the coins are gone", () => {
    const v = walletStatus({ ...base, online: false });
    expect(v.phase).toBe("offline");
    expect(v.detail).toMatch(/safe/i);
    expect(v.balanceIsFinal).toBe(false);
  });

  // Every one of these words appeared on screen at some point. None of them mean
  // anything to somebody who just wants to know whether their money is there.
  it("uses no internal jargon in anything the user reads", () => {
    const jargon = /rebuild|restor|warm|witness|anchor|0-conf|matur|nullifier|frontier|daemon|checkpoint|commitment tree/i;
    const cases: StatusInput[] = [
      base,
      { ...base, warming: true },
      { ...base, online: false },
      { ...base, synced: false, scannedBlocks: 0, haveConfirmedBalance: false },
      { ...base, synced: false, scannedBlocks: 400_000, haveConfirmedBalance: false },
      { ...base, synced: false, scannedBlocks: 900_000, haveConfirmedBalance: true },
    ];
    for (const c of cases) {
      const v = walletStatus(c);
      expect(v.label, `label: ${v.label}`).not.toMatch(jargon);
      expect(v.detail, `detail: ${v.detail}`).not.toMatch(jargon);
    }
  });

  it("rounds durations so the figure holds still instead of jittering", () => {
    expect(formatDuration(20)).toBe("less than a minute");
    expect(formatDuration(90)).toBe("about 2 minutes");
    expect(formatDuration(60)).toBe("about 1 minute");
    expect(formatDuration(3600)).toBe("about 1 hour");
    expect(formatDuration(5400)).toBe("about 1h 30m");
    expect(formatDuration(40_000)).toBe("several hours");
  });
});

describe("progress that visibly moves", () => {
  // Reported live: "first seconds it synced fast, now it takes longer, sometimes it
  // looks stuck although it advances". That was an accurate description of a whole-
  // number percent on a ~1.04M-block chain: at the measured ~250–800 blocks/s one
  // percent takes 13–42 SECONDS, so the display genuinely did not move for that long.
  it("shows a finer figure than a whole percent", () => {
    const v = walletStatus({ ...base, synced: false, scannedBlocks: 624_000, chainLen: 1_000_000, haveConfirmedBalance: false });
    expect(v.pct).toBe(62); // the coarse figure still exists for the bar width
    expect(v.pctFine).toBe("62.4%"); // ...but the user reads this one
  });

  it("never rounds up to 100% while blocks remain", () => {
    const v = walletStatus({ ...base, synced: false, scannedBlocks: 999_999, chainLen: 1_000_000, haveConfirmedBalance: false });
    expect(v.pctFine).toBe("99.9%");
    expect(walletStatus({ ...base, scannedBlocks: 1_000_000, chainLen: 1_000_000, synced: false, haveConfirmedBalance: false }).pctFine).toBe(
      "100.0%",
    );
  });

  it("carries a block count, so something moves on every poll", () => {
    const v = walletStatus({ ...base, synced: false, scannedBlocks: 624_000, chainLen: 1_000_000, haveConfirmedBalance: false });
    expect(v.progress).toEqual({ scanned: 624_000, total: 1_000_000 });
    // A settled wallet has no progress to show.
    expect(walletStatus(base).progress).toBeNull();
  });
});
