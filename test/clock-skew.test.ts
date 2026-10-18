import { beforeEach, describe, expect, it } from "vitest";
import { elapsedSince } from "../src/lib/elapsed";
import { loadTxs, pendingTotal, recordSend, reconcile } from "../src/localtx";

/**
 * A clock that steps BACKWARDS — an NTP correction, a timezone fixed the wrong way, a
 * laptop waking with a stale RTC.
 *
 * Every decision phrased as `Date.now() - stored > limit` silently inverts, and three in
 * this app stuck on the wrong answer for as long as the skew lasted: the app lock stopped
 * auto-locking, the pending-spend subtraction stopped ageing out so the balance stayed
 * understated, and the price under the balance stopped refreshing.
 */
describe("elapsedSince", () => {
  const T = 1_700_000_000_000;

  it("measures a normal interval", () => {
    expect(elapsedSince(T, T + 5_000)).toBe(5_000);
  });

  it("reports a FUTURE timestamp as unbounded, not as negative", () => {
    // The whole point: a duration we cannot trust must land every caller on its safe side
    // — lock, release the subtraction, refetch — rather than on "no time at all".
    expect(elapsedSince(T, T - 600_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("absorbs sub-second jitter rather than tripping an age-out", () => {
    // Two Date.now() reads can disagree slightly on some platforms; that is not a clock step.
    expect(elapsedSince(T, T - 200)).toBe(0);
  });

  it("treats a missing or nonsense timestamp as unbounded", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(elapsedSince(bad as number, T)).toBe(Number.POSITIVE_INFINITY);
    }
  });
});

describe("a pending spend when the clock steps back", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
  });

  it("still ages out, so the balance returns to the daemon's truth", () => {
    // The subtraction exists so a send shows immediately; the age-out exists so it always
    // self-heals to whatever the daemon says. A backwards clock defeated that permanently —
    // `now - ts > maxAge` could never become true again.
    recordSend({
      txid: "a".repeat(64), to: "zkas:x", amountFc: 5, feeFc: 0.03,
      ts: Date.now() + 3_600_000,          // stamped in the future by the skew
      preFc: 100, spentFc: 5.03,
    });
    expect(pendingTotal(loadTxs())).toBeGreaterThan(0);

    // preFc > 0 and synced, but the daemon's balance has NOT dropped — so only the age-out
    // can release this.
    const after = reconcile(100, true);
    expect(after.find((t) => t.pending)).toBeUndefined();
    expect(pendingTotal(after)).toBe(0);
  });
});
