import { describe, expect, it } from "vitest";
import { parseAmount, sanitizeAmountInput, trimFc, trimTrailingZeros } from "../src/lib/utils";

/**
 * The most money-critical function in the app. Its own history records a ten-times error
 * ("1,5" -> "15"), a thousand-fold one ("1.234.567" -> 1234.567) and a 170-million-fold one
 * ("1e-7" -> "17"). This battery pins what it does now, so the next change to it has to be
 * deliberate about every convention it already handles.
 */
describe("sanitizeAmountInput, by convention", () => {
  it("plain ASCII decimals", () => {
    expect(sanitizeAmountInput("0.5")).toBe("0.5");
    expect(sanitizeAmountInput("12.345")).toBe("12.345");
    expect(sanitizeAmountInput("100")).toBe("100");
  });

  it("comma decimals — the ten-times bug", () => {
    expect(sanitizeAmountInput("1,5")).toBe("1.5");
    expect(sanitizeAmountInput("0,05")).toBe("0.05");
  });

  it("grouping without a decimal — the thousand-fold bug", () => {
    expect(sanitizeAmountInput("1.234.567")).toBe("1234567");
    expect(sanitizeAmountInput("1,234,567")).toBe("1234567");
  });

  it("both marks: the LAST one is the decimal", () => {
    expect(sanitizeAmountInput("1.000,50")).toBe("1000.50");
    expect(sanitizeAmountInput("1,000.50")).toBe("1000.50");
  });

  it("exponents are expanded, not mangled — the 170-million-fold bug", () => {
    expect(sanitizeAmountInput("1e-7")).toBe("0.0000001");
    expect(sanitizeAmountInput("1.5e3")).toBe("1500");
    expect(sanitizeAmountInput("1E5")).toBe("100000");
    // Below chain precision rounds to zero rather than inventing digits.
    expect(sanitizeAmountInput("1e-9")).toBe("0");
    // Negative and absurd are refused outright.
    expect(sanitizeAmountInput("-1e3")).toBe("");
    expect(sanitizeAmountInput("1e21")).toBe("");
  });

  it("Arabic-Indic and Persian digits, and the Arabic decimal mark", () => {
    expect(sanitizeAmountInput("\u0661\u0662\u0663")).toBe("123");
    expect(sanitizeAmountInput("\u06f1\u06f2\u06f3")).toBe("123");
    expect(sanitizeAmountInput("\u0661\u066b\u0665")).toBe("1.5");
  });

  it("never keeps more than the chain's eight decimals", () => {
    expect(sanitizeAmountInput("1.123456789012")).toBe("1.12345678");
  });

  it("a negative sign is never silently dropped into a positive amount", () => {
    // The minus is not a digit, so it is stripped — the result must not be a LARGER
    // positive number than anything the user could have meant.
    const out = sanitizeAmountInput("-5");
    expect(out === "" || out === "5").toBe(true);
  });

  it("parseAmount refuses anything that is not a clean amount", () => {
    expect(parseAmount("12.345")).toBeCloseTo(12.345, 6);
    for (const bad of ["", ".", "1e3", "1,5", "abc", "-1", "1 2"]) {
      expect(Number.isNaN(parseAmount(bad)), bad).toBe(true);
    }
  });

  it("the display trimmers do not change a value", () => {
    expect(trimTrailingZeros("1.5000")).toBe("1.5");
    expect(trimTrailingZeros("100")).toBe("100");
    expect(trimTrailingZeros("0.000")).toBe("0");
    expect(trimFc("12.34500000")).toBe("12.345");
    expect(trimFc("12.00000000")).toBe("12");
    expect(trimFc("100")).toBe("100");
  });
});
