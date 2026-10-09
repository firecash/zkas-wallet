import { describe, it, expect, beforeEach } from "vitest";
import { reconcile, recordSend, loadTxs, pendingTotal } from "../src/localtx";

// The optimistic subtraction is released ONLY when the daemon's own balance
// drops, or by age-out. Never on a chain signal: a shielded spend confirms in
// about a second but the daemon re-scans minutes later, so releasing early made
// the sent coins reappear (10 -> 6 -> 10 -> 6). I briefly released on
// `pending_out_fc`, which is exactly that chain signal; these pin the rule.
describe("the pending-send subtraction", () => {
  beforeEach(() => localStorage.clear());

  const send = (preFc: number, spentFc: number) =>
    recordSend({
      txid: "tx1", to: "zkas:p".padEnd(20, "x"), amountFc: spentFc - 0.018554,
      feeFc: 0.018554, ts: Date.now(), preFc, spentFc, payId: "pay1",
    });

  it("is released when the daemon's balance actually drops", () => {
    send(100, 5.018554);
    expect(pendingTotal(reconcile(94.981446, true))).toBe(0);
  });

  it("is HELD while the daemon still reports the old balance", () => {
    send(100, 5.018554);
    // The chain may already have the spend; the daemon has not applied it.
    // Releasing here is what made the coins reappear.
    expect(pendingTotal(reconcile(100, true))).toBeCloseTo(5.018554, 6);
  });

  it("is held when a credit masks the drop, rather than released early", () => {
    send(100, 5.018554);
    // 100 - 5.018554 spent + 2.0 received. The drop is only 3.018554, so it is
    // not yet proof the spend landed. Holding shows a balance that is too LOW
    // for a while; releasing would show money that is already gone, and the
    // Send screen now subtracts the daemon's own pendingOut so it cannot offer
    // to spend it.
    expect(pendingTotal(reconcile(96.981446, true))).toBeCloseTo(5.018554, 6);
  });
});
