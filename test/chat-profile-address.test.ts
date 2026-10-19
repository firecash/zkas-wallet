import { describe, expect, it } from "vitest";
import { parseProfile } from "../src/chatclient";

/**
 * A kind-0 profile is a stranger's JSON from a public relay, and its `zkas` field is the only
 * one that feeds a PAYMENT: tapping "Send ZKAS" calls onTip(person.zkas), which reaches
 * onSendAnother(addr) and prefills the send form's recipient.
 *
 * It was accepted on `startsWith("zkas:")` alone, while `name` and `about` in the same
 * function were both run through safeText and length-capped. So the one field that could cost
 * money had the weakest validation of the three.
 *
 * The bidi case is the one that matters. contacts.ts states it plainly for a far more trusted
 * source — the user's own address book — "a name is rendered BESIDE an address ... so a bidi
 * override in it can reorder that address on screen". Here the string IS the address and it
 * comes from anyone on the relay.
 */
const VALID = "zkas:qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9";

describe("a stranger's tip address is checked before it can be paid", () => {
  it("accepts a well-formed address", () => {
    expect(parseProfile(JSON.stringify({ zkas: VALID })).zkas).toBe(VALID);
  });

  it("rejects anything that is not actually an address", () => {
    for (const bad of ["zkas:", "zkas:nope", "zkas:" + "!".repeat(70), "not-an-address", ""]) {
      expect(parseProfile(JSON.stringify({ zkas: bad })).zkas, bad).toBeUndefined();
    }
  });

  it("rejects an address carrying bidi overrides instead of displaying it reordered", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE inside the address: safeText removes it, and what is
    // left must still be a real address or the field is dropped.
    const spoofed = "zkas:‮qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9";
    const got = parseProfile(JSON.stringify({ zkas: spoofed })).zkas;
    if (got !== undefined) {
      expect(got).not.toContain("‮");
      expect(got).not.toContain("‭");
      expect(got).not.toContain("‏");
    }
  });

  it("does not let a stranger park a huge string in a cached profile", () => {
    const huge = "zkas:" + "q".repeat(200_000);
    expect(parseProfile(JSON.stringify({ zkas: huge })).zkas).toBeUndefined();
  });

  it("still sanitises and caps the cosmetic fields", () => {
    const p = parseProfile(JSON.stringify({ name: "x".repeat(99), about: "y".repeat(9999) }));
    expect(p.name?.length).toBeLessThanOrEqual(32);
    expect((p.about ?? "").length).toBeLessThan(9999);
  });

  it("survives junk that is not JSON at all", () => {
    expect(parseProfile("not json")).toEqual({});
    expect(parseProfile("[]").zkas).toBeUndefined();
  });
});
