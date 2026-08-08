import { beforeEach, describe, expect, it, vi } from "vitest";
import { internalRouteFromLink, queuePaymentLink, takePaymentLink } from "../src/paymentlinks";

const ADDRESS = `zkas:${"q".repeat(64)}`;

describe("payment links", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a valid request on-device until the wallet consumes it", () => {
    const listener = vi.fn();
    window.addEventListener("zkas-payment-link", listener);
    expect(queuePaymentLink(`${ADDRESS}?amount=1.25&memo=coffee`)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(takePaymentLink()).toBe(`${ADDRESS}?amount=1.25&memo=coffee`);
    expect(takePaymentLink()).toBeNull();
    window.removeEventListener("zkas-payment-link", listener);
  });

  it("accepts encoded browser handlers and trimmed Android share text", () => {
    const request = `${ADDRESS}?amount=2.5&memo=mobile`;
    expect(queuePaymentLink(`  ${request}  `)).toBe(true);
    expect(takePaymentLink()).toBe(request);
    expect(queuePaymentLink(`web+zkas:${encodeURIComponent(request)}`)).toBe(true);
    expect(takePaymentLink()).toBe(request);
  });

  it("rejects arbitrary and oversized protocol input", () => {
    expect(queuePaymentLink("https://example.com/steal")) .toBe(false);
    expect(queuePaymentLink(`zkas:${"q".repeat(2_000)}`)).toBe(false);
  });

  it("maps only the app's explicit quick-action routes", () => {
    expect(internalRouteFromLink("zkas-wallet://receive")).toBe("/tools?tab=request");
    expect(internalRouteFromLink("zkas-wallet://mine")).toBe("/mine");
    expect(internalRouteFromLink("zkas-wallet://unknown")).toBeNull();
  });
});
