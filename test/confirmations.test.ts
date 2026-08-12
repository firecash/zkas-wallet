import { describe, expect, it } from "vitest";
import { confirmationLabel, tickedConfirmations } from "../src/confirmations";

// Reported: confirmations "didn't appear for a few seconds then appeared at once, 4,
// then 12". The count changes continuously (~1 block/s) but was only ever updated when
// a poll answered, so it moved in leaps.
describe("confirmations that accrue instead of leaping", () => {
  const at = 1_000_000;

  it("advances between server answers", () => {
    const one = tickedConfirmations({ serverConfs: 4, serverAt: at, now: at + 1_200 });
    const five = tickedConfirmations({ serverConfs: 4, serverAt: at, now: at + 6_000 });
    expect(one).toBe(5);
    expect(five).toBeGreaterThan(one!);
  });

  it("runs slightly slow, so the truth corrects it upward rather than down", () => {
    expect(tickedConfirmations({ serverConfs: 10, serverAt: at, now: at + 10_000 })!).toBeLessThanOrEqual(20);
  });

  it("never goes backwards when a server answer lags what is shown", () => {
    expect(tickedConfirmations({ serverConfs: 6, serverAt: at, lastShown: 11, now: at })).toBe(11);
  });

  it("does not invent confirmations for an unmined payment", () => {
    expect(tickedConfirmations({ serverConfs: 0, serverAt: at, now: at + 30_000 })).toBe(0);
  });

  it("holds the display when the server has not answered yet", () => {
    expect(tickedConfirmations({ serverConfs: null, serverAt: at, lastShown: 7, now: at + 5_000 })).toBe(7);
    expect(tickedConfirmations({ serverConfs: null, serverAt: at, now: at })).toBeNull();
  });

  it("stops inventing once the poll has clearly failed", () => {
    expect(tickedConfirmations({ serverConfs: 3, serverAt: at, now: at + 10 * 60_000 })!).toBeLessThanOrEqual(3 + 45);
  });
});

describe("how a confirmation count reads", () => {
  it("settles to a word once the number stops being interesting", () => {
    expect(confirmationLabel(2_600_000, 40 * 60_000)).toBe("confirmed");
  });
  it("counts while it still matters", () => {
    expect(confirmationLabel(1, 5_000)).toBe("1 conf");
    expect(confirmationLabel(4, 5_000)).toBe("4 confs");
  });
  it("says nothing for an unmined payment", () => {
    expect(confirmationLabel(0, 5_000)).toBeNull();
  });
});
