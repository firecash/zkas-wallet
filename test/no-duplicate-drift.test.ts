import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `lib/statushelpers.ts` and `hooks/index.ts` hold copies of 18 functions that App.tsx also
 * defines privately. Neither module is imported by anything — they read as an extraction of
 * App.tsx that was never switched over — so today the copies are inert.
 *
 * Inert is not harmless. Three bugs in this audit came from exactly this shape, where one copy
 * of a function quietly collected a fix the other did not:
 *
 *   · `setDeviceSeed`   — App.tsx had `.catch(fallback)`, lib/deviceseed did not, and the one
 *                         WITHOUT it was the copy `resolveDeviceSeed` called on the
 *                         orphan-recovery path. A rescued seed was persisted nowhere.
 *   · `getDeviceSeed`   — the lib read through the guarded `readSeed`, App.tsx used a bare
 *                         `localStorage.getItem`, and App.tsx's was the one called in render.
 *   · `resealFallbacks` — deleted cleartext before persisting, while `enableLock` beside it
 *                         had the write-first order all along.
 *
 * So rather than delete someone's half-finished extraction, this pins the copies together: if
 * a fix lands in one and not the other, the build says so. The comparison strips comments,
 * because the comments SHOULD differ — each file explains itself.
 */
function body(path: string, name: string): string | null {
  const src = readFileSync(path, "utf8");
  const m = new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, "m").exec(src);
  if (!m) return null;
  let i = src.indexOf("{", m.index + m[0].length);
  let depth = 0;
  let k = i;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) break;
  }
  return src
    .slice(m.index, k + 1)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\bexport\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SHARED: Array<[string, string[]]> = [
  ["src/lib/statushelpers.ts",
   ["sameTxs", "spendableFc", "maturingFc", "reliablePreFc", "pendingInFc", "pendingOutFc",
    "snapshotDirty", "visibleDeviceRows", "isTransientNote"]],
  ["src/lib/utils.ts", ["copyText", "parseAmount", "trimFc"]],
  ["src/hooks/index.ts",
   ["prefersReducedMotion", "useCountUp", "useMinDwell", "useLatch", "useHeldAmount",
    "useScanEta", "useElapsedWhile"]],
];

describe("a function defined twice must not drift", () => {
  for (const [lib, names] of SHARED) {
    for (const name of names) {
      it(`${name} matches between App.tsx and ${lib.split("/").pop()}`, () => {
        const a = body(lib, name);
        const b = body("src/App.tsx", name);
        expect(a, `${name} missing from ${lib}`).not.toBeNull();
        expect(b, `${name} missing from App.tsx`).not.toBeNull();
        expect(b).toBe(a);
      });
    }
  }

  it("deviceSeedKey agrees between App.tsx and lib/deviceseed", () => {
    // The most dangerous duplicate in the tree, and the one I missed when pinning the other
    // 21: this function LOCATES THE SEED. App.tsx's copy is used by `persistDeviceSeed`, the
    // lib's by `setDeviceSeed`/`getDeviceSeed`. If they ever disagree the seed is written
    // under one key and read under another, and securestore describes what the owner then
    // sees: "the app treats what is left as an ordinary wallet with no key — asking for a
    // recovery phrase that never existed for it."
    const a = body("src/lib/deviceseed.ts", "deviceSeedKey");
    const b = body("src/App.tsx", "deviceSeedKey");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b).toBe(a);
    // And it must stay the raw key with the same fallback, not quietly gain a prefix.
    expect(a).toContain("device_seed_");
    expect(a).toContain('readLocal("wallet_token") || "default"');
  });

  it("sameStatus compares the same fields, whatever the order", () => {
    // The one pair that differs textually: the && chain lists `private_sends` in a different
    // place. Logically identical, so the property to pin is the FIELD SET, not the order.
    const fields = (s: string) => [...s.matchAll(/a\.(\w+) === b\.(\w+)/g)].map((m) => m[1]).sort();
    const a = fields(body("src/lib/statushelpers.ts", "sameStatus") ?? "");
    const b = fields(body("src/App.tsx", "sameStatus") ?? "");
    expect(a.length).toBeGreaterThan(5);
    expect(b).toEqual(a);
  });

  /**
   * `src/hooks/index.ts` has NO IMPORTERS AT ALL — verified by grepping for `from "./hooks"`
   * and `from "../hooks"` across src/. App.tsx carries its own copies of `useScanEta` and
   * `useCountUp`, and those are the ones that run.
   *
   * That makes this worse than an ordinary duplicated constant: a module named `hooks/` looks
   * like the canonical shared home, so a fix applied there is inert and a reader can easily
   * believe they are looking at live code. Until one of them is removed — the owner's call,
   * not a bug fix — the two must not be allowed to drift apart silently.
   */
  it("useScanEta has not drifted between its two copies", () => {
    const norm = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
    const live = body("src/App.tsx", "useScanEta") ?? "";
    const shared = body("src/hooks/index.ts", "useScanEta") ?? "";
    expect(live.length).toBeGreaterThan(200);
    expect(shared.length).toBeGreaterThan(200);
    // The guards are the part that matters: a median rate, a positive-rate check and a
    // clamped numerator are what keep the ETA from going infinite or negative.
    for (const guard of ["if (!(rate > 0)) return;", "Math.max(0, total - scanned)", "rates.length < 3"]) {
      expect(norm(live), `App.tsx useScanEta: ${guard}`).toContain(norm(guard));
      expect(norm(shared), `hooks useScanEta: ${guard}`).toContain(norm(guard));
    }
    expect(norm(shared)).toBe(norm(live));
  });

  it("useCountUp has not drifted either", () => {
    const norm = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
    const live = body("src/App.tsx", "useCountUp") ?? "";
    const shared = body("src/hooks/index.ts", "useCountUp") ?? "";
    expect(live.length).toBeGreaterThan(200);
    // Both must animate off performance.now(), not Date.now(): a wall-clock step would
    // otherwise jump or freeze the balance count-up.
    expect(live).toContain("performance.now()");
    expect(shared).toContain("performance.now()");
    expect(norm(shared)).toBe(norm(live));
  });

  it("fmtEta differs only in which translation keys it uses", () => {
    // App.tsx uses `fmtEta.*`, hooks/index.ts uses `hooks.*`. Both sets exist, so neither
    // renders a raw key; the shapes must still agree.
    const strip = (s: string) => s.replace(/i18n\.t\("[^"]+"/g, 'i18n.t("K"');
    expect(strip(body("src/App.tsx", "fmtEta") ?? "")).toBe(strip(body("src/hooks/index.ts", "fmtEta") ?? ""));
  });
});
