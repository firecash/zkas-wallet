import { describe, expect, it } from "vitest";
import { sanitizeAmountInput } from "../src/lib/utils";

// Every money field goes through sanitizeAmountInput. The custom fee field and Wallet tools had
// their own strip of non-[0-9.] characters, so a comma-decimal "0,03" fee became "003": 3 ZKAS.
describe("money fields read decimal commas", () => {
  it("keeps a comma decimal a decimal", () => {
    expect(sanitizeAmountInput("0,03")).toBe("0.03");
    expect(sanitizeAmountInput("1,5")).toBe("1.5");
    expect(sanitizeAmountInput("1.000,50")).toBe("1000.50");
  });
  it("no input field strips characters on its own any more", async () => {
    const fs = await import("node:fs");
    for (const f of ["src/App.tsx", "src/pages/WalletTools.tsx"]) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/replace\(\/\[\^0-9\.\]\/g/);
    }
  });
});
