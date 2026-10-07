// The suppression in arrivals.ts is only as good as what it is handed.
//
// `refresh` in App.tsx is a useCallback whose dependencies reduce to [], so it
// is built once at mount and every value it closes over is frozen there. It
// used to pass the `txs` STATE into `arrivalAmount`, which meant a send made
// during this session was invisible to the check — and the change note coming
// back ~10 minutes later was announced as "Received N ZKAS". That is the exact
// live report arrivals.ts was written to fix.
//
// This test pins the property that makes the wiring correct: the send history
// must be read from storage at call time, because that is what `recordSend`
// writes and what survives a frozen closure.

import { beforeEach, describe, expect, it } from "vitest";
import { arrivalAmount } from "../src/arrivals";
import { loadTxs, recordSend } from "../src/localtx";

beforeEach(() => localStorage.clear());

describe("send history reaches the arrival check", () => {
  it("recordSend is visible to a later loadTxs() — the frozen-closure escape", () => {
    // Snapshot taken at "mount", the way the old code captured `txs`.
    const atMount = loadTxs();
    expect(atMount).toEqual([]);

    recordSend({ txid: "a".repeat(64), amountFc: 100, feeFc: 0.03, spentFc: 100.03, ts: Date.now() });

    // The mount-time snapshot still shows nothing — this is the staleness.
    expect(atMount).toEqual([]);
    // A fresh read sees it. This is why the call site must re-read.
    expect(loadTxs()).toHaveLength(1);
  });

  it("the stale snapshot announces a false arrival; the fresh read stays silent", () => {
    const now = Date.now();
    const atMount = loadTxs();
    recordSend({ txid: "b".repeat(64), amountFc: 100, feeFc: 0.03, spentFc: 100.03, ts: now });

    const sends = (rows: ReturnType<typeof loadTxs>) => rows.map((r) => ({ ts: r.ts, pending: r.pending }));

    // Balance dips while the input note is parked, then the change returns.
    const dipped = 50;
    const changeBack = 150;

    // What the old wiring did: announce someone else paid you 100.
    expect(arrivalAmount(dipped, changeBack, true, sends(atMount), now)).toBe(100);
    // What reading at call time does: recognise our own settling send.
    expect(arrivalAmount(dipped, changeBack, true, sends(loadTxs()), now)).toBeNull();
  });
});
