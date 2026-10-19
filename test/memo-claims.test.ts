import { describe, expect, it } from "vitest";
import en from "../src/i18n/en/app-send.json";

/**
 * On a wallet whose purpose is privacy, a claim about who can read your message has to be
 * exact. Both memo strings said "only the recipient can read it", and the code says otherwise
 * in so many words (api.ts): "`memo` rides inside the recipient's encrypted note — readable by
 * them, and by this wallet through its OVK-recovered history."
 *
 * So there are two readers, not one, and the second matters: a wallet's history is disclosed by
 * its viewing key — `watch_fvk_` is described as "the wallet's entire financial history in one
 * string" — and a payment proof can include the memo deliberately. Someone who wrote a memo
 * believing only the payee could ever read it was misinformed by the field's own hint.
 *
 * "Never appears on-chain" was loose in the same direction: the memo IS on-chain, inside the
 * encrypted note. What is true is that it is never READABLE there.
 */
describe("the memo hint describes who can actually read a memo", () => {
  it("no longer claims only the recipient can", () => {
    for (const s of [en.send.memoHint, en.send.memoSealed]) {
      expect(s).not.toMatch(/only the recipient/i);
    }
  });

  it("names both readers", () => {
    for (const s of [en.send.memoHint, en.send.memoSealed]) {
      expect(s).toMatch(/recipient/i);
      expect(s).toMatch(/your own history/i);
    }
  });

  it("keeps the on-chain claim, corrected to readability", () => {
    // The memo is on-chain inside the encrypted note; what holds is that it is not readable.
    expect(en.send.memoHint).toMatch(/never readable on-chain/i);
    expect(en.send.memoHint).not.toMatch(/never appears on-chain/i);
  });

  it("still tells the user the memo is encrypted", () => {
    // The correction must not read as "your memo is public".
    for (const s of [en.send.memoHint, en.send.memoSealed]) {
      expect(s).toMatch(/encrypted/i);
    }
  });
});
