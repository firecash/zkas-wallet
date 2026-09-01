import { describe, expect, it } from "vitest";
import { isConsolidationRow } from "../src/history";

describe("consolidation detection (no false positives on real sends)", () => {
  it("flags a self-only send: no recipient AND amount 0 (all value returned as change, minus fee)", () => {
    expect(isConsolidationRow({ kind: "sent", recipient: null, amountSompi: 0 })).toBe(true);
  });
  it("does NOT flag a normal send to a payee — the exact bug we shipped", () => {
    // A real send: recipient is the payee, amount is the amount sent. Its change
    // comes back to the wallet (a separate received row), which must NOT turn the
    // send into a 'consolidation' showing only the fee.
    expect(isConsolidationRow({ kind: "sent", recipient: "zkas:ppayee", amountSompi: 300000000 })).toBe(false);
  });
  it("does NOT flag a send whose recipient couldn't be recovered but that moved a real amount", () => {
    expect(isConsolidationRow({ kind: "sent", recipient: null, amountSompi: 300000000 })).toBe(false);
  });
  it("does not flag receives or coinbase", () => {
    expect(isConsolidationRow({ kind: "received", recipient: null, amountSompi: 0 })).toBe(false);
    expect(isConsolidationRow({ kind: "coinbase", recipient: null, amountSompi: 0 })).toBe(false);
  });
});
