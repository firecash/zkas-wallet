import { readFileSync, readdirSync} from "node:fs";
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

describe("storage rules that must not be tidied away", () => {
  const deviceseed = readFileSync("src/lib/deviceseed.ts", "utf8");

  it("seed keys are NOT read through safestore", () => {
    // safestore's reader falls back to a session map holding what a blocked store refused.
    // A spending key must never live there: it would vanish on reload while the owner
    // believed the wallet had saved it — the key-loss shape setDeviceSeed warns about after
    // a real user lost funds to the earlier version. `readSeed` catches the throw and
    // nothing more. If someone "unifies" these onto readLocal, this fails.
    // Precisely: the SEED keys go through readSeed. `wallet_token` in the same function
    // legitimately uses safestore — losing a token is not losing a key — so the rule is
    // about which KEY, not which function.
    expect(deviceseed).toContain("readSeed(deviceSeedKey())");
    expect(deviceseed).not.toContain("readLocal(deviceSeedKey())");
    expect(deviceseed).toContain("readSeed(`seed_unsealed_${token}`)");
    expect(deviceseed).not.toContain("readLocal(`seed_unsealed_${token}`)");
  });

  it("seed WRITES stay loud, wherever the writer lives", () => {
    // The opposite half of the same rule: a seed that could not be stored has to fail where
    // somebody sees it, so these must not be routed through writeLocal, which swallows.
    //
    // Found by file originally, which broke the moment the writer moved — and the move was
    // itself a fix, because there were TWO copies of it and the one `resolveDeviceSeed`
    // called on the orphan-recovery path lacked the `.catch(fallback)`. So this now locates
    // the definition instead of assuming a file, and pins that there is exactly one.
    const files = ["src/App.tsx", "src/lib/deviceseed.ts"];
    const defining = files.filter((f) => readFileSync(f, "utf8").includes("export function setDeviceSeed"));
    expect(defining, "exactly one module may define setDeviceSeed").toHaveLength(1);
    const src = readFileSync(defining[0], "utf8");
    const set = src.slice(src.indexOf("export function setDeviceSeed"));
    const body = set.slice(0, set.indexOf("\n}") + 2);
    expect(body).toContain("localStorage.setItem");
    expect(body).not.toContain("writeLocal(");
    // And the rejection path that cost a user their coins stays covered.
    expect(body).toContain(".catch(fallback)");
  });

  it("storage enumerations are guarded, since .length throws too", () => {
    // `localStorage.length` and `.key(i)` throw on a blocked store exactly as getItem does,
    // so guarding the read inside a loop protects nothing. This is what kept the app from
    // STARTING: isLockEnabled -> legacyRecords -> an unguarded length, read during render.
    for (const f of ["src/applock.ts", "src/walletstate.ts", "src/lib/deviceseed.ts", "src/main.tsx"]) {
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/localStorage\.(length|key\()/.test(line)) return;
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        // Some enclosing try must exist above it inside the same function.
        const before = lines.slice(Math.max(0, i - 40), i).join("\n");
        expect(before, `${f}:${i + 1} enumerates storage with no enclosing try`).toMatch(/\btry\s*\{/);
      });
    }
  });
});

describe("how much of an address a person gets to check", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("does not re-declare shortAddr", () => {
    // It was declared here too, byte-identical, so every screen ran the copy rather than
    // the one in lib/utils — the third helper to do that after looksLikeAddress and
    // parsePaymentUri. This one decides how much of an address a user can verify.
    expect(/^function shortAddr\(/m.test(app)).toBe(false);
  });

  it("shows the FULL recipient in the transaction detail row", () => {
    // Address poisoning is grinding a vanity address that matches both ends of a target,
    // so a truncation cannot answer "did I pay the right person?" — and that row is the
    // surface somebody opens to ask exactly that. The compact list rows stay truncated on
    // purpose: they are for recognising a payment, not verifying one.
    const i = app.indexOf('className="v mono addr-full"');
    expect(i, "the detail row should render the full address").toBeGreaterThan(0);
    const row = app.slice(i, i + 200);
    expect(row).toContain("row.recipient");
    expect(row).not.toContain("shortAddr(row.recipient)");
  });

  /**
   * The superseded flat fee constants must stay unimported.
   *
   * `lib/constants.ts` exports FEE_FC (0.03) and FEE_MAX_FC (0.045) — a flat fee for one or
   * two notes, and for six. `fees.ts` computes the real thing from the node's constants:
   * 0.0185 ZKAS for 2 spends, 0.2458 for 38. So the flat figure understates the fee by more
   * than five times at the top of the range, and a fee below the node's bytes x 200 minimum is
   * rejected by relay outright, which has happened on this project before.
   *
   * App.tsx already moved everything user-facing to fees.ts. These two survive in a shared
   * constants file where the next person to need a fee will reasonably look first.
   */
  it("nothing imports the superseded flat fee constants", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(full, "utf8");
          // An IMPORT of the name, not a local declaration of it (App.tsx has its own).
          for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*constants"/g)) {
            if (/\bFEE_(MAX_)?FC\b/.test(m[1])) offenders.push(full);
          }
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});
