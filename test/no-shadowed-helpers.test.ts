import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Catches a hazard this codebase has already been bitten by: the same helper defined in
 * two places, where the copy every screen runs is NOT the one tests or other modules use.
 * The note on resolveDeviceSeed in App.tsx records the instance that cost real behaviour —
 * "the copies then drifted ... which is the version every screen in the app actually ran,
 * since this module shadowed the import."
 *
 * A sweep in October 2026 found 32 duplicated names between App.tsx and src/lib, 7 of them
 * already drifted. `looksLikeAddress` and `parsePaymentUri` — which choose a payment's
 * recipient and amount — were two of the duplicates, and `sameStatus` had drifted in a way
 * that would have dropped a privacy-setting change once store/wallet.ts is wired up.
 *
 * This test does not forbid duplication; it forbids SILENT duplication, by pinning the
 * pairs that are allowed to exist and requiring the risky one to stay in step.
 */
const app = readFileSync("src/App.tsx", "utf8");

function fieldsCompared(src: string, fn: string): string[] {
  const m = new RegExp(`^(?:export\\s+)?function ${fn}\\(`, "m").exec(src);
  if (!m) throw new Error(`${fn} not found`);
  const body = src.slice(m.index, src.indexOf("\n}", m.index));
  return [...body.matchAll(/a\.([a-z_]+)\s*===/g)].map((x) => x[1]).sort();
}

describe("helpers that exist in two places", () => {
  it("sameStatus compares the SAME fields in both copies", () => {
    // The app runs App.tsx's copy; store/wallet.ts uses the one in lib. When the lib copy
    // was missing `private_sends`, a status whose only change was that setting counted as
    // unchanged, so the store would have kept the old one and the Settings row would read
    // the privacy state backwards — the failure App.tsx's own comment describes.
    const lib = readFileSync("src/lib/statushelpers.ts", "utf8");
    expect(fieldsCompared(lib, "sameStatus")).toEqual(fieldsCompared(app, "sameStatus"));
  });

  it("App.tsx does not re-declare the helpers that decide where money goes", () => {
    // These were byte-identical copies, and because App.tsx declared them locally it
    // never imported the originals: every screen ran the copies and no test touched them.
    for (const fn of ["looksLikeAddress", "parsePaymentUri"]) {
      expect(new RegExp(`^function ${fn}\\(`, "m").test(app), `${fn} re-declared in App.tsx`).toBe(false);
    }
  });
});
