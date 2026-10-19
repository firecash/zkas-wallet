import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { looksLikeAddress } from "../src/lib/utils";

/**
 * A batch send takes addresses PASTED IN BULK — the one place where a one-character
 * transcription error is not hypothetical. It validated each line with a local regex,
 * `/^(zkas|firecash):[a-z0-9]{50,100}$/i`, which accepts `b`, `i`, `o` and `1`: the four
 * characters bech32 leaves out precisely because humans confuse them.
 *
 * The chain's own encoder is explicit — crypto/addresses/src/bech32.rs has
 * `const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l"`.
 *
 * Mining carried the same regex under a comment claiming "the app already owns the real test
 * and uses it in WalletTools and Explorer". Neither did — both held their own weak copy.
 */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GOOD = `zkas:${CHARSET.repeat(3).slice(0, 70)}`;

describe("the batch send rejects an address bech32 would not produce", () => {
  it("accepts a well-formed one", () => {
    expect(looksLikeAddress(GOOD)).toBe(true);
  });

  it("rejects the confusable characters the old regex allowed", () => {
    for (const c of ["b", "i", "o", "1"]) {
      const bad = `zkas:${c}${GOOD.slice(6)}`;
      expect(looksLikeAddress(bad), c).toBe(false);
    }
  });

  it("no longer holds a local regex of its own", () => {
    const tools = readFileSync("src/pages/WalletTools.tsx", "utf8");
    expect(tools).toContain("looksLikeAddress(row.to)");
    // The regex being USED, not merely quoted: the comment above the fix cites the old
    // pattern on purpose, and an assertion that cannot tell those apart fails on its own
    // explanation. (Third time I have made that mistake today.)
    expect(tools).not.toMatch(/\[a-z0-9\]\{50,100\}\$\/i\.test\(/);
  });

  it("and neither does the explorer's address view", () => {
    const exp = readFileSync("src/pages/Explorer.tsx", "utf8");
    expect(exp).toContain("looksLikeAddress(id)");
    expect(exp).not.toMatch(/\[a-z0-9\]\{50,100\}\$\/i\.test\(/);
  });

  it("leaves the amount parser alone — it was already right", () => {
    const tools = readFileSync("src/pages/WalletTools.tsx", "utf8");
    expect(tools).toContain("100_000_000n");
    expect(tools).toMatch(/result > 0n \? result : null/);
  });
});
