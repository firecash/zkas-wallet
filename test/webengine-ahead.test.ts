import { describe, it, expect } from "vitest";
import { AHEAD_TTL_MS, aheadKey, aheadUsable } from "../src/webengine/ahead";

// A payment proven while the user reviewed it is submitted only if it is exactly the payment
// confirmed, fresh, and its coins are still unspent; otherwise the send proves again.
describe("prove-ahead reuse", () => {
  const key = aheadKey("zkas:abc", "100000000", "hi");
  const a = { key, at: 1_000, positions: [4, 9] };
  const all = () => true;

  it("reuses the same payment, fresh, with its coins unspent", () => {
    expect(aheadUsable(a, key, 1_000 + 8_000, all)).toBe(true);
  });
  it("never for a different recipient, amount or memo", () => {
    expect(aheadUsable(a, aheadKey("zkas:abd", "100000000", "hi"), 2_000, all)).toBe(false);
    expect(aheadUsable(a, aheadKey("zkas:abc", "100000001", "hi"), 2_000, all)).toBe(false);
    expect(aheadUsable(a, aheadKey("zkas:abc", "100000000", ""), 2_000, all)).toBe(false);
  });
  it("never once a coin it spends has been spent or parked", () => {
    expect(aheadUsable(a, key, 2_000, (ps) => !ps.includes(9))).toBe(false);
  });
  it("never past its TTL, nor from a clock that went backwards", () => {
    expect(aheadUsable(a, key, 1_000 + AHEAD_TTL_MS, all)).toBe(false);
    expect(aheadUsable(a, key, 500, all)).toBe(false);
  });
  it("never without one", () => {
    expect(aheadUsable(null, key, 2_000, all)).toBe(false);
  });
});

describe("proving ahead from the send form (browser mode)", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const app = fs.readFileSync("src/App.tsx", "utf8");
  const worker = fs.readFileSync("src/webengine/worker.ts", "utf8");

  it("starts once the form is valid and unchanged, re-armed only by edits", () => {
    const i = app.indexOf("EARLY_PROVE_PAUSE_MS);");
    expect(i).toBeGreaterThan(0);
    const block = app.slice(app.lastIndexOf("useEffect(", i), app.indexOf("]);", i) + 3);
    expect(block).toContain("browserModeChosen()");
    expect(block).toContain("!canProceed");
    expect(block).toContain("clearTimeout(timer)");
    // Status polls (every second) must not restart the pause, or it would never fire.
    expect(block).toMatch(/\[to, amt, memo, canProceed, confirming, busy, fragmented\]/);
  });

  it("the worker does not prove a payment it already holds", () => {
    const i = worker.indexOf("function prepareAhead(");
    expect(worker.slice(i, i + 500)).toMatch(/aheadUsable\(ahead, keyOf\(msg\)[\s\S]*\)\) return;\s*const p = prove\(msg\)/);
  });
});
