import { describe, it, expect } from "vitest";
import { walletStatus, walletCanSpend, formatDuration, type StatusInput } from "../src/status";
import { arrivalAmount } from "../src/arrivals";

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

describe("announcing money that arrives", () => {
  // The rule that keeps this honest. A restoring wallet's balance climbs from zero as
  // the scan finds its own notes; announcing those as arrivals would fire a burst of
  // fake "you were paid" notifications at exactly the moment a user is most anxious.
  it("never announces while the balance is still partial", () => {
    expect(arrivalAmount(10, 40, false)).toBeNull();
    expect(arrivalAmount(0, 423_997, false)).toBeNull();
  });

  it("treats the first final reading as a baseline, not a windfall", () => {
    // Opening the app must not announce the entire existing balance.
    expect(arrivalAmount(null, 1234.5, true)).toBeNull();
  });

  it("announces a genuine increase between two settled readings", () => {
    expect(arrivalAmount(10, 12.5, true)).toBeCloseTo(2.5, 8);
  });

  it("stays quiet when the balance is unchanged or falls", () => {
    expect(arrivalAmount(10, 10, true)).toBeNull();
    expect(arrivalAmount(10, 4, true)).toBeNull(); // a send, not an arrival
  });

  it("ignores sub-sompi float noise", () => {
    expect(arrivalAmount(10, 10 + 1e-12, true)).toBeNull();
  });
});

// The live contradiction: the balance card said "1.27 ZKAS ready to spend" while Send
// refused with "still catching up", in the same wallet. Two meanings of "ready" read
// from two separate places. One predicate is what stops it recurring.
describe("one spend predicate", () => {
  it("never lets a state claim it can spend while it is still catching up", () => {
    const catching = walletStatus({
      online: true, synced: false, scannedBlocks: 900, chainLen: 1000,
      warming: false, haveConfirmedBalance: true, etaSeconds: null,
    });
    expect(catching.phase).toBe("catching-up");
    expect(catching.canSpend).toBe(false);
    expect(walletCanSpend({ online: true, synced: false })).toBe(false);
  });

  it("agrees with the status model in every phase", () => {
    for (const synced of [true, false]) {
      for (const scannedBlocks of [0, 900]) {
        for (const haveConfirmedBalance of [true, false]) {
          for (const warming of [true, false]) {
            const view = walletStatus({
              online: true, synced, scannedBlocks, chainLen: 1000,
              warming, haveConfirmedBalance, etaSeconds: null,
            });
            expect(view.canSpend).toBe(walletCanSpend({ online: true, synced }));
          }
        }
      }
    }
  });

  it("a warming wallet may still pay — slowly, but it knows all its coins", () => {
    const warm = walletStatus({
      online: true, synced: true, scannedBlocks: 1000, chainLen: 1000,
      warming: true, haveConfirmedBalance: true, etaSeconds: null,
    });
    expect(warm.phase).toBe("almost-ready");
    expect(warm.canSpend).toBe(true);
  });
});

// The exact contradiction users reported: a card reading "Ready · 1.27 ZKAS" while
// tapping Send or Consolidate answered "wallet is still catching up". Both statements
// came from the daemon, but from DIFFERENT conditions — `/api/status.synced` (the scan
// reached the tip) versus what `/prepare` enforces (the mirror tree is also valid). The
// daemon now publishes the second one, and every spend control reads that.
describe("readiness is the daemon's answer, not our inference", () => {
  it("does not claim Ready when the daemon would refuse the spend", () => {
    const finishing = walletStatus({ ...base, spendReady: false });
    expect(finishing.canSpend).toBe(false);
    expect(finishing.phase).not.toBe("ready");
    expect(finishing.label).toBe("Finishing up");
    // The balance itself is complete — only spending is blocked. Hiding the figure
    // here would be the opposite mistake.
    expect(finishing.balanceIsFinal).toBe(true);
  });

  it("is Ready when the daemon says a spend would be accepted", () => {
    const ready = walletStatus({ ...base, spendReady: true });
    expect(ready.phase).toBe("ready");
    expect(ready.canSpend).toBe(true);
  });

  // Daemons predating the field must keep working exactly as before, or upgrading the
  // app would strand every wallet pointed at an older wallet service.
  it("falls back to synced against a daemon that does not publish it", () => {
    expect(walletCanSpend({ online: true, synced: true })).toBe(true);
    expect(walletCanSpend({ online: true, synced: false })).toBe(false);
    expect(walletStatus(base).phase).toBe("ready");
  });

  it("is never spendable while offline, whatever the daemon last said", () => {
    expect(walletCanSpend({ online: false, synced: true, spendReady: true })).toBe(false);
  });
});

// Regression: a daemon restart closes every wallet at once. While a wallet is being
// re-opened the daemon reports balance 0, and the client's 6s "synced" hold could keep
// `synced` true across that gap — which used to fall through to "Finishing up · your
// balance is up to date" over a balance of zero. A user reloaded the page and saw their
// real balance, which is the tell: nothing was wrong except what the app said.
describe("a wallet the daemon has not opened yet", () => {
  const opening = {
    online: true,
    synced: true, // held over from before the restart
    spendReady: false,
    scannedBlocks: 0,
    chainLen: 2_800_000,
    warming: false,
    loading: true,
    haveConfirmedBalance: true,
    etaSeconds: null,
  };

  it("is reported as opening, never as finished", () => {
    const v = walletStatus(opening);
    expect(v.phase).toBe("opening");
    expect(v.label).toBe("Opening your wallet");
  });

  it("never calls the balance final while it is unknown", () => {
    expect(walletStatus(opening).balanceIsFinal).toBe(false);
  });

  it("still resolves normally once the wallet is open", () => {
    expect(walletStatus({ ...opening, loading: false, scannedBlocks: 2_800_000, spendReady: true }).phase).toBe("ready");
  });
});

// A payment proves against an anchor ~630 blocks deep, not against the chain head, so a
// wallet that trails the tip can still hold every note and witness the payment consumes.
// Gating Send on "caught up to the tip" stranded wallets that were fully able to pay —
// observed live on one holding 4,151,575 ZKAS, all matured, none of it movable.
describe("a wallet that is behind but can still pay", () => {
  const behind = {
    online: true,
    synced: false,
    spendReady: true, // daemon says the anchor is covered
    scannedBlocks: 1_456_000,
    chainLen: 1_456_300,
    blocksBehind: 300,
    warming: false,
    haveConfirmedBalance: true,
    etaSeconds: null,
  };

  it("leads with what the user can do, not with a percentage", () => {
    const v = walletStatus(behind);
    expect(v.canSpend).toBe(true);
    expect(v.label).toBe("Ready to pay · still catching up");
  });

  it("still says what is being traded away", () => {
    expect(walletStatus(behind).detail).toContain("300");
    expect(walletStatus(behind).balanceIsFinal).toBe(false);
  });

  it("keeps blocking when the daemon says the anchor is NOT covered", () => {
    const v = walletStatus({ ...behind, spendReady: false, blocksBehind: 2572 });
    expect(v.canSpend).toBe(false);
    expect(v.label).not.toBe("Ready to pay · still catching up");
  });
});
