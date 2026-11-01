import { describe, it, expect } from "vitest";
import { birthdayFromDate, estimatedTipDaa } from "../src/lib/birthday";

// A "created on" date must never become a genesis scan just because the tip is not known yet
// (the on-phone engine reads 0 until it reaches its node). Live report 2026-11-01: a wallet
// added with a date was registered "birthday 0, requested 0" and scanned 8.4 M blocks.
const NOW = 1793525636_000; // live: gateway virtual_daa_score 8,452,708 at this instant
const LIVE_TIP = 8_452_708;

describe("birthdayFromDate", () => {
  it("estimates the tip from the clock, erring early (the real tip ran 0.04% ahead)", () => {
    const est = estimatedTipDaa(NOW);
    expect(est).toBeLessThanOrEqual(LIVE_TIP);
    expect(LIVE_TIP - est).toBeLessThan(10_000);
  });

  it("gives a real birthday when the tip is unknown", () => {
    const b = birthdayFromDate("2026-10-02", 0, NOW);
    expect(b).toBeGreaterThan(5_000_000);
    // ...and never later than the one computed from the true tip.
    expect(b).toBeLessThanOrEqual(birthdayFromDate("2026-10-02", LIVE_TIP, NOW));
  });

  it("uses the known tip, two days early", () => {
    const created = new Date("2026-10-02T00:00:00").getTime();
    const age = Math.floor((NOW - created) / 1000);
    expect(birthdayFromDate("2026-10-02", LIVE_TIP, NOW)).toBe(LIVE_TIP - age - 2 * 86_400);
  });

  it("returns 0 only for no date, a bad date or a future date", () => {
    expect(birthdayFromDate("", LIVE_TIP, NOW)).toBe(0);
    expect(birthdayFromDate("not-a-date", LIVE_TIP, NOW)).toBe(0);
    expect(birthdayFromDate("2027-01-01", LIVE_TIP, NOW)).toBe(0);
  });
});
