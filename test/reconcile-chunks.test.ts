// The optimistic balance subtraction is released by `reconcile`, and for a
// payment split across several transactions that release must be CUMULATIVE:
// the daemon's balance reflects chunk 1 first, and releasing every chunk's
// subtraction at that moment pops money back into the displayed balance that
// the daemon has not accounted for yet.

import { beforeEach, describe, expect, it } from "vitest";
import { loadTxs, pendingTotal, reconcile, recordSend, type LocalTx } from "../src/localtx";

const PAY = "pay_test_1";
let now: number;

const chunk = (txid: string, spentFc: number, ts: number, confs?: number): Omit<LocalTx, "pending"> => ({
  txid,
  to: "zkas:pyw7hwzs2r9a4agcxjeu8ucfq999rvx8dqsaalsz9egnata4c7qhrnyz5mlrqumcx5mezfc8khsvwdu",
  amountFc: spentFc - 0.04,
  feeFc: 0.04,
  ts,
  preFc: 1000, // every chunk of one payment shares the same pre-send balance
  spentFc,
  payId: PAY,
  confs,
});

describe("reconcile releases a chunked payment cumulatively", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "testtoken");
    now = Date.now();
    recordSend(chunk("c1", 100, now - 3000));
    recordSend(chunk("c2", 100, now - 2000));
    recordSend(chunk("c3", 100, now - 1000));
  });

  it("releases only the chunks the observed balance drop covers", () => {
    // Daemon scanned chunk 1: balance fell 1000 → 900.
    reconcile(900, true);
    const rows = loadTxs();
    expect(rows.find((r) => r.txid === "c1")?.pending).toBe(false);
    expect(rows.find((r) => r.txid === "c2")?.pending).toBe(true);
    expect(rows.find((r) => r.txid === "c3")?.pending).toBe(true);
    // Displayed = 900 - 200 still pending — exactly the daemon's truth-in-flight.
    expect(pendingTotal(rows)).toBeCloseTo(200, 6);
  });

  it("releases everything once the full payment is reflected", () => {
    reconcile(700, true);
    expect(pendingTotal(loadTxs())).toBe(0);
  });

  it("releases nothing while the daemon still shows the pre-send balance", () => {
    reconcile(1000, true);
    expect(pendingTotal(loadTxs())).toBeCloseTo(300, 6);
  });

  it("ages out an unanswered send, but a chain-confirmed one survives the 20-minute mark", () => {
    localStorage.clear();
    recordSend({ ...chunk("dead", 100, now - 25 * 60 * 1000), payId: "g1" });
    recordSend({ ...chunk("live", 100, now - 25 * 60 * 1000, 12), payId: "g2" });
    // Daemon balance never moved (rescan/congestion): the drop test can't fire.
    reconcile(1000, true);
    const rows = loadTxs();
    expect(rows.find((r) => r.txid === "dead")?.pending).toBe(false);
    // Provably gone on-chain — re-crediting it would invent spendable money.
    expect(rows.find((r) => r.txid === "live")?.pending).toBe(true);
  });

  it("treats rows without a payId as their own payment (legacy records)", () => {
    localStorage.clear();
    recordSend({ ...chunk("solo", 100, now - 1000), payId: undefined });
    reconcile(900, true);
    expect(loadTxs()[0].pending).toBe(false);
  });
});
