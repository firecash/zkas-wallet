import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ownActivityExplainsRise, quietUntil } from "../src/arrivals";
import { skipPollWhileFailing } from "../src/lib/pollbackoff";
import { shouldRunMaintenance } from "../src/maintenance";

/**
 * A follow-up to the elapsed-time sweep, and a correction to it. That pass grepped for
 * `Date.now() - X` and so matched only sites that call the clock inline. Every site that
 * subtracts from a `now` PARAMETER — the testable shape this codebase prefers — was invisible
 * to it, and there were nine more, two of them written during this same audit.
 *
 * The failure is identical: `now - stored < LIMIT` treats a negative as "just happened", so
 * under a backward clock step the poll backoff skips forever, maintenance is always "too soon",
 * a missing wallet reads as "still opening", and a real incoming payment is attributed to the
 * owner's own activity and never announced.
 */
// SETTLING_WINDOW_MS is 20 minutes, so a fixture must be well OUTSIDE it to mean anything.
// My first attempt used a send from 15 minutes ago and asserted it explained nothing — which
// was wrong about the code, not a bug in it.
const WELL_OUTSIDE_MS = 2 * 60 * 60_000;

describe("elapsed decisions that take `now` as a parameter", () => {
  it("a backward clock does not make every past send look like it just settled", () => {
    const now = 1_000_000;
    const old = { ts: now - WELL_OUTSIDE_MS, pending: false, amountFc: 1 } as never;
    // Honest clock: an old send explains nothing.
    expect(ownActivityExplainsRise([old], now)).toBe(false);
    // Clock stepped BACK an hour: it still must explain nothing.
    expect(ownActivityExplainsRise([old], now - 3_600_000)).toBe(false);
  });

  it("a backward clock does not hold the notification quiet window open", () => {
    const now = 1_000_000;
    const old = { ts: now - WELL_OUTSIDE_MS, pending: false, amountFc: 1 } as never;
    expect(quietUntil([old], now - 3_600_000)).toBe(0);
  });

  it("the poll backoff does not skip forever under a backward clock", () => {
    // 200 failures and the last attempt "in the future": must NOT skip.
    expect(skipPollWhileFailing(200, 1_000_000 + 60_000, 1_000_000)).toBe(false);
    // And it still skips when the last attempt was genuinely moments ago.
    expect(skipPollWhileFailing(200, 1_000_000 - 1_000, 1_000_000)).toBe(true);
  });

  it("maintenance is not permanently 'too soon' under a backward clock", () => {
    const ok = {
      status: { synced: true, spend_ready: true, note_count: 100, spendable_sompi: "9999999999", address: "zkas:q" } as never,
      busy: false,
      enabled: true,
      now: 1_000_000,
    };
    // lastRunAt in the FUTURE (clock stepped back): must not block the run.
    expect(shouldRunMaintenance({ ...ok, lastRunAt: 1_000_000 + 3_600_000 }).run).toBe(true);
    // A genuine recent run still blocks it.
    expect(shouldRunMaintenance({ ...ok, lastRunAt: 1_000_000 - 1_000 }).run).toBe(false);
  });

  it("no decision site is left subtracting from a bare `now`", () => {
    for (const [f, snippet] of [
      ["src/arrivals.ts", "elapsedSince(s.ts, now)"],
      ["src/maintenance.ts", "elapsedSince(lastRunAt, now)"],
      ["src/maintenance.ts", "elapsedSince(input.lastFailureAt, now)"],
      ["src/lib/pollbackoff.ts", "elapsedSince(lastAttemptMs, now)"],
      ["src/timing.ts", "elapsedSince(s.at, now)"],
      ["src/api.ts", "elapsedSince(previous.at, now)"],
      ["src/App.tsx", "elapsedSince(missingSince.current, now)"],
      ["src/App.tsx", "elapsedSince(lastRepairAt.current, now)"],
    ] as const) {
      expect(readFileSync(f, "utf8"), `${f}: ${snippet}`).toContain(snippet);
    }
  });
});
