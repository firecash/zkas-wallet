import { describe, expect, it } from "vitest";
import { isSecretShaped } from "../src/lib/deviceseed";

// `isSecretShaped` gates wallet recovery: anything it rejects can never be tried
// as a wallet secret. It must accept BOTH the legacy 64-hex seed and the 12-word
// recovery phrase — rejecting either would strand real funds.
describe("wallet secret shapes", () => {
  it("accepts a legacy 64-hex seed", () => {
    expect(isSecretShaped("07".repeat(32))).toBe(true);
    expect(isSecretShaped("DEADBEEF".repeat(8))).toBe(true);
    expect(isSecretShaped("  " + "a3".repeat(32) + "\n")).toBe(true);
  });

  it("accepts a 12-word recovery phrase, however it was pasted", () => {
    const phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    expect(isSecretShaped(phrase)).toBe(true);
    expect(isSecretShaped(phrase.toUpperCase())).toBe(true);
    expect(isSecretShaped(phrase.split(" ").join("\n"))).toBe(true);
  });

  it("rejects what is neither", () => {
    expect(isSecretShaped("")).toBe(false);
    expect(isSecretShaped("hello world")).toBe(false); // too few words
    expect(isSecretShaped("zz".repeat(32))).toBe(false); // not hex
    expect(isSecretShaped("07".repeat(20))).toBe(false); // wrong length
  });
});
