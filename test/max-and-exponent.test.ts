import { describe, expect, it } from "vitest";
import { sanitizeAmountInput, trimTrailingZeros } from "../src/lib/utils";

/**
 * `String(Number(x))` switches to exponential notation below 1e-6, and the Max button used
 * it. So on a wallet holding barely more than the fee, "Send max" wrote "1e-7" into the
 * amount field — and the field's own sanitiser, which strips everything that is not a digit
 * or a separator, turned that into "17": the digits concatenated, the exponent discarded.
 *
 * That is a value 170 million times larger than what the button meant, and it is the same
 * mistake the sanitiser was written to prevent — its own comment is about "1,5" becoming
 * "15", a ten-times overpayment.
 *
 * The overspend guard did stop the send (17 is never affordable on a wallet whose whole
 * balance is dust), so no funds could move. What the user got instead was a field showing
 * "1e-7", a button that produced it, and no way to send the dust Max exists for.
 */
describe("Max never produces exponential notation", () => {
  const setMax = (spendable: number, feeReserve: number) => {
    const max = Math.max(0, spendable - feeReserve);
    return max > 0 ? trimTrailingZeros(max.toFixed(8)) : "0";
  };

  it("writes a plain decimal even for the smallest sendable amount", () => {
    for (const [s, fee] of [[0.00002, 0.0000199], [0.0001, 0.0000999], [0.001, 0.0009999], [0.00001, 0.000001]]) {
      const out = setMax(s, fee);
      expect(out, `${s} - ${fee}`).not.toMatch(/e/i);
      // And it still means what it should.
      expect(Number(out)).toBeCloseTo(s - fee, 8);
    }
  });

  it("is stable through the field's own sanitiser", () => {
    // The real failure: Max's output went back through sanitizeAmountInput on the next
    // keystroke. Whatever Max writes has to survive that unchanged.
    for (const [s, fee] of [[0.00002, 0.0000199], [1.5, 0.00001], [12345.678, 0.0001], [0.001, 0.0009999]]) {
      const out = setMax(s, fee);
      expect(sanitizeAmountInput(out), `${out} changed when re-read`).toBe(out);
    }
  });

  it("keeps whole amounts whole and strips only padding", () => {
    expect(trimTrailingZeros("1.50000000")).toBe("1.5");
    expect(trimTrailingZeros("2.00000000")).toBe("2");
    expect(trimTrailingZeros("10.00000000")).toBe("10");   // not "1"
    expect(trimTrailingZeros("100.00000000")).toBe("100");
    expect(trimTrailingZeros("0.00000010")).toBe("0.0000001");
    expect(trimTrailingZeros("0.10000000")).toBe("0.1");
  });
});

describe("an exponent in the amount field is expanded, never concatenated", () => {
  it("no longer fabricates a vastly larger number", () => {
    expect(sanitizeAmountInput("1e-7")).toBe("0.0000001");   // was "17"
    expect(sanitizeAmountInput("1e-8")).toBe("0.00000001");  // was "18"
    expect(sanitizeAmountInput("2.5e-3")).toBe("0.0025");
    expect(sanitizeAmountInput("1E-7")).toBe("0.0000001");
  });

  it("expands upward too", () => {
    expect(sanitizeAmountInput("1e3")).toBe("1000");
    expect(sanitizeAmountInput("1.5e2")).toBe("150");
  });

  it("drops what is below the chain's smallest unit rather than inventing digits", () => {
    expect(sanitizeAmountInput("1e-20")).toBe("0");
  });

  it("refuses what cannot be written as a plain decimal", () => {
    // toFixed itself returns exponential notation at 1e21 and above, and no balance
    // reaches it, so there is nothing to be gained by guessing.
    expect(sanitizeAmountInput("1e21")).toBe("");
    expect(sanitizeAmountInput("1e400")).toBe("");
    expect(sanitizeAmountInput("-1e-7")).toBe("");
  });

  it("leaves ordinary typing exactly as it was", () => {
    // Including the separator handling this function already got right — an exponent check
    // placed before it must not shadow any of that.
    expect(sanitizeAmountInput("1,5")).toBe("1.5");
    expect(sanitizeAmountInput("1.000,50")).toBe("1000.50");
    expect(sanitizeAmountInput("1.234.567")).toBe("1234567");
    expect(sanitizeAmountInput("0.123456789")).toBe("0.12345678");
    expect(sanitizeAmountInput("١٢٣")).toBe("123");
    expect(sanitizeAmountInput("e")).toBe("");
    expect(sanitizeAmountInput("1e")).toBe("1");
  });
});
