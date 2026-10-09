import { describe, it, expect } from "vitest";
import { sanitizeAmountInput } from "../src/lib/utils";

// Which mark is the decimal separator is the whole ballgame: get it wrong and
// the amount is out by a factor of ten, a hundred, or a thousand.
describe("amount separators", () => {
  const cases: [string, string][] = [
    ["1,5", "1.5"],                 // comma decimal: most of Europe and Latin America
    ["1.5", "1.5"],
    ["1.000,50", "1000.50"],        // both marks: the LAST one is the decimal
    ["1,000.50", "1000.50"],
    ["1.234.567", "1234567"],       // one mark repeated: grouping, no decimal
    ["1,234,567", "1234567"],
    ["1 234,56", "1234.56"],        // space grouping
    ["0.123456789", "0.12345678"],  // clamped to a sompi
    ["12", "12"],
    ["1.", "1."],                   // mid-typing must survive
    ["١٢٫٥", "12.5"], // Arabic-Indic digits and decimal mark
  ];
  for (const [input, want] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => {
      expect(sanitizeAmountInput(input)).toBe(want);
    });
  }
});
