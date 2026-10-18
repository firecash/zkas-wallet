import { describe, expect, it } from "vitest";
import { parsePaymentUri, sanitizeAmountInput } from "../src/lib/utils";

/**
 * A payment REQUEST is built by one wallet and read by another: Receive puts the amount
 * through `sanitizeAmountInput` and into `zkas:addr?amount=…`, and the payer's Send screen
 * reads it back with `parsePaymentUri`, which DROPS an amount that is not a plain number.
 *
 * So the two have to agree on the form, or a request for 1,5 ZKAS arrives as a blank
 * field — the payer sees an address and no figure, with nothing saying one was asked for.
 * Nothing tested the pair together, and they are written in different files with different
 * rules: one accepts European separators and Arabic-Indic digits, the other accepts
 * /^\d*\.?\d+$/ and nothing else.
 */
const ADDR = "zkas:pxs3h3gk6ra8nvagka0lup93z6wffa5uhlhm2aj0slln24657z5ml8esvtty2dyfz0254dgxkga67l9";

/** Exactly what RequestAmount builds. */
function buildRequest(typed: string, memo = ""): string {
  const amount = sanitizeAmountInput(typed);
  const p = new URLSearchParams();
  if (amount.trim()) p.set("amount", amount.trim());
  if (memo.trim()) p.set("memo", memo.trim());
  const qs = p.toString();
  return qs ? `${ADDR}?${qs}` : ADDR;
}

describe("a requested amount survives the trip to the payer", () => {
  // Written the way people in the 24 shipped languages actually type.
  const typed: [string, string][] = [
    ["1.5", "1.5"],
    ["1,5", "1.5"],            // comma decimal: most of Europe and Latin America
    ["0,5", "0.5"],
    ["1.000,50", "1000.50"],   // dot grouping, comma decimal
    ["1,000.50", "1000.50"],   // comma grouping, dot decimal
    ["1.234.567", "1234567"],  // grouping only — no decimal at all
    ["10", "10"],
    ["0.00000001", "0.00000001"],
    ["١٢٣", "123"],            // Arabic-Indic digits
    ["۱٫۵", "1.5"],            // Persian digits with the Arabic decimal mark
  ];

  for (const [input, expected] of typed) {
    it(`"${input}" reaches the payer as ${expected}`, () => {
      expect(sanitizeAmountInput(input)).toBe(expected);
      const parsed = parsePaymentUri(buildRequest(input));
      expect(parsed.address).toBe(ADDR);
      // The figure must ARRIVE. Undefined here is the silent failure: the payer gets an
      // address and an empty amount field.
      expect(parsed.amount, `amount dropped for "${input}"`).toBe(expected);
    });
  }

  it("carries a memo through unchanged, including spaces and punctuation", () => {
    const parsed = parsePaymentUri(buildRequest("1", "Rent, April — flat 3"));
    expect(parsed.memo).toBe("Rent, April — flat 3");
  });

  it("builds a bare address when no amount was typed", () => {
    expect(buildRequest("")).toBe(ADDR);
    expect(parsePaymentUri(buildRequest("")).amount).toBeUndefined();
  });

  it("never emits a grouping separator, which the parser would refuse", () => {
    // The invariant that keeps the two files in step: whatever a person types, what goes
    // into the URI is ASCII digits with at most one dot.
    for (const [input] of typed) {
      expect(sanitizeAmountInput(input)).toMatch(/^\d*\.?\d*$/);
    }
  });
});
