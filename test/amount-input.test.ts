import { describe, it, expect } from "vitest";
import { sanitizeAmountInput, parseAmount } from "../src/lib/utils";

// `1,5` used to become `15`. The field stripped every character that was not a
// digit or a dot, so a comma — the decimal separator for most of Europe and Latin
// America, and for the majority of the 24 languages this wallet ships in — simply
// vanished and glued the digits together. Nothing on screen ever said 1.5, and on
// a wallet with the balance for it the send went through at ten times the amount.
describe("amount input cannot silently change the number", () => {
  it("reads a comma as a decimal separator, not as nothing", () => {
    expect(sanitizeAmountInput("1,5")).toBe("1.5");
    expect(parseAmount(sanitizeAmountInput("1,5"))).toBe(1.5);
    expect(sanitizeAmountInput("0,05")).toBe("0.05");
  });

  it("treats the LAST separator as the decimal point, so grouping is not value", () => {
    expect(parseAmount(sanitizeAmountInput("1.000,50"))).toBe(1000.5);
    expect(parseAmount(sanitizeAmountInput("1,000.50"))).toBe(1000.5);
    expect(parseAmount(sanitizeAmountInput("1 000,50"))).toBe(1000.5);
  });

  it("accepts Arabic-Indic and Persian digits instead of emptying the field", () => {
    expect(sanitizeAmountInput("١٢٫٥")).toBe("12.5");
    expect(sanitizeAmountInput("۱۲۳")).toBe("123");
  });

  it("still clamps to 8 decimals and still refuses junk", () => {
    expect(sanitizeAmountInput("1.123456789012")).toBe("1.12345678");
    expect(sanitizeAmountInput("abc")).toBe("");
  });

  it("never turns a negative or an exponent into a larger positive number", () => {
    // "-5" previously became "5" with the Review button ENABLED, and "1e9" became "19".
    expect(parseAmount(sanitizeAmountInput("-5"))).not.toBe(15);
    expect(sanitizeAmountInput("-5")).toBe("5");

    // This line used to read `toBe("19")`, with the comment "documented: still
    // digit-joining" — recording the digit-joining as accepted rather than fixing it. It
    // contradicted this test's own title: joining the digits of "1e-7" gives "17", which is
    // 170 million times LARGER, and the Max button fed exactly that shape in on a wallet
    // holding barely more than the fee. An exponent is now expanded, so the stronger
    // property holds — the field means what was written.
    expect(sanitizeAmountInput("1e9")).toBe("1000000000");
    expect(sanitizeAmountInput("1e-7")).toBe("0.0000001");
  });
});
