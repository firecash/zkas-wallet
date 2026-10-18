import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { byNewest, usableTime } from "../src/history";

/**
 * A block header's timestamp is chosen by whoever mined it, and consensus only requires it to
 * sit inside a drift window — so a row can arrive dated in the future. `byNewest` sorts on
 * that value, so one skewed block would sit above every genuinely newer payment permanently,
 * in the one list people scan to find a specific payment.
 *
 * The existing code already refused to believe `timestamp: 0` for the mirror-image reason
 * ("worse than admitting the gap"); this applies the same judgement at the other end.
 */
const HOUR = 60 * 60_000;
const now = Date.UTC(2026, 9, 18, 12, 0, 0);

describe("a block time the device cannot believe is not treated as a time", () => {
  it("accepts ordinary past times", () => {
    expect(usableTime(now - 1, now)).toBe(true);
    expect(usableTime(now - 400 * 24 * HOUR, now)).toBe(true);
  });

  it("tolerates clock error in both directions", () => {
    // The comparison is against the DEVICE clock, which is the thing most likely wrong. A
    // phone an hour behind must not have its own honest history reclassified as undated.
    expect(usableTime(now + HOUR, now)).toBe(true);
    expect(usableTime(now + 2 * HOUR - 1, now)).toBe(true);
  });

  it("refuses an absurd future date", () => {
    expect(usableTime(now + 3 * HOUR, now)).toBe(false);
    expect(usableTime(Date.UTC(2087, 0, 1), now)).toBe(false);
  });

  it("still refuses zero and nonsense", () => {
    expect(usableTime(0, now)).toBe(false);
    expect(usableTime(-1, now)).toBe(false);
    expect(usableTime(Number.NaN, now)).toBe(false);
    expect(usableTime(Number.POSITIVE_INFINITY, now)).toBe(false);
  });

  it("does not let a skewed block outrank genuinely newer payments", () => {
    const rows = [
      { ts: Date.now() - 2 * HOUR, daaScore: 100, id: "older" },
      { ts: Date.UTC(2087, 0, 1), daaScore: 50, id: "skewed" },
      { ts: Date.now() - HOUR, daaScore: 200, id: "newest" },
    ];
    const out = byNewest(rows).map((r) => r.id);
    expect(out[0]).toBe("newest");
    expect(out[1]).toBe("older");
    // Kept, not dropped — it is real history, just undated.
    expect(out[2]).toBe("skewed");
    expect(out).toHaveLength(3);
  });

  it("keeps undated rows in daaScore order among themselves", () => {
    const rows = [
      { ts: 0, daaScore: 10, id: "a" },
      { ts: Date.UTC(2090, 0, 1), daaScore: 30, id: "b" },
      { ts: 0, daaScore: 20, id: "c" },
    ];
    expect(byNewest(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("display agrees with the sort", () => {
  it("both row views use the same predicate, not a bare > 0", () => {
    // If the sort distrusts a timestamp but the row still prints it, the list shows a 2087
    // date on a row placed among the undated ones — worse than either choice alone.
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).not.toMatch(/\{r\.timestamp > 0 \? fmtTime/);
    expect(app).not.toMatch(/\{row\.timestamp > 0 \? fmtTime/);
    expect((app.match(/usableTime\((?:r|row)\.timestamp\)/g) ?? []).length).toBe(2);
  });
});
