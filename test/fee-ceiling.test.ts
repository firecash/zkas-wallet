import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en/app-send.json";

/**
 * The custom fee had a floor and no ceiling.
 *
 * The floor is handled meticulously: a custom fee below the node's minimum is displayed as a
 * RANGE, because the node charges its own minimum regardless of what the caller asks, and
 * showing it as exact "understated the cost by up to 0.2448 ZKAS on a 38-note wallet".
 *
 * Nothing guarded the other end — not here and not in walletd, which has no fee ceiling
 * either. So a fee typed as `10` instead of `0.001` is simply paid. `overspend` only
 * intervenes when amount plus fee exceeds the balance, which on a funded wallet it does not.
 */
describe("a custom fee bigger than the payment is surfaced before confirming", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("derives the condition from the custom fee and the amount", () => {
    expect(app).toMatch(/const feeExceedsAmount = feeCustomSet && amtValid && feeCustom > amt;/);
  });

  it("shows it on the confirm screen, beside the fee", () => {
    const i = app.indexOf("feeExceedsAmount && (");
    expect(i).toBeGreaterThan(0);
    // Immediately before the total row, so it is read with the numbers it is about.
    expect(app.slice(i, i + 420)).toContain("send.feeExceedsAmount");
    expect(app.slice(i, i + 520)).toContain('confirm-row total');
  });

  it("states both numbers, so the typo is visible rather than implied", () => {
    const m = en.send.feeExceedsAmount;
    expect(m).toContain("{{fee}}");
    expect(m).toContain("{{amount}}");
  });

  it("warns rather than blocks", () => {
    // A high fee can be deliberate when someone wants priority. The app says so and lets
    // them proceed; it does not disable the button, and canProceed must not mention it.
    const i = app.indexOf("const canProceed =");
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i, i + 300)).not.toContain("feeExceedsAmount");
  });

  it("only fires for a fee the user set, not the wallet's own estimate", () => {
    // feeReserve rises with note count on its own; warning about the wallet's own figure
    // would be noise on every large-wallet send.
    expect(app).toMatch(/feeExceedsAmount = feeCustomSet &&/);
  });
});
