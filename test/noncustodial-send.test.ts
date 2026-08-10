import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepare, submit, fvkHex, verifyAndSignPayment } = vi.hoisted(() => ({
  prepare: vi.fn(),
  submit: vi.fn(),
  fvkHex: vi.fn(async () => "00".repeat(96)),
  verifyAndSignPayment: vi.fn(async () => [{ index: 0, sig: "sig" }]),
}));

vi.mock("../src/api", () => ({ api: { prepare, submit } }));
vi.mock("../src/signer", () => ({ fvkHex, verifyAndSignPayment }));

import { consolidateNonCustodial, FragmentedWalletError, sendNonCustodial } from "../src/noncustodial";

/** A consolidation round walletd would answer with. `remaining` is what it could
 * not fit, which is what drives the next round. */
function round(session: string, amount: string, remaining: string, notes = 38) {
  return {
    session, bundle_hex: "aa", disclosure: {},
    spend_auth: Array.from({ length: notes }, (_, index) => ({ index })),
    amount_sompi_exact: amount, fee_sompi_exact: "3000000", remaining_sompi_exact: remaining,
  };
}

describe("noncustodial payment atomicity", () => {
  beforeEach(() => {
    prepare.mockReset();
    submit.mockReset();
    verifyAndSignPayment.mockClear();
  });

  it("does not opt a normal payment into partial broadcasts", async () => {
    prepare.mockRejectedValue(new Error("amount needs more than 38 input notes (standard tx size cap): send in smaller chunks"));
    await expect(
      sendNonCustodial("ab".repeat(32), "mainnet", "zkas:test", 10),
    ).rejects.toBeInstanceOf(FragmentedWalletError);
    expect(prepare).toHaveBeenCalledWith(expect.any(String), "zkas:test", 1_000_000_000n, undefined, undefined, false);
    expect(verifyAndSignPayment).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a partial prepare response before signing even if walletd misbehaves", async () => {
    prepare.mockResolvedValue({
      session: "bad", bundle_hex: "aa", disclosure: {}, spend_auth: [],
      amount_sompi_exact: "600000000", fee_sompi_exact: "3000000", remaining_sompi_exact: "400000000",
    });
    await expect(
      sendNonCustodial("ab".repeat(32), "mainnet", "zkas:test", 10),
    ).rejects.toBeInstanceOf(FragmentedWalletError);
    expect(verifyAndSignPayment).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("uses partial mode only after the user explicitly chooses split delivery", async () => {
    prepare
      .mockResolvedValueOnce({
        session: "one", bundle_hex: "aa", disclosure: {}, spend_auth: [],
        amount_sompi_exact: "600000000", fee_sompi_exact: "3000000", remaining_sompi_exact: "400000000",
      })
      .mockResolvedValueOnce({
        session: "two", bundle_hex: "bb", disclosure: {}, spend_auth: [],
        amount_sompi_exact: "400000000", fee_sompi_exact: "3000000", remaining_sompi_exact: "0",
      });
    submit
      .mockResolvedValueOnce({ txid: "a".repeat(64), amount_sompi: 600_000_000, fee_sompi: 3_000_000 })
      .mockResolvedValueOnce({ txid: "b".repeat(64), amount_sompi: 400_000_000, fee_sompi: 3_000_000 });
    const result = await sendNonCustodial(
      "ab".repeat(32), "mainnet", "zkas:test", 10, undefined, undefined, undefined, true,
    );
    expect(result.parts).toHaveLength(2);
    expect(prepare).toHaveBeenNthCalledWith(1, expect.any(String), "zkas:test", 1_000_000_000n, undefined, undefined, true);
    expect(prepare).toHaveBeenNthCalledWith(2, expect.any(String), "zkas:test", 400_000_000n, undefined, undefined, true);
  });
});

// A single consolidation round merges at most one transaction's worth of notes,
// so on the wallet that actually needs consolidating — hundreds of tiny mining
// notes — one round changes nothing the user can perceive. Rounds must therefore
// run back to back: a submitted note leaves walletd's spendable set immediately,
// so the next round selects different notes and cannot double-spend the last.
describe("noncustodial consolidation", () => {
  beforeEach(() => {
    prepare.mockReset();
    submit.mockReset();
    verifyAndSignPayment.mockClear();
  });

  it("keeps merging until nothing is left to merge", async () => {
    prepare
      .mockResolvedValueOnce(round("one", "600000000", "400000000"))
      .mockResolvedValueOnce(round("two", "390000000", "0"));
    submit
      .mockResolvedValueOnce({ txid: "a".repeat(64), amount_sompi: 600_000_000, fee_sompi: 3_000_000 })
      .mockResolvedValueOnce({ txid: "b".repeat(64), amount_sompi: 390_000_000, fee_sompi: 3_000_000 });

    const result = await consolidateNonCustodial("ab".repeat(32), "mainnet", "zkas:self", 1_010_000_000n);

    expect(result.rounds).toBe(2);
    expect(result.inputs).toBe(76);
    expect(result.txids).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(result.fee_sompi).toBe(6_000_000);
    expect(result.more).toBe(false);
    // Round two asks for what round one could not fit, less another fee reserve.
    expect(prepare).toHaveBeenNthCalledWith(2, expect.any(String), "zkas:self", 390_000_000n, undefined, undefined, true);
  });

  it("stops at the round cap and says the wallet is not finished", async () => {
    prepare.mockResolvedValue(round("more", "100000000", "900000000"));
    submit.mockResolvedValue({ txid: "c".repeat(64), amount_sompi: 100_000_000, fee_sompi: 3_000_000 });

    const result = await consolidateNonCustodial("ab".repeat(32), "mainnet", "zkas:self", 1_000_000_000n, undefined, 3);

    expect(result.rounds).toBe(3);
    expect(result.more).toBe(true);
  });

  // Rounds already broadcast are real transactions with real fees. Reporting the
  // whole run as a clean failure would hide them from the user entirely.
  it("reports the rounds that succeeded when a later one fails", async () => {
    prepare
      .mockResolvedValueOnce(round("one", "600000000", "400000000"))
      .mockRejectedValueOnce(new Error("node unreachable"));
    submit.mockResolvedValueOnce({ txid: "a".repeat(64), amount_sompi: 600_000_000, fee_sompi: 3_000_000 });

    const result = await consolidateNonCustodial("ab".repeat(32), "mainnet", "zkas:self", 1_010_000_000n);

    expect(result.rounds).toBe(1);
    expect(result.more).toBe(true);
    expect(result.stoppedBecause).toMatch(/node unreachable/);
  });

  it("still fails loudly when the very first round fails", async () => {
    prepare.mockRejectedValue(new Error("node unreachable"));
    await expect(
      consolidateNonCustodial("ab".repeat(32), "mainnet", "zkas:self", 1_000_000_000n),
    ).rejects.toThrow(/node unreachable/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a round that cannot reduce the note count", async () => {
    prepare.mockResolvedValueOnce(round("thin", "600000000", "0", 2));
    await expect(
      consolidateNonCustodial("ab".repeat(32), "mainnet", "zkas:self", 1_000_000_000n),
    ).rejects.toThrow(/would not reduce/);
    expect(submit).not.toHaveBeenCalled();
  });
});
