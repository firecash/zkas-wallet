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
 * and a missing wallet reads as "still opening".
 *
 * `arrivals.ts` is the one place that wants the OTHER answer, and this file asserted the wrong
 * one for it. There, "a long time ago" means the user's own change note landing is announced to
 * them as a payment received, and arrivals.ts ranks that above a missed notification in so many
 * words. So its clock-step case stays QUIET; see `stillSettling` there.
 */
// SETTLING_WINDOW_MS is 20 minutes, so a fixture must be well OUTSIDE it to mean anything.
// My first attempt used a send from 15 minutes ago and asserted it explained nothing — which
// was wrong about the code, not a bug in it.
const WELL_OUTSIDE_MS = 2 * 60 * 60_000;

describe("elapsed decisions that take `now` as a parameter", () => {
  // A real epoch, because the fixtures below must stay POSITIVE: `elapsedSince` reports a
  // timestamp of 0 or less as unknowable too, and a `now` of 1,000,000 ms put a two-hour-old
  // send at a negative timestamp — which tested the wrong branch. The step back has to exceed
  // the record's own age, or the record is still in the past and nothing is unknowable.
  const EPOCH = 1_760_000_000_000;
  const STEP_BACK_MS = 3 * 60 * 60_000;

  it("an old send explains nothing, and a clock step is not mistaken for an old send", () => {
    const old = { ts: EPOCH - WELL_OUTSIDE_MS, pending: false, amountFc: 1 } as never;
    // Honest clock: a send from two hours ago explains nothing.
    expect(ownActivityExplainsRise([old], EPOCH)).toBe(false);
    // Clock stepped BACK three hours, past the record's own age, so it is future-dated and no
    // age can be computed. Arrivals is the one module where "unknowable" must NOT read as
    // "ancient": announcing the user's own change note as money received is the failure it
    // ranks highest, so it stays quiet. The silence is self-limiting — these records age out
    // via `localtx`, which uses the other direction deliberately.
    expect(ownActivityExplainsRise([old], EPOCH - STEP_BACK_MS)).toBe(true);
    // But a record with no usable timestamp is not a clock step and silences nothing.
    expect(ownActivityExplainsRise([{ ts: 0, pending: false, amountFc: 1 } as never], EPOCH)).toBe(false);
  });

  it("a clock step holds the notification quiet window rather than going loud", () => {
    const old = { ts: EPOCH - WELL_OUTSIDE_MS, pending: false, amountFc: 1 } as never;
    // Honest clock: nothing is settling, so there is nothing to keep the worker quiet about.
    expect(quietUntil([old], EPOCH)).toBe(0);
    // Clock stepped back: quiet, for the reason above.
    expect(quietUntil([old], EPOCH - STEP_BACK_MS)).toBeGreaterThan(0);
    expect(quietUntil([{ ts: 0, pending: false, amountFc: 1 } as never], EPOCH)).toBe(0);
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
