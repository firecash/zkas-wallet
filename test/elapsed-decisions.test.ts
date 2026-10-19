import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { elapsedSince } from "../src/lib/elapsed";

/**
 * `elapsedSince` exists because `Date.now() - stored` inverts when the clock steps backwards —
 * "an NTP correction, a user fixing their timezone the wrong way, a laptop waking with a stale
 * RTC" — and its doc names the three decisions that stuck on the wrong answer: the app lock
 * never auto-locked, the pending-spend subtraction never released, the price never refreshed.
 *
 * Three were converted. Seven more were still doing the raw subtraction, and every one of them
 * failed the same way:
 *
 *   `now - stored < LIMIT`  — negative is less than any limit, so stale reads as FRESH
 *   `now - stored >= LIMIT` — negative is never past a limit, so a timeout NEVER fires
 *
 * The money-path one adopted a prepared payment whose daemon session had expired; two others
 * were waits that would never end.
 */
describe("elapsed-time decisions survive a clock that moves", () => {
  it("reports an unknowable duration as unbounded, so callers land safe", () => {
    const now = 1_000_000;
    expect(elapsedSince(now + 60_000, now)).toBe(Number.POSITIVE_INFINITY); // clock stepped back
    expect(elapsedSince(0, now)).toBe(Number.POSITIVE_INFINITY);            // never stored
    expect(elapsedSince(Number.NaN, now)).toBe(Number.POSITIVE_INFINITY);
    expect(elapsedSince(now - 5_000, now)).toBe(5_000);                     // ordinary
    expect(elapsedSince(now + 200, now)).toBe(0);                           // jitter, not a step
  });

  it("a freshness test refuses stale data under a backward clock", () => {
    const LIMIT = 30_000;
    const now = 1_000_000;
    // Raw: negative < limit === "fresh". Guarded: Infinity < limit === "not fresh".
    expect(now - (now + 60_000) < LIMIT).toBe(true);
    expect(elapsedSince(now + 60_000, now) < LIMIT).toBe(false);
  });

  it("a timeout still fires under a backward clock", () => {
    const LIMIT = 30_000;
    const now = 1_000_000;
    expect(now - (now + 60_000) >= LIMIT).toBe(false);
    expect(elapsedSince(now + 60_000, now) >= LIMIT).toBe(true);
  });

  const DECIDERS: Array<[string, string]> = [
    ["src/noncustodial.ts", "elapsedSince(ahead.finishedAt) < PREPARED_AHEAD_MAX_AGE_MS"],
    ["src/noncustodial.ts", "elapsedSince(movedAt) >= INDEX_STALL_MS"],
    ["src/noncustodial.ts", "const waited = elapsedSince(busySince);"],
    ["src/App.tsx", "elapsedSince(lastHiddenPoll.current) < HIDDEN_POLL_MS"],
    ["src/embedded.ts", "elapsedSince(keptAliveAt) >= KEEPALIVE_REASSERT_MS"],
    ["src/lib/senddraft.ts", "elapsedSince(stored.at) < MAX_AGE_MS"],
    ["src/scanreceipt.ts", "elapsedSince(at) > MAX_STASH_AGE_MS"],
  ];

  for (const [file, snippet] of DECIDERS) {
    it(`${file} decides with the guard: ${snippet.slice(0, 44)}`, () => {
      expect(readFileSync(file, "utf8")).toContain(snippet);
    });
  }

  it("the three original callers still use it", () => {
    for (const f of ["src/applock.ts", "src/price.ts", "src/localtx.ts"]) {
      expect(readFileSync(f, "utf8")).toContain("elapsedSince(");
    }
  });
});
