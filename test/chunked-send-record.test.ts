// A payment too large for one transaction is broadcast as several. The wallet has
// to record each one, because each carries only its own share of the total.

import { beforeEach, describe, expect, it } from "vitest";
import { loadTxs, recordSend, type LocalTx } from "../src/localtx";

const part = (txid: string, amountFc: number): Omit<LocalTx, "pending"> => ({
  txid,
  to: "zkas:pyw7hwzs2r9a4agcxjeu8ucfq999rvx8dqsaalsz9egnata4c7qhrnyz5mlrqumcx5mezfc8khsvwdu",
  amountFc,
  feeFc: 0.0438,
  ts: Date.now(),
  preFc: 3000,
  spentFc: amountFc + 0.0438,
});

describe("recording a payment split across transactions", () => {
  beforeEach(() => localStorage.clear());

  it("keeps one row per transaction, each with its own amount", () => {
    // 2700 ZKAS that had to go out as 8 transactions of ~359.96 each. Filing the
    // whole 2700 under the first txid claimed that transaction paid 7x what it did,
    // and lost the other seven entirely.
    const parts = [part("t1", 359.96), part("t2", 359.96), part("t3", 359.96)];
    for (const p of parts) recordSend(p);

    const rows = loadTxs();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.txid).sort()).toEqual(["t1", "t2", "t3"]);
    for (const r of rows) expect(r.amountFc).toBeCloseTo(359.96, 6);
    // The parts together account for the payment, and no row overstates itself.
    expect(rows.reduce((s, r) => s + r.amountFc, 0)).toBeCloseTo(1079.88, 6);
  });

  it("is idempotent per txid, so a replayed part does not double-count", () => {
    recordSend(part("t1", 359.96));
    recordSend(part("t1", 359.96));
    expect(loadTxs()).toHaveLength(1);
  });

  it("still records a single-transaction payment normally", () => {
    recordSend(part("solo", 12.5));
    const rows = loadTxs();
    expect(rows).toHaveLength(1);
    expect(rows[0].amountFc).toBe(12.5);
    expect(rows[0].pending).toBe(true);
  });
});
