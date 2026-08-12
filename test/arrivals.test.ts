import { describe, expect, it } from "vitest";
import { arrivalAmount, ownActivityExplainsRise, quietUntil, SETTLING_WINDOW_MS } from "../src/arrivals";

const now = 1_700_000_000_000;

describe("not calling your own change an incoming payment", () => {
  // The live report: "+100 ZKAS arriving — confirmed, settling into your wallet", ~10
  // minutes after the user's own send. That was the change note returning.
  it("stays silent while a send of ours is still settling", () => {
    const sends = [{ ts: now - 10 * 60_000, pending: false }];
    expect(arrivalAmount(50, 150, true, sends, now)).toBeNull();
  });

  it("stays silent while a send is still pending, however old", () => {
    const sends = [{ ts: now - 5 * 60 * 60_000, pending: true }];
    expect(arrivalAmount(50, 150, true, sends, now)).toBeNull();
  });

  // The window has to close, or a wallet that ever sent would never announce again.
  it("announces again once nothing of ours is settling", () => {
    const sends = [{ ts: now - (SETTLING_WINDOW_MS + 60_000), pending: false }];
    expect(arrivalAmount(50, 150, true, sends, now)).toBe(100);
  });

  it("announces a genuine arrival when this device has sent nothing", () => {
    expect(arrivalAmount(50, 61, true, [], now)).toBe(11);
  });
});

describe("the rules that were already right", () => {
  it("treats the first fully-synced reading as a baseline, not a windfall", () => {
    expect(arrivalAmount(null, 250, true, [], now)).toBeNull();
  });

  it("ignores a reading that is not final", () => {
    expect(arrivalAmount(10, 900, false, [], now)).toBeNull();
  });

  it("ignores a fall, and ignores float noise", () => {
    expect(arrivalAmount(100, 90, true, [], now)).toBeNull();
    expect(arrivalAmount(100, 100 + 1e-12, true, [], now)).toBeNull();
  });
});

describe("telling the native worker when to stay quiet", () => {
  it("is zero when nothing is settling, which clears any hold", () => {
    expect(quietUntil([], now)).toBe(0);
    expect(quietUntil([{ ts: now - (SETTLING_WINDOW_MS + 1), pending: false }], now)).toBe(0);
  });

  it("holds until the window past a recent send", () => {
    expect(quietUntil([{ ts: now - 60_000, pending: false }], now)).toBe(now - 60_000 + SETTLING_WINDOW_MS);
  });

  it("keeps extending while a send is still pending", () => {
    expect(quietUntil([{ ts: now - 60_000, pending: true }], now)).toBe(now + SETTLING_WINDOW_MS);
  });

  it("takes the furthest deadline when several are settling", () => {
    const sends = [{ ts: now - 10 * 60_000, pending: false }, { ts: now - 60_000, pending: false }];
    expect(quietUntil(sends, now)).toBe(now - 60_000 + SETTLING_WINDOW_MS);
  });
});

describe("the predicate itself", () => {
  it("is false for an empty history", () => {
    expect(ownActivityExplainsRise([], now)).toBe(false);
  });
});
