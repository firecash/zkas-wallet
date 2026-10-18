import { describe, expect, it } from "vitest";
import { looksLikeAddress, parsePaymentUri } from "../src/lib/utils";

/**
 * The two functions that decide where money goes, and neither had a direct test.
 *
 * They also existed TWICE — byte-identical copies in src/App.tsx, which never imported
 * these because it defined its own, so the app ran the untested copies. The expectations
 * below were checked against the real signer (firecash_signer wasm) so the UI's guard and
 * the thing that actually decodes an address cannot disagree about what is valid.
 */
describe("looksLikeAddress", () => {
  const REAL = "zkas:pxs3h3gk6ra8nvagka0lup93z6wffa5uhlhm2aj0slln24657z5ml8esvtty2dyfz0254dgxkga67l9";

  it("accepts a real mainnet address", () => {
    expect(looksLikeAddress(REAL)).toBe(true);
  });

  it("accepts the test and dev prefixes, and the legacy firecash one", () => {
    const data = REAL.split(":")[1];
    for (const hrp of ["zkas", "zkastest", "zkassim", "zkasdev", "firecash", "firecashtest"]) {
      expect(looksLikeAddress(`${hrp}:${data}`), hrp).toBe(true);
    }
  });

  it("REFUSES a space inside the address rather than stripping it", () => {
    // The rule this project arrived at the hard way: stripping could turn a mis-scanned
    // address into a different VALID one. The signer agrees — it rejects an interior
    // space with "The address contains an invalid character".
    const broken = REAL.slice(0, 30) + " " + REAL.slice(30);
    expect(looksLikeAddress(broken)).toBe(false);
  });

  it("trims only the ends, which the signer also tolerates", () => {
    expect(looksLikeAddress(`  ${REAL}\n`)).toBe(true);
  });

  it("refuses UPPERCASE, which is what the signer does too", () => {
    // Bech32 QR codes are conventionally uppercase, so this looks like it might be a
    // false refusal — it is not. The signer rejects it ("The address has an invalid
    // prefix ZKAS"), so accepting it here would only move the failure to signing time.
    expect(looksLikeAddress(REAL.toUpperCase())).toBe(false);
    const [hrp, data] = REAL.split(":");
    expect(looksLikeAddress(`${hrp}:${data.toUpperCase()}`)).toBe(false);
  });

  it("refuses the characters bech32 excludes", () => {
    // 1, b, i and o are not in the bech32 alphabet; an older guard accepted them and a
    // typo got a green border, failing only at send time with a raw decode error.
    const data = REAL.split(":")[1];
    for (const ch of ["1", "b", "i", "o"]) {
      expect(looksLikeAddress(`zkas:${ch}${data.slice(1)}`), ch).toBe(false);
    }
  });

  it("refuses wrong lengths, an empty string and a bare prefix", () => {
    const data = REAL.split(":")[1];
    expect(looksLikeAddress(`zkas:${data.slice(0, 40)}`)).toBe(false);
    expect(looksLikeAddress(`zkas:${data}${data}`)).toBe(false);
    expect(looksLikeAddress("")).toBe(false);
    expect(looksLikeAddress("zkas:")).toBe(false);
  });

  it("refuses another chain's address and a bare payload with no prefix", () => {
    expect(looksLikeAddress(`kaspa:${REAL.split(":")[1]}`)).toBe(false);
    expect(looksLikeAddress(REAL.split(":")[1])).toBe(false);
  });
});

describe("parsePaymentUri", () => {
  const REAL = "zkas:pxs3h3gk6ra8nvagka0lup93z6wffa5uhlhm2aj0slln24657z5ml8esvtty2dyfz0254dgxkga67l9";

  it("passes a bare address through", () => {
    expect(parsePaymentUri(REAL)).toEqual({ address: REAL });
  });

  it("splits off an amount, memo and label", () => {
    const r = parsePaymentUri(`${REAL}?amount=1.5&memo=rent&label=Bob`);
    expect(r).toEqual({ address: REAL, amount: "1.5", memo: "rent", label: "Bob" });
  });

  it("drops an amount that is not a plain number rather than prefilling a wrong one", () => {
    // Every one of these would otherwise reach the amount field. Dropping it makes the
    // user type the figure; accepting it could send something they did not choose.
    for (const bad of ["-5", "1,5", "1e3", "0x10", "abc", "1.2.3", "", " ", "Infinity", "NaN"]) {
      expect(parsePaymentUri(`${REAL}?amount=${encodeURIComponent(bad)}`).amount, bad).toBeUndefined();
    }
  });

  it("keeps a legitimate amount in every plain form", () => {
    for (const ok of ["1", "0.5", ".5", "1.00000001", "100000"]) {
      expect(parsePaymentUri(`${REAL}?amount=${ok}`).amount, ok).toBe(ok);
    }
  });

  it("takes the FIRST amount when a URI repeats it", () => {
    // A doubled parameter is how a crafted QR tries to make two parsers disagree. Pinned
    // so the behaviour is a decision rather than an accident.
    expect(parsePaymentUri(`${REAL}?amount=1&amount=1000`).amount).toBe("1");
  });

  it("does not invent an address when the URI is malformed", () => {
    // The address half is handed to looksLikeAddress, which refuses these — what matters
    // is that nothing is silently repaired into something valid.
    expect(looksLikeAddress(parsePaymentUri("?amount=1").address)).toBe(false);
    expect(looksLikeAddress(parsePaymentUri("zkas:?amount=1").address)).toBe(false);
    expect(looksLikeAddress(parsePaymentUri(`${REAL.slice(0, 40)} ${REAL.slice(40)}?amount=1`).address)).toBe(false);
  });
});
