import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Explore dashboard has two layers of tolerance for an endpoint that fails:
 * `settled()` turns a rejection into null, and `keep()` falls back to the previous or cached
 * value. Neither notices a 200 whose body is the wrong SHAPE.
 *
 * So a response like `{"error": …}` from /blocks/recent reached the view as `data.blocks`,
 * survived `?? []` because an object is truthy, and threw on `.slice(0, 12)` — the page went
 * blank. This API has produced that class of answer in production: a boot race once had it
 * serving "0.00s block time / 0 shielded notes / empty" while still starting.
 *
 * The asymmetry was backwards: `cachedDashboard()` validates the LOCAL cache with
 * `Array.isArray` before trusting it, while the REMOTE response was cast and believed.
 */
describe("a list endpoint that answers with a non-list is a failure, not data", () => {
  const api = readFileSync("src/api/explorer.ts", "utf8");

  it("validates the shape rather than casting", () => {
    expect(api).toMatch(/function asList<T>/);
    expect(api).toMatch(/if \(!Array\.isArray\(value\)\) throw/);
  });

  it("applies it to /blocks/recent, which the dashboard maps over", () => {
    const i = api.indexOf('"/blocks/recent"');
    expect(i).toBeGreaterThan(0);
    expect(api.slice(i - 120, i + 160)).toContain("asList");
    // The old bare cast must be gone, or the guard is decoration.
    expect(api).not.toContain('explorerGet<BlockSummary[]>("/blocks/recent")');
  });

  it("throws instead of substituting an empty list", () => {
    // An empty list would render as "the chain has no recent blocks" — a confident lie.
    // Throwing routes it into settled()/keep(), which already handle an absent answer.
    const i = api.indexOf("function asList<T>");
    const body = api.slice(i, i + 220);
    expect(body).toContain("throw");
    expect(body).not.toMatch(/return \[\]/);
  });

  it("still trusts nothing more than the cache does", () => {
    // cachedDashboard() was already strict; this brings the live path up to it rather than
    // relaxing the cache down.
    const page = readFileSync("src/pages/Explorer.tsx", "utf8");
    expect(page).toContain("Array.isArray(value.blocks)");
  });
});
