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
    expect(api).toMatch(/history:\s*\(limit\?: number, timeoutMs = 30_000, offset\?: number\)/);
    // The caller's timeout must still reach req(), not be dropped on the way.
    const i = api.indexOf("/api/wallet/history");
    expect(i).toBeGreaterThan(0);
    expect(api.slice(i, i + 320)).toContain("timeoutMs");
  });

  it("the user-initiated fetch waits long enough for a checkpoint read", () => {
    // The property, not the literal: this call carries the long bound. (It also now asks
    // for HISTORY_MAX rather than omitting the limit — see the show-all tests.)
    const i = app.indexOf("setChain(await api.history(");
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i, i + 140)).toContain("180_000");
  });

  it("but the 2s poll keeps a short timeout so requests cannot pile up", () => {
    // The polling call site passes no timeout, so it takes the 30s default.
    // Format-independent: the poll's call must not carry the long bound. Anchored on the
    // in-flight guard that precedes it, since the call itself is now split across lines.
    const poll = app.indexOf("if (pulling.current) return;");
    expect(poll).toBeGreaterThan(0);
    expect(app.slice(poll, poll + 420)).not.toContain("180_000");
  });

  it("matches the bound watch already uses for the same work", () => {
    // If one is ever retuned the other should be reconsidered; they wait on the same thing.
    expect(api).toContain("timeoutMs = 180_000");
  });
});

describe("every wallet-touching call survives a cold load, and only those", () => {
  const api = readFileSync("src/api.ts", "utf8");

  it("states the measurement it is derived from", () => {
    // The number must not become folklore: it came from 40,380 checkpoint loads.
    expect(api).toMatch(/40,380 checkpoint loads/);
    expect(api).toMatch(/const COLD_WALLET_MS = 180_000/);
  });

  it("covers the user-initiated wallet calls that had short bounds", () => {
    // /api/wallet/settings was 15s (36.9% of loads exceed it) and
    // /api/wallet/proof was 30s (17.9%).
    for (const path of ["/api/wallet/settings", "/api/wallet/proof"]) {
      // The request itself (browser mode's router mentions the path first).
      const i = api.indexOf(`"POST", "${path}"`) > 0 ? api.indexOf(`"POST", "${path}"`) : api.indexOf(path);
      expect(i, path).toBeGreaterThan(0);
      expect(api.slice(i, i + 220), path).toContain("COLD_WALLET_MS");
    }
  });

  it("leaves the poll, the fire-and-forget call and the wallet-free one short", () => {
    // Lengthening these would be the opposite mistake: a poll queues behind the wallet
    // lock, warm's failure is swallowed, and /api/verify needs no wallet at all.
    const verify = api.indexOf('"/api/verify"');
    expect(verify).toBeGreaterThan(0);
    expect(api.slice(verify, verify + 120)).toContain("15_000");

    const warm = api.indexOf('"/api/wallet/warm"');
    expect(api.slice(warm, warm + 160)).toContain("15_000");

    expect(api).toMatch(/\/api\/status", undefined, localEngine\(\) \? 4_000/);
  });
});

describe("show all asks for everything the daemon will give, and admits what it cannot", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  /**
   * `/api/wallet/history` reads `query.limit.unwrap_or(500).clamp(1, 5_000)`, so omitting the
   * limit did NOT mean "all" — it meant 500, a tenth of what the daemon would serve. A wallet
   * with more rows showed 500 of them, the button then vanished because `showAll` was set, and
   * nothing on screen said the rest existed.
   */
  it("requests the daemon's own ceiling instead of omitting the limit", () => {
    expect(app).toMatch(/const HISTORY_MAX = 5_000/);
    expect(app).not.toContain("api.history(showAll ? undefined");
    // Count the ARGUMENT, not the call's formatting: the poll's call is split across lines.
    const calls = app.match(/showAll \? HISTORY_MAX : HISTORY_PAGE/g) ?? [];
    expect(calls.length, "both the poll and the user-initiated call").toBe(2);
  });

  it("says so when even that is truncated", () => {
    // The daemon reports the true `total`, so silence here would be a choice to hide it.
    const i = app.indexOf('t("history.truncated"');
    expect(i).toBeGreaterThan(0);
    const around = app.slice(i - 260, i + 160);
    expect(around).toContain("showAll");
    expect(around).toContain("chain?.total");
  });
});

describe("history can reach past the first page", () => {
  const api = readFileSync("src/api.ts", "utf8");
  const app = readFileSync("src/App.tsx", "utf8");

  /**
   * The daemon pages: it takes `offset` and returns `total`/`offset`/`limit`. Without using
   * it the newest `limit` rows were the only history this client could ever reach, so a
   * wallet past that ceiling had older transactions it simply could not show.
   */
  it("sends the daemon's offset parameter", () => {
    expect(api).toMatch(/offset\?: number/);
    expect(api).toContain("offset=${offset}");
    // And only when it is meaningful, so the common call keeps its clean URL.
    expect(api).toMatch(/offset && offset > 0/);
  });

  it("accumulates older pages instead of letting the poll discard them", () => {
    // The 2s poll replaces `chain`; appended pages have to live outside it.
    expect(app).toMatch(/const \[older, setOlder\] = useState<ChainHistoryRow\[\]>\(\[\]\)/);
    const i = app.indexOf("const allRows = useMemo(");
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i, i + 220)).toContain("...older");
  });

  it("asks from where the loaded rows end", () => {
    const i = app.indexOf("api\n                .history(");
    const call = i > 0 ? app.slice(i, i + 160) : app.slice(app.indexOf(".history(HISTORY_MAX, 180_000, allRows.length)"), app.indexOf(".history(HISTORY_MAX, 180_000, allRows.length)") + 80);
    expect(call).toContain("allRows.length");
  });
});
