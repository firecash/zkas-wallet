import { beforeEach, describe, expect, it } from "vitest";
import { forgetReceipts, loadBaseline, loadReceipts, recordArrival, saveBaseline } from "../src/receipts";
import { arrivalAmount } from "../src/arrivals";

describe("noticing money that arrived while the app was closed", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "wallet-a");
  });

  // The bug this exists for: the baseline lived in a ref, so it was null on every
  // start, and `arrivalAmount` treats a null baseline as "first reading, no gain".
  // The Android worker would notify "+11 ZKAS arrived" from its own balance delta,
  // and the app — opened seconds later — had no idea.
  it("survives a restart, so an arrival between launches is still found", () => {
    saveBaseline(100);
    // A fresh launch reads this instead of starting from null.
    expect(loadBaseline()).toBe(100);
    expect(arrivalAmount(loadBaseline(), 111, true)).toBeCloseTo(11);
  });

  // Still true on the very first run of a wallet: with nothing stored, the first
  // reading is a baseline, or opening the app would announce the whole balance as
  // if it had just landed.
  it("treats the first reading of a new wallet as a baseline, not a windfall", () => {
    expect(loadBaseline()).toBeNull();
    expect(arrivalAmount(loadBaseline(), 250, true)).toBeNull();
  });

  it("records arrivals newest first, and says which were found on opening", () => {
    recordArrival(11, true, 1_000);
    recordArrival(2.5, false, 2_000);
    const rows = loadReceipts();
    expect(rows.map((r) => r.amountFc)).toEqual([2.5, 11]);
    expect(rows[1].whileAway).toBe(true);
    expect(rows[0].whileAway).toBe(false);
  });

  it("ignores a non-positive delta", () => {
    recordArrival(0, false);
    recordArrival(-5, false);
    expect(loadReceipts()).toHaveLength(0);
  });

  // Records are per wallet: switching wallets must not show one wallet's income
  // under another's history.
  it("keeps wallets separate", () => {
    recordArrival(7, false);
    localStorage.setItem("wallet_token", "wallet-b");
    expect(loadReceipts()).toHaveLength(0);
    expect(loadBaseline()).toBeNull();
  });

  it("forgets everything when a wallet is removed", () => {
    recordArrival(7, false);
    saveBaseline(42);
    forgetReceipts("wallet-a");
    expect(loadReceipts()).toHaveLength(0);
    expect(loadBaseline()).toBeNull();
  });
});
