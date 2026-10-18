import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { birthdayAheadOfTip } from "../src/lib/birthday";
import en from "../src/i18n/en/app-wallet.json";

/**
 * A wallet's birthday is the height its scan starts from. The restore dialog's DATE path was
 * bounded at both ends — floored at 0, and a future date falls through to 0 — while the typed
 * EXACT HEIGHT had no bound on either side, walletd included.
 *
 * A height past the tip starts the scan after every block that could hold this wallet's notes,
 * so it finds nothing and the restored wallet reports an empty balance: the worst reading this
 * app can give, one mistyped digit away.
 */
const TIP = 6_983_500;

describe("a typed birthday cannot start the scan after the chain ends", () => {
  it("reports the tip when the typed height is past it", () => {
    expect(birthdayAheadOfTip("9999999", TIP)).toBe(TIP);
    expect(birthdayAheadOfTip(String(TIP + 1), TIP)).toBe(TIP);
    // The shape of a real typo: an extra digit.
    expect(birthdayAheadOfTip("69835000", TIP)).toBe(TIP);
  });

  it("accepts everything at or below the tip", () => {
    expect(birthdayAheadOfTip(String(TIP), TIP)).toBeNull();
    expect(birthdayAheadOfTip("1", TIP)).toBeNull();
    expect(birthdayAheadOfTip("0", TIP)).toBeNull();
    expect(birthdayAheadOfTip("6983499", TIP)).toBeNull();
  });

  it("says nothing when there is no height typed", () => {
    // The date path handles its own bounds; this predicate is only about the typed field.
    expect(birthdayAheadOfTip("", TIP)).toBeNull();
    expect(birthdayAheadOfTip("   ", TIP)).toBeNull();
  });

  it("cannot check without a tip, and does not pretend to", () => {
    // A restore can run before any status has arrived. "Cannot check" must not become
    // "refuse", or the dialog would block exactly when the user is offline and restoring.
    expect(birthdayAheadOfTip("9999999", null)).toBeNull();
    expect(birthdayAheadOfTip("9999999", 0)).toBeNull();
  });

  it("is not confused by a value that is not a number", () => {
    expect(birthdayAheadOfTip("abc", TIP)).toBeNull();
    expect(birthdayAheadOfTip("Infinity", TIP)).toBeNull();
  });
});

describe("the restore dialog uses it and explains itself", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("refuses the import instead of scanning nothing", () => {
    const i = app.indexOf("const ahead = birthdayAhead();");
    expect(i).toBeGreaterThan(0);
    const after = app.slice(i, i + 260);
    expect(after).toContain("onboard.birthdayAhead");
    expect(after).toContain("return;");
  });

  it("names the tip, so the user can correct the digit", () => {
    expect(en.onboard.birthdayAhead).toContain("{{tip}}");
    expect(en.onboard.birthdayAhead).toMatch(/empty balance|scan nothing/i);
  });
});
