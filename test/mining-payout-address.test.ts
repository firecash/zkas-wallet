import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { looksLikeAddress, looksLikeKaspaAddress } from "../src/lib/utils";

/**
 * Mining to a payout address that is wrong by one character sends the rewards somewhere
 * unrecoverable. This project has already paid for the lesson: a withdrawal "sat for 10 hours
 * because only the prefix was checked" when the address carried a SPACE.
 *
 * The comment above the mining readiness gate says exactly that, and says "the app already
 * owns the real test". The ZKAS field was then checked with a LOCAL regex,
 * `/^(zkas|firecash):[a-z0-9]{50,100}$/i`, which accepts `b`, `i`, `o` and `1` — the four
 * characters bech32 leaves out because humans confuse them — and the Kaspa field, on the line
 * directly below the warning, was still `startsWith("kaspa:")`.
 */
/// Built from the chain's OWN charset rather than typed by hand: the node's address encoder
/// has `const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l"` (crypto/addresses/src/
/// bech32.rs), which is the bech32 set. My first attempt at a sample by hand contained a `b`
/// and so was not a valid address at all — worth saying, because a validator tested against
/// an invalid sample proves nothing.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const KAS = `kaspa:${CHARSET.repeat(2).slice(0, 61)}`;

describe("a Kaspa payout address is checked, not just prefixed", () => {
  it("accepts a well-formed address", () => {
    expect(looksLikeKaspaAddress(KAS)).toBe(true);
    expect(looksLikeKaspaAddress(`  ${KAS}  `)).toBe(true); // a paste carries whitespace at the ends
  });

  it("rejects the failure that actually happened: a space inside", () => {
    const i = Math.floor(KAS.length / 2);
    expect(looksLikeKaspaAddress(`${KAS.slice(0, i)} ${KAS.slice(i)}`)).toBe(false);
  });

  it("rejects the characters bech32 deliberately omits", () => {
    for (const c of ["b", "i", "o", "1"]) {
      expect(looksLikeKaspaAddress(`kaspa:${c.repeat(60)}`), c).toBe(false);
    }
  });

  it("rejects a bare prefix and a truncated body", () => {
    expect(looksLikeKaspaAddress("kaspa:")).toBe(false);
    expect(looksLikeKaspaAddress("kaspa:qyp7bqd0")).toBe(false);
    expect(looksLikeKaspaAddress("kaspa:" + "q".repeat(200))).toBe(false);
  });

  it("does not accept a ZKAS address as a Kaspa payout, or the reverse", () => {
    const zkas = "zkas:" + "q".repeat(70);
    expect(looksLikeKaspaAddress(zkas)).toBe(false);
    expect(looksLikeAddress(KAS)).toBe(false);
  });
});

describe("the mining page uses the shared tests", () => {
  const mining = readFileSync("src/pages/Mining.tsx", "utf8");

  it("has no local address regex of its own", () => {
    // Only the DECLARATION and USE, not the comment that explains why it is gone — the
    // comment quotes the old pattern on purpose.
    expect(mining).not.toMatch(/const ADDRESS_RE\s*=/);
    expect(mining).not.toMatch(/ADDRESS_RE\.test\(/);
  });

  it("gates both payout fields on the real tests", () => {
    expect(mining).toContain("looksLikeAddress(walletAddress)");
    expect(mining).toContain("looksLikeKaspaAddress(kaspaAddress)");
    expect(mining).not.toContain('startsWith("kaspa:")');
  });
});
