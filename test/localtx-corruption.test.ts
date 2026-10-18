import { beforeEach, describe, expect, it } from "vitest";
import { loadTxs } from "../src/localtx";
import { tickedConfirmations, confirmationLabel } from "../src/confirmations";

/**
 * The device's own send list is persisted JSON, and only its ARRAY-ness was ever checked.
 * Anything inside it travelled straight to the screen and into the optimistic balance.
 */
const KEY = "local_txs_0123456789abcdef0123456789abcdef";
const good = {
  txid: "a".repeat(64), to: "zkas:x", amountFc: 1, feeFc: 0.03, ts: 1_700_000_000_000,
  preFc: 10, spentFc: 1.03, pending: true,
};

describe("a corrupt local send record", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
  });

  it("no longer reaches the screen as NaN confirmations", () => {
    // confAt as a string made `now - serverAt` NaN, which survived Math.max, floor and
    // Math.min untouched; confirmationLabel then printed it, because NaN <= 0 is false.
    localStorage.setItem(KEY, JSON.stringify([{ ...good, confs: 2, confAt: "yesterday" }]));
    const [row] = loadTxs();
    expect(row.confAt).toBeUndefined();
    const n = tickedConfirmations({ serverConfs: row.confs ?? null, serverAt: row.confAt ?? 0 });
    expect(Number.isFinite(n as number)).toBe(true);
    expect(confirmationLabel(n, 0)).not.toContain("NaN");
  });

  it("drops a record whose IDENTITY, amount or timing cannot be read", () => {
    // Dropped rather than repaired: inventing an amount puts a wrong number in a list of
    // payments, which is worse than a missing line — the rule saneHistory already states.
    localStorage.setItem(KEY, JSON.stringify([
      good,
      { ...good, txid: "" },
      { ...good, amountFc: "lots" },
      { ...good, ts: null },
      "not even an object",
      null,
    ]));
    const rows = loadTxs();
    expect(rows).toHaveLength(1);
    expect(rows[0].txid).toBe("a".repeat(64));
  });

  it("KEEPS a record missing a defaultable money field, rather than losing the payment", () => {
    // The first version of this guard required preFc, feeFc and spentFc, and two existing
    // tests caught it: recordSend is called without preFc. Requiring them would have
    // deleted real history, including everything written by an older build. 0 is already a
    // defined state downstream — reconcile reads preFc <= 0 as "balance unknown when this
    // was recorded" and ages the row out instead of testing a drop.
    localStorage.setItem(KEY, JSON.stringify([
      { txid: "b".repeat(64), amountFc: 2, ts: 1_700_000_000_001, pending: true },
    ]));
    const [row] = loadTxs();
    expect(row.txid).toBe("b".repeat(64));
    expect(row.preFc).toBe(0);
    expect(row.feeFc).toBe(0);
    expect(row.spentFc).toBe(0);
  });

  it("keeps a normal unconfirmed send, which has no confirmation fields at all", () => {
    // The common case must not be mistaken for corruption.
    localStorage.setItem(KEY, JSON.stringify([good]));
    expect(loadTxs()).toHaveLength(1);
  });

  it("survives a stored value that is not an array", () => {
    for (const junk of ['{"a":1}', '"text"', "null", "7", "["]) {
      localStorage.setItem(KEY, junk);
      expect(() => loadTxs()).not.toThrow();
      expect(loadTxs()).toEqual([]);
    }
  });
});

describe("tickedConfirmations with unusable inputs", () => {
  it("treats a non-finite timestamp as now rather than poisoning the count", () => {
    for (const at of [NaN, Infinity, undefined as unknown as number]) {
      const n = tickedConfirmations({ serverConfs: 3, serverAt: at, now: 1_000_000 });
      expect(Number.isFinite(n as number), `serverAt=${String(at)}`).toBe(true);
      expect(n).toBeGreaterThanOrEqual(3);
    }
  });

  it("ignores a non-finite lastShown instead of returning it", () => {
    expect(tickedConfirmations({ serverConfs: null, serverAt: 0, lastShown: NaN })).toBeNull();
    const n = tickedConfirmations({ serverConfs: 1, serverAt: 1_000_000, lastShown: NaN, now: 1_000_000 });
    expect(n).toBe(1);
  });

  it("still keeps the count monotonic for sane inputs", () => {
    // The property this function exists for: a payment does not un-confirm because one
    // poll came back lower or not at all.
    expect(tickedConfirmations({ serverConfs: 2, serverAt: 1_000, lastShown: 9, now: 1_000 })).toBe(9);
    expect(tickedConfirmations({ serverConfs: null, serverAt: 1_000, lastShown: 4 })).toBe(4);
  });
});
