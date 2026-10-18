import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { skipPollWhileFailing } from "../src/lib/pollbackoff";

/**
 * walletd's supervisor backs off when a restart fails immediately — "one that dies instantly
 * is a bad binary or bad flags, and hammering it helps nobody". The client had no such rule:
 * the status poll runs at 1 Hz and kept doing so however long the service had been down.
 *
 * The in-flight guard throttles a SLOW daemon, because the next poll cannot start until the
 * current one returns. It does nothing for a FAST failure — nginx answering 502 while walletd
 * restarts — so every open client sent a request per second at the moment the service could
 * least afford it.
 */
const T = 1_000_000;

describe("the poll stops hammering a service that keeps failing", () => {
  it("does not interfere while the app is still deciding", () => {
    // `flipAt` is 5, 12, 60 or 120 consecutive failures, and those are SECONDS only because
    // the poll is 1 Hz. Slowing it any earlier would stretch "tell the user after 5 seconds"
    // into minutes, so every one of those thresholds must be reached at full rate.
    for (const fails of [0, 1, 4, 5, 12, 60, 119]) {
      expect(skipPollWhileFailing(fails, T, T), `at ${fails} failures`).toBe(false);
    }
  });

  it("backs off once the app has already given up", () => {
    // By 120 failures the "can't reach the wallet service" screen is showing on every path.
    expect(skipPollWhileFailing(120, T, T + 1)).toBe(true);
    expect(skipPollWhileFailing(500, T, T + 14_999)).toBe(true);
  });

  it("still retries, just not every second", () => {
    expect(skipPollWhileFailing(120, T, T + 15_000)).toBe(false);
    expect(skipPollWhileFailing(120, T, T + 60_000)).toBe(false);
  });

  it("is harmless on a first run with no recorded attempt", () => {
    expect(skipPollWhileFailing(0, 0, T)).toBe(false);
    expect(skipPollWhileFailing(120, 0, T)).toBe(false);
  });
});

describe("recovery is still immediate where it matters", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("rides on failedPolls, which success and the resume handler both clear", () => {
    // Nothing extra needs resetting: returning to a backgrounded app polls at once because
    // the resume handler zeroes the counter this backoff reads.
    const i = app.indexOf("skipPollWhileFailing(failedPolls.current");
    expect(i).toBeGreaterThan(0);
    expect(app).toMatch(/failedPolls\.current = 0;/);
  });

  it("sits before the in-flight flag is taken, so a skipped tick leaves no lock behind", () => {
    const skip = app.indexOf("if (skipPollWhileFailing(");
    const flag = app.indexOf("refreshInFlight.current = true;");
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(flag);
  });
});
