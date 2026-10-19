import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateDuration, recordDuration } from "../src/timing";

/**
 * The ETA is measured, never invented — this file's own rule: "A guess dressed as a countdown
 * is worse than no countdown — it teaches people the number is fiction, and then they ignore
 * the honest ones too."
 *
 * A wall clock breaks that. `clock-skew.test` records three live bugs from the same class —
 * "an NTP correction, a timezone fixed the wrong way, a laptop waking with a stale RTC" — and
 * the send path measured its duration as `Date.now() - startedAt`. A jump BACKWARD was already
 * rejected by the floor; a jump FORWARD recorded an inflated sample with no ceiling, which then
 * set the countdown for the next eight sends.
 *
 * Two defences: the callers measure with `performance.now()`, which no correction moves, and
 * the store refuses a clock-shaped sample whoever writes it.
 */
const TOKEN = "ab".repeat(16);

// A test should leave storage as it found it, not merely start clean: these write keys
// (device_mnemonic, lock records, profiles, timing samples) that another file could read.
afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* a blocked store has nothing to clear */
  }
});

describe("a clock jump cannot poison the countdown", () => {
  beforeEach(() => localStorage.clear());

  it("learns from a slow but real run", () => {
    // 425.5s for 38 notes cold is a figure this file records as measured.
    recordDuration("prepare", TOKEN, 38, 425_500, false);
    expect(estimateDuration("prepare", TOKEN, 38, false)).toBeGreaterThan(0);
  });

  it("refuses a sample that is a clock, not a proof", () => {
    recordDuration("prepare", TOKEN, 1, 6 * 60 * 60_000, true);   // six hours
    expect(estimateDuration("prepare", TOKEN, 1, true)).toBeNull();
  });

  it("still refuses a backwards clock and sub-threshold jitter", () => {
    recordDuration("prepare", TOKEN, 1, -5_000, true);
    recordDuration("prepare", TOKEN, 1, 10, true);
    expect(estimateDuration("prepare", TOKEN, 1, true)).toBeNull();
  });

  it("drops an absurd sample already in storage, not just on write", () => {
    // A store written by an older build must not keep steering the estimate.
    localStorage.setItem(
      `timing_prepare_${TOKEN}`,
      JSON.stringify([{ notes: 1, ms: 6 * 60 * 60_000, warm: true, at: Date.now() }]),
    );
    expect(estimateDuration("prepare", TOKEN, 1, true)).toBeNull();
  });

  it("measures with a monotonic clock at the call sites", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain("const sendStartedAt = performance.now();");
    expect(app).toContain("const runStartedAt = performance.now();");
    expect(app).toContain("performance.now() - sendStartedAt");
    expect(app).not.toContain("Date.now() - sendStartedAt");
    expect(app).not.toContain("Date.now() - runStartedAt");
  });
});
