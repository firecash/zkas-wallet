import { describe, expect, it } from "vitest";
import { selfPaymentTxids, isOwnAddress } from "../src/history";

const OWN = "zkas:pown0000000000000000000000000000000000000000000000000000000000000000000";
const OTHER = "zkas:pother0000000000000000000000000000000000000000000000000000000000000000";

describe("consolidation (self-payment) detection", () => {
  it("flags a sent row whose recipient is the wallet's own address", () => {
    const s = selfPaymentTxids([{ txid: "a", kind: "sent", recipient: OWN }], OWN);
    expect(s.has("a")).toBe(true);
  });
  it("does NOT flag a normal send to someone else", () => {
    const s = selfPaymentTxids([{ txid: "a", kind: "sent", recipient: OTHER }], OWN);
    expect(s.has("a")).toBe(false);
  });
  it("flags a txid that is BOTH sent and received (even without a matching recipient string)", () => {
    const s = selfPaymentTxids(
      [{ txid: "b", kind: "sent", recipient: null }, { txid: "b", kind: "received" }],
      OWN,
    );
    expect(s.has("b")).toBe(true);
  });
  it("does not flag receives that don't pair with a self-send", () => {
    const s = selfPaymentTxids([{ txid: "c", kind: "received" }], OWN);
    expect(s.has("c")).toBe(false);
  });
  it("isOwnAddress guards null/own-address", () => {
    expect(isOwnAddress(OWN, OWN)).toBe(true);
    expect(isOwnAddress(OTHER, OWN)).toBe(false);
    expect(isOwnAddress(null, OWN)).toBe(false);
    expect(isOwnAddress(OWN, undefined)).toBe(false);
  });
});
