import { describe, it, expect, beforeEach } from "vitest";
import { reconcile, recordSend, loadTxs, pendingTotal } from "../src/localtx";

// The optimistic subtraction exists so a just-sent payment is not counted twice
// before the daemon's balance catches up. Releasing it was keyed on the balance
// DROPPING by the amount spent — which money arriving in the same window masks.
describe("pending send released when money arrives too", () => {
  beforeEach(() => localStorage.clear());

  const send = (preFc: number, spentFc: number) =>
    recordSend({
      txid: "tx1", to: "zkas:p".padEnd(20, "x"), amountFc: spentFc - 0.018554,
      feeFc: 0.018554, ts: Date.now(), preFc, spentFc, payId: "pay1",
    });

  it("a credit during the send no longer wedges the balance low", () => {
    send(100, 5.018554);
    expect(pendingTotal(loadTxs())).toBeCloseTo(5.018554, 6);

    // Daemon: 100 - 5.018554 spent + 2.0 received = 96.981446. The drop is only
    // 3.018554 against a 5.018554 subtraction, so the drop test alone fails...
    expect(pendingTotal(reconcile(96.981446, true, 0))).toBeCloseTo(5.018554, 6);

    // ...but the daemon reports the outflow it has seen, which no credit can mask.
    expect(pendingTotal(reconcile(96.981446, true, 5.018554))).toBe(0);
  });

  it("still holds the subtraction when the daemon has seen nothing yet", () => {
    send(100, 5.018554);
    // Balance unchanged, no outflow reported: the send is not accounted for and
    // releasing here would show the money twice.
    expect(pendingTotal(reconcile(100, true, 0))).toBeCloseTo(5.018554, 6);
  });

  it("releases on the balance drop alone, as before", () => {
    send(100, 5.018554);
    expect(pendingTotal(reconcile(94.981446, true, 0))).toBe(0);
  });
});
