import { beforeEach, describe, expect, it } from "vitest";
import { internalRouteFromLink, queuePaymentLink, takePaymentLink } from "../src/paymentlinks";

/**
 * `?payment=` is read straight out of location.search by main.tsx and handed to
 * queuePaymentLink BEFORE the app mounts. `decodeURIComponent` throws a URIError on a
 * malformed escape, so a link containing "web+zkas:%" took the whole startup down — and since
 * the query stays in the URL, a reload hit the same link again.
 *
 * Anyone who can get a link opened could stop the wallet from starting.
 */
describe("a malformed payment link cannot stop the app starting", () => {
  beforeEach(() => localStorage.clear());

  it("does not throw on a broken percent-escape", () => {
    for (const bad of ["web+zkas:%", "web+zkas:%zz", "web+zkas:%E0%A4%A", "web+zkas:100%"]) {
      expect(() => queuePaymentLink(bad), bad).not.toThrow();
      expect(queuePaymentLink(bad), bad).toBe(false);
    }
  });

  it("does not throw when reading one back either", () => {
    // A hand-edited or half-written storage value takes the same path on the read side,
    // which App.tsx runs from inside the wallet screen.
    localStorage.setItem("zkas_pending_payment_v1", "web+zkas:%");
    expect(() => takePaymentLink()).not.toThrow();
    expect(takePaymentLink()).toBeNull();
  });

  it("still accepts a genuine web+zkas link", () => {
    const addr = "zkas:qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9";
    expect(queuePaymentLink(`web+zkas:${encodeURIComponent(addr)}`)).toBe(true);
    expect(takePaymentLink()).toContain("zkas:");
  });

  it("still rejects a link that is not an address at all", () => {
    expect(queuePaymentLink("web+zkas:not-an-address")).toBe(false);
    expect(queuePaymentLink("https://evil.example/")).toBe(false);
  });

  it("the internal route parser is already guarded, and stays that way", () => {
    expect(internalRouteFromLink("zkas-wallet://receive")).toBe("/?tab=receive");
    expect(() => internalRouteFromLink("::::")).not.toThrow();
    expect(internalRouteFromLink("::::")).toBeNull();
    // Only the three known hosts, and only this scheme.
    expect(internalRouteFromLink("zkas-wallet://anything-else")).toBeNull();
    expect(internalRouteFromLink("https://receive")).toBeNull();
  });
});
