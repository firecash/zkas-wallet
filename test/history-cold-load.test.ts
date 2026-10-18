import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Opening History can land on an EVICTED wallet, and the daemon reads its checkpoint before
 * answering ("checkpoint on disk; it reloads on its next request"). Measured from the hosted
 * daemon's own log, 40,380 checkpoint loads: p50 9.8s, p90 44.1s, p99 167.8s.
 *
 * The one timeout served both callers at 30s, which 17.9% of those loads exceed — so about
 * one in six cold opens showed the user an error while the daemon was working correctly.
 * `watch` already uses 180s for exactly this cold-load work and covers 99.1%.
 *
 * The two callers want opposite things, which is why this is a per-caller value and not a
 * bigger default: the History tab POLLS every 2s while recovering and swallows failures, so
 * a long timeout there would queue requests behind the wallet lock.
 */
describe("history tolerates a cold wallet load where it matters", () => {
  const api = readFileSync("src/api.ts", "utf8");
  const app = readFileSync("src/App.tsx", "utf8");

  it("lets the caller choose the timeout, defaulting to the short one", () => {
    expect(api).toMatch(/history:\s*\(limit\?: number, timeoutMs = 30_000\)/);
    // The default must still be passed through, not ignored.
    expect(api).toMatch(/\/api\/wallet\/history[^\n]*undefined,\s*timeoutMs\)/);
  });

  it("the user-initiated fetch waits long enough for a checkpoint read", () => {
    expect(app).toContain("api.history(showAll ? undefined : HISTORY_PAGE, 180_000)");
  });

  it("but the 2s poll keeps a short timeout so requests cannot pile up", () => {
    // The polling call site passes no timeout, so it takes the 30s default.
    const poll = app.indexOf("void api.history(");
    expect(poll).toBeGreaterThan(0);
    const line = app.slice(poll, app.indexOf("\n", poll));
    expect(line).not.toContain("180_000");
  });

  it("matches the bound watch already uses for the same work", () => {
    // If one is ever retuned the other should be reconsidered; they wait on the same thing.
    expect(api).toContain("timeoutMs = 180_000");
  });
});
