import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The history poll fires every 2s while `recovering` — exactly when the wallet is scanning and
 * the daemon is slowest to answer — and `/history` allows 30s. With no in-flight guard that is
 * up to fifteen concurrent /history calls from a single client, and the comment directly above
 * the call says what each one costs: "the daemon serialises the whole page under the wallet
 * lock for each of these".
 *
 * The STATUS poll has had `refreshInFlight` since a dead request held the lock and nothing else
 * ran. This poll had no equivalent — the same asymmetry that produced #66 through #69.
 */
const app = readFileSync("src/App.tsx", "utf8");

describe("the history poll sends one request at a time", () => {
  it("guards on a ref, not an object recreated each render", () => {
    // My first attempt put `const pulling = { current: false }` in the component body, where
    // every render replaces it and the guard silently does nothing — the exact shape this
    // audit kept finding elsewhere.
    expect(app).toMatch(/const pulling = useRef\(false\);/);
    expect(app).not.toMatch(/const pulling = \{ current: false \}/);
  });

  it("returns early while a request is outstanding", () => {
    const i = app.indexOf("if (pulling.current) return;");
    expect(i).toBeGreaterThan(0);
    // The flag is taken before the request, not after it resolves.
    const after = app.slice(i, i + 320);
    expect(after).toContain("pulling.current = true;");
    expect(after).toContain("api");
  });

  it("releases the flag on both success and failure", () => {
    // A `.catch` that forgot the flag would wedge the poll permanently after one failure —
    // strictly worse than the overlap it replaced.
    const i = app.indexOf("if (pulling.current) return;");
    const block = app.slice(i, i + 520);
    expect(block).toContain(".finally(");
    expect(block).toContain("pulling.current = false;");
    expect(block).toContain(".catch(");
  });

  it("still polls hard while recovering and idles otherwise", () => {
    // The guard must not change the cadence, only the overlap.
    expect(app).toContain("recovering ? 2_000 : 15_000");
  });
});
