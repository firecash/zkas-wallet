import { beforeEach, describe, expect, it } from "vitest";
import { lagOf, recordSyncSample, resetSyncSamples, SETTLE_MARGIN, syncRate, TIP_SLACK } from "../src/lib/syncrate";

// walletd never ingests the last SYNC_TIP_MARGIN (200 blue score) blocks: its tree is
// append-only and a near-tip reorg could otherwise corrupt it. Payments in that window are
// trial-decrypted as a 0-conf preview and show as pending at once. So a caught-up wallet
// rests ~200-260 DAA behind the tip by design, and the sync-rate view has to measure lag
// from the settled point, not from the tip.
//
// The sequences below are (seconds, scanned, tip) readings from the first real on-device
// run (Android 14, fresh wallet, 2026-10-22, diag log sync.progress).
const T0 = 1_792_689_000_000;
function feed(rows: [number, number, number][]): void {
  for (const [s, scanned, tip] of rows) recordSyncSample(scanned, tip, "http://127.0.0.1:46199", T0 + s * 1000);
}

beforeEach(() => resetSyncSamples());

describe("sync rate against the settlement margin", () => {
  it("a fresh wallet waiting at its birthday for blocks to settle is not stalled", () => {
    // 17:15:53 .. 17:18:15: scanned held at the birthday while the tip moved 149 blocks.
    feed([
      [0, 7616195, 7616300],
      [15, 7616195, 7616308],
      [31, 7616195, 7616326],
      [47, 7616195, 7616343],
      [63, 7616195, 7616360],
      [79, 7616195, 7616378],
      [95, 7616195, 7616399],
      [110, 7616195, 7616415],
      [126, 7616195, 7616430],
      [142, 7616195, 7616449],
    ]);
    const r = syncRate(T0 + 142_000);
    expect(r.behind).toBe(254);
    expect(r.lag).toBe(0);
    // Before: behind > 0 and no movement for 142 s read as "STALLED (no progress)".
    expect(r.stalled).toBe(false);
    expect(r.etaSecs).toBeNull();
  });

  it("a caught-up wallet resting 203-254 blocks behind has no lag and no ETA", () => {
    // 17:18:31 .. 17:22:01: ingest passes every ~45-75 s, 55-74 blocks each.
    feed([
      [0, 7616264, 7616467],
      [15, 7616264, 7616483],
      [30, 7616264, 7616500],
      [46, 7616264, 7616515],
      [61, 7616319, 7616526],
      [76, 7616322, 7616542],
      [92, 7616322, 7616559],
      [108, 7616322, 7616576],
      [143, 7616396, 7616615],
      [160, 7616396, 7616628],
      [195, 7616460, 7616664],
      [210, 7616460, 7616681],
    ]);
    const r = syncRate(T0 + 210_000);
    expect(r.behind).toBe(221);
    expect(r.lag).toBe(0);
    expect(r.stalled).toBe(false);
    expect(r.etaSecs).toBeNull();
    // It does move at the chain's own pace (~1 block/s).
    expect(r.blocksPerSec).toBeGreaterThan(0.8);
    expect(r.blocksPerSec).toBeLessThan(1.2);
  });

  it("a wallet catching up gets an ETA to the settled point, not to the tip", () => {
    // 17:39:29 relaunch after 17 minutes away: 1,285 behind, then 771 blocks in ~2 s.
    feed([
      [0, 7616460, 7617745],
      [2, 7616775, 7617745],
    ]);
    const r = syncRate(T0 + 2000);
    expect(r.behind).toBe(970);
    expect(r.lag).toBe(970 - SETTLE_MARGIN - TIP_SLACK);
    expect(r.etaSecs).toBeCloseTo(r.lag / r.blocksPerSec!, 6);
  });

  it("a wallet genuinely not moving well past the margin is still stalled", () => {
    feed([
      [0, 7_000_000, 7_005_000],
      [30, 7_000_000, 7_005_030],
      [60, 7_000_000, 7_005_060],
    ]);
    const r = syncRate(T0 + 60_000);
    expect(r.lag).toBeGreaterThan(4000);
    expect(r.stalled).toBe(true);
    expect(r.etaSecs).toBeNull();
  });

  it("lag starts exactly past margin + slack", () => {
    expect(SETTLE_MARGIN).toBe(200); // zkas-walletd SYNC_TIP_MARGIN
    expect(lagOf(0)).toBe(0);
    expect(lagOf(SETTLE_MARGIN + TIP_SLACK)).toBe(0);
    expect(lagOf(SETTLE_MARGIN + TIP_SLACK + 1)).toBe(1);
  });
});
