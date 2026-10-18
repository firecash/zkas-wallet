import { beforeEach, describe, expect, it } from "vitest";
import { applyChainStatus, applyPendingCleared, loadTxs, pendingTotal, recordSend, reconcile } from "../src/localtx";

/**
 * The device's send list is shared between tabs, and `reconcile` writes it on EVERY poll in
 * EVERY tab. So the window is not theoretical: any send made while a second tab is open had
 * its record overwritten by that tab's next reconcile.
 *
 * Losing the record loses the optimistic subtraction with it, so the balance goes back to
 * showing coins that have already left — and the obvious thing to do with a balance that
 * still shows the money is to send it again.
 */
const KEY = "local_txs_0123456789abcdef0123456789abcdef";
const send = (txid: string, amountFc: number) => ({
  txid, to: "zkas:x", amountFc, feeFc: 0.03, ts: Date.now(),
  preFc: 100, spentFc: amountFc + 0.03,
});

describe("the send list under a concurrent writer", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
  });

  it("keeps a send that lands between another tab's decide and write", () => {
    // The actual interleaving, which needs the two phases apart — with both inside one
    // function a single-tab test cannot reproduce it, because reconcile then reads AFTER
    // recordSend has already written. The first version of this test passed against the
    // unfixed code for exactly that reason.
    recordSend(send("old", 1));

    // Tab B's poll decides: "old" has settled, clear its pending flag.
    const decided = new Set(["old"]);
    const capturedAtDecide = loadTxs();

    // Tab A records a send in the gap.
    recordSend(send("NEW", 5));

    // Tab B now writes.
    applyPendingCleared(decided);
    void capturedAtDecide;

    const after = loadTxs();
    expect(after.map((t) => t.txid)).toContain("NEW");
    // The subtraction for the new send is still in force, which is the part that matters:
    // lose it and the balance shows coins that already left.
    expect(pendingTotal(after)).toBeGreaterThanOrEqual(5);
    // And tab B's own decision was still applied.
    expect(after.find((t) => t.txid === "old")?.pending).toBe(false);
  });

  it("still clears a settled send's pending flag", () => {
    // The thing reconcile is for must keep working.
    recordSend(send("settled", 10));
    const cleared = reconcile(100 - 10.03, true);     // daemon balance dropped by the spend
    expect(cleared.find((t) => t.txid === "settled")?.pending).toBe(false);
    expect(pendingTotal(cleared)).toBe(0);
  });

  it("does not lose a send to a concurrent confirmation update", () => {
    recordSend(send("a", 2));
    recordSend(send("b", 3));
    applyChainStatus("a", 1);
    expect(loadTxs().map((t) => t.txid).sort()).toEqual(["a", "b"]);
  });
});

describe("the structural guarantee, which is what actually holds", () => {
  it("every write goes through mutate(), so no writer can persist a stale list", async () => {
    // This matters more than the behavioural test above, which documents the property but
    // CANNOT fail against the old code: the old shape — writing a list captured earlier in
    // the function — is no longer expressible through this module's API, because the only
    // call site of save() is inside mutate(), which re-reads.
    //
    // Checked structurally for that reason. If a future writer calls save() directly it
    // reintroduces the race, and this fails instead of a send record quietly disappearing.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/localtx.ts", "utf8");
    const calls = [...src.matchAll(/^\s*save\(/gm)];
    expect(calls).toHaveLength(1);
    // And that one call is the one inside mutate.
    const mutateAt = src.indexOf("function mutate(");
    const mutateEnd = src.indexOf("\n}", mutateAt);
    expect(calls[0].index!).toBeGreaterThan(mutateAt);
    expect(calls[0].index!).toBeLessThan(mutateEnd);
  });

  it("applyPendingCleared cannot be handed a list at all", () => {
    // The decide phase passes a SET of txids, never rows. Were it to accept rows, a caller
    // could hand it the stale list again and the race would be back.
    expect(applyPendingCleared.length).toBe(1);
  });
});
