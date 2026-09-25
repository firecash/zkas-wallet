// The "Opening your wallet" bar is a blocking, contentless state. It should appear only
// when the daemon genuinely has nothing true to say — not for the length of a restore.
//
// Measured on the hosted daemon: a cold `restore` is a median of 8.8 s and a p90 of 93.6 s,
// because a checkpoint is 177-522 MB. The daemon now persists each wallet's last-known
// status and serves it while the real one loads, so `loading` normally arrives WITH a real
// cursor and balance. Blocking on a bar while holding the answer is what these tests exist
// to prevent.

import { describe, expect, it } from "vitest";
import { walletStatus, type StatusInput } from "../src/status";

const base: StatusInput = {
  online: true,
  synced: false,
  scannedBlocks: 0,
  chainLen: 5_000_000,
  warming: false,
  haveConfirmedBalance: false,
  etaSeconds: null,
};

describe("the opening bar", () => {
  it("shows when the daemon knows nothing at all", () => {
    // A first-ever open, or a restart before any snapshot exists: a zero cursor is the
    // honest trigger, and nothing downstream may describe the balance.
    expect(walletStatus({ ...base, loading: true }).phase).toBe("opening");
    expect(walletStatus({ ...base, loading: false }).phase).toBe("opening");
  });

  it("does NOT show while loading if the last-known cursor is real", () => {
    // This is the whole point: the daemon is restoring, but it already told us where this
    // wallet was. Showing a blocking bar instead of that is the 8.8-93.6 s wait.
    const v = walletStatus({
      ...base,
      loading: true,
      scannedBlocks: 4_999_000,
      haveConfirmedBalance: true,
    });
    expect(v.phase).not.toBe("opening");
    expect(v.balanceIsFinal).toBe(false);
  });

  it("never lets a last-known view offer a spend", () => {
    // `apply_last_known` forces spend_ready false on the daemon, because a wallet that is
    // not in memory cannot pay. If the client offered Send here, /prepare would refuse it.
    const v = walletStatus({
      ...base,
      loading: true,
      scannedBlocks: 4_999_000,
      spendReady: false,
      haveConfirmedBalance: true,
    });
    expect(v.canSpend).toBe(false);
  });

  it("still catches the stale-synced hazard the guard was written for", () => {
    // A wallet re-opened after a daemon restart can briefly hold `synced: true` over a
    // zero balance. That must never be announced as a final balance of 0.
    const v = walletStatus({ ...base, synced: true, loading: true, scannedBlocks: 0 });
    expect(v.phase).toBe("opening");
    expect(v.balanceIsFinal).toBe(false);
  });

  it("offline still wins over everything", () => {
    expect(walletStatus({ ...base, online: false, loading: true, scannedBlocks: 4_999_000 }).phase).toBe("offline");
  });
});
