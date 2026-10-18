import { beforeEach, describe, expect, it, vi } from "vitest";
import { queuePaymentLink, takePaymentLink } from "../src/paymentlinks";

/**
 * Links arriving from OUTSIDE the app: a `zkas:` deep link, or `?payment=` on the URL.
 * main.tsx handles both during startup, so anything that throws here fails the boot.
 */
const ADDR = "zkas:pxs3h3gk6ra8nvagka0lup93z6wffa5uhlhm2aj0slln24657z5ml8esvtty2dyfz0254dgxkga67l9";

describe("payment links", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("accepts a well-formed link and hands it back once", () => {
    expect(queuePaymentLink(`${ADDR}?amount=1.5`)).toBe(true);
    expect(takePaymentLink()).toBe(`${ADDR}?amount=1.5`);
    // Single-use: a link must not be re-applied on the next open.
    expect(takePaymentLink()).toBeNull();
  });

  it("unwraps the web+zkas: form", () => {
    expect(queuePaymentLink(`web+zkas:${encodeURIComponent(`${ADDR}?amount=2`)}`)).toBe(true);
    expect(takePaymentLink()).toBe(`${ADDR}?amount=2`);
  });

  it("refuses anything whose address is not an address", () => {
    for (const bad of [
      "",
      "zkas:",
      "kaspa:" + ADDR.split(":")[1],
      ADDR.toUpperCase(),                                  // the signer refuses this too
      `${ADDR.slice(0, 30)} ${ADDR.slice(30)}?amount=1`,   // space INSIDE, never stripped
      `zkas:${"1".repeat(70)}`,                            // bech32 excludes "1"
      "javascript:alert(1)",
      `${ADDR}?amount=1`.padEnd(1100, "x"),                // over the 1 KiB cap
    ]) {
      expect(queuePaymentLink(bad), JSON.stringify(bad.slice(0, 40))).toBe(false);
    }
  });

  it("still delivers the link when storage refuses the write", () => {
    // The boot path calls this. An unguarded write threw on a full or unavailable
    // localStorage — ordinary on iOS, and Safari private mode can throw outright — and
    // that exception escaped into startup where nothing catches it.
    //
    // This asserted `false` when the write was merely swallowed. safestore now holds a
    // refused value for the session, so the stronger property holds: the link is not just
    // survivable, it WORKS — the payment the user tapped actually opens. Within a session
    // is the honest limit; a reload cannot bring back what storage would not keep.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => queuePaymentLink(`${ADDR}?amount=1`)).not.toThrow();
    expect(queuePaymentLink(`${ADDR}?amount=1`)).toBe(true);
    expect(takePaymentLink()).toBe(`${ADDR}?amount=1`);
  });

  it("survives a storage that refuses READS too", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    expect(() => takePaymentLink()).not.toThrow();
  });
});
