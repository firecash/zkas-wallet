import { describe, expect, it } from "vitest";
import { byNewest, receiptIsOnChain } from "../src/history";

describe("putting history in time order", () => {
  // The reported bug, verbatim: an arrival at 12:23, an arrival at 12:12 and a send at
  // 12:19 were rendered as two concatenated blocks, so the send fell below both arrivals
  // instead of between them.
  it("interleaves arrivals and sends by time, not by source", () => {
    const rows = [
      { id: "recv-1223", ts: Date.parse("2026-08-12T12:23:25Z") },
      { id: "recv-1212", ts: Date.parse("2026-08-12T12:12:22Z") },
      { id: "sent-1219", ts: Date.parse("2026-08-12T12:19:00Z") },
    ];
    expect(byNewest(rows).map((r) => r.id)).toEqual(["recv-1223", "sent-1219", "recv-1212"]);
  });

  // A chain row whose node served no block metadata has timestamp 0. Sorting that as a
  // date puts real history below everything else, stamped 1970.
  it("keeps undated rows together at the end, in chain order", () => {
    const rows = [
      { id: "old-a", ts: 0, daaScore: 100 },
      { id: "dated", ts: Date.parse("2026-08-12T12:00:00Z") },
      { id: "old-b", ts: 0, daaScore: 500 },
    ];
    expect(byNewest(rows).map((r) => r.id)).toEqual(["dated", "old-b", "old-a"]);
  });

  it("is stable for an empty list", () => {
    expect(byNewest([])).toEqual([]);
  });
});

describe("not showing one payment twice", () => {
  const chain = [{ kind: "received", amountZkas: 1.81, timestamp: Date.parse("2026-08-12T12:20:00Z") }];

  // The device notices an arrival on its next poll — AFTER the block. So a receipt's
  // time trails the chain row's, and the match has to tolerate that lag.
  it("matches an inferred arrival to the chain row it duplicates", () => {
    expect(receiptIsOnChain({ amountFc: 1.81, ts: Date.parse("2026-08-12T12:23:25Z") }, chain)).toBe(true);
  });

  it("does not match a different amount", () => {
    expect(receiptIsOnChain({ amountFc: 2.84, ts: Date.parse("2026-08-12T12:23:25Z") }, chain)).toBe(false);
  });

  it("does not match an arrival hours later that happens to be the same size", () => {
    expect(receiptIsOnChain({ amountFc: 1.81, ts: Date.parse("2026-08-12T18:00:00Z") }, chain)).toBe(false);
  });

  // An undated chain row cannot prove anything about when a receipt happened, so it must
  // not silently swallow one.
  it("never matches against an undated chain row", () => {
    expect(receiptIsOnChain({ amountFc: 1.81, ts: Date.now() }, [{ kind: "received", amountZkas: 1.81, timestamp: 0 }])).toBe(false);
  });
});

// Insertion order decides ties, and Array.prototype.sort has been stable since ES2019 —
// so equal timestamps keep a deterministic order rather than shuffling between polls.
// A list that reorders under the 15s refresh looks like rows appearing and vanishing.
describe("ties do not reshuffle", () => {
  it("preserves input order for identical timestamps", () => {
    const t = Date.parse("2026-08-12T12:00:00Z");
    const rows = [{ id: "a", ts: t }, { id: "b", ts: t }, { id: "c", ts: t }];
    expect(byNewest(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(byNewest(byNewest(rows)).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
