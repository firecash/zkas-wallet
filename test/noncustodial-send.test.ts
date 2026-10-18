import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepare, submit, fvkHex, verifyAndSignPayment } = vi.hoisted(() => ({
  prepare: vi.fn(),
  submit: vi.fn(),
  fvkHex: vi.fn(async () => "00".repeat(96)),
  verifyAndSignPayment: vi.fn(async () => [{ index: 0, sig: "sig" }]),
}));

vi.mock("../src/api", () => ({ api: { prepare, submit } }));
vi.mock("../src/signer", () => ({ fvkHex, verifyAndSignPayment }));

import { consolidateNonCustodial, FragmentedWalletError, PartialSendError, sendNonCustodial } from "../src/noncustodial";
import { feeReserveSompi } from "../src/fees";
import { MAX_NOTES_PER_TX } from "../src/noncustodial";

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

/**
 * What happens when a chunk has ALREADY been broadcast and a later step fails.
 *
 * This is the most money-critical recovery path the wallet has and nothing asserted it.
 * Coins in a broadcast chunk are gone from the wallet whatever happens next, so the
 * failure cannot be reported as a plain error: the caller has to be handed the parts that
 * did go out, or the balance keeps showing funds that already left and the obvious next
 * move — send it again — spends them twice.
 *
 * Driven through the real sendNonCustodial with only the daemon and the signer mocked,
 * because the browser cannot reach this stage: getting past signing needs a bundle the
 * signer actually verifies, which takes real notes and real proofs.
 */
describe("a failure after something has already been broadcast", () => {
  beforeEach(() => {
    prepare.mockReset();
    submit.mockReset();
    verifyAndSignPayment.mockClear();
    verifyAndSignPayment.mockResolvedValue([{ index: 0, sig: "sig" }]);
  });

  const chunk = (session: string, amount: string, remaining: string) => ({
    session, bundle_hex: "aa", disclosure: {}, spend_auth: [],
    amount_sompi_exact: amount, fee_sompi_exact: "3000000", remaining_sompi_exact: remaining,
  });

  it("is a PLAIN failure when the very first submit fails, since nothing left", async () => {
    prepare.mockResolvedValue(chunk("one", "1000000000", "0"));
    submit.mockRejectedValue(new Error("submit refused"));
    const err = await sendNonCustodial("ab".repeat(32), "mainnet", "zkas:test", 10).then(
      () => null,
      (e: unknown) => e,
    );
    // NOT a partial send: reporting one would tell the user coins are in flight when
    // none are, and invite them to wait for a payment that will never arrive.
    expect(err).not.toBeInstanceOf(PartialSendError);
    expect((err as Error).message).toMatch(/submit refused/i);
  });

  it("hands back the broadcast chunk when a LATER submit fails", async () => {
    prepare
      .mockResolvedValueOnce(chunk("one", "600000000", "400000000"))
      .mockResolvedValueOnce(chunk("two", "400000000", "0"));
    submit
      .mockResolvedValueOnce({ txid: "a".repeat(64), amount_sompi: 600_000_000, fee_sompi: 3_000_000 })
      .mockRejectedValueOnce(new Error("submit refused"));
    const err = await sendNonCustodial(
      "ab".repeat(32), "mainnet", "zkas:test", 10, undefined, undefined, undefined, true,
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSendError);
    const parts = (err as PartialSendError).parts;
    expect(parts).toHaveLength(1);
    // The exact figures matter: History and the optimistic balance are rebuilt from them,
    // and a wrong amount here is a wrong balance until the next scan catches up.
    expect(parts[0]).toMatchObject({ txid: "a".repeat(64), amount_sompi: 600_000_000, fee_sompi: 3_000_000 });
  });

  it("hands back the broadcast chunk when a later SIGNING fails, not just a submit", async () => {
    // The guard has to cover every step after a broadcast, not only the submit call —
    // signing the next chunk can fail on its own (a stale anchor, a refused bundle).
    prepare
      .mockResolvedValueOnce(chunk("one", "600000000", "400000000"))
      .mockResolvedValueOnce(chunk("two", "400000000", "0"));
    submit.mockResolvedValueOnce({ txid: "c".repeat(64), amount_sompi: 600_000_000, fee_sompi: 3_000_000 });
    verifyAndSignPayment
      .mockResolvedValueOnce([{ index: 0, sig: "sig" }])
      .mockRejectedValueOnce(new Error("this wallet has not yet recorded the block its spend anchor belongs to"));
    const err = await sendNonCustodial(
      "ab".repeat(32), "mainnet", "zkas:test", 10, undefined, undefined, undefined, true,
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSendError);
    expect((err as PartialSendError).parts).toHaveLength(1);
    expect((err as PartialSendError).parts[0].txid).toBe("c".repeat(64));
  });

  it("hands back EVERY broadcast chunk, not only the last one", async () => {
    prepare
      .mockResolvedValueOnce(chunk("one", "400000000", "600000000"))
      .mockResolvedValueOnce(chunk("two", "300000000", "300000000"))
      .mockResolvedValueOnce(chunk("three", "300000000", "0"));
    submit
      .mockResolvedValueOnce({ txid: "d".repeat(64), amount_sompi: 400_000_000, fee_sompi: 3_000_000 })
      .mockResolvedValueOnce({ txid: "e".repeat(64), amount_sompi: 300_000_000, fee_sompi: 3_000_000 })
      .mockRejectedValueOnce(new Error("submit refused"));
    const err = await sendNonCustodial(
      "ab".repeat(32), "mainnet", "zkas:test", 10, undefined, undefined, undefined, true,
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSendError);
    expect((err as PartialSendError).parts.map((p) => p.txid)).toEqual(["d".repeat(64), "e".repeat(64)]);
  });

  it("refuses a chunk whose figures do not add up to what is still owed", async () => {
    // Found by writing a careless mock: it claimed amount+remaining = the ORIGINAL total
    // on every chunk, so from the second one on it no longer matched what was left to
    // pay. The send refused it rather than signing it, and still handed back the chunk
    // already broadcast — which is the behaviour worth pinning, since a daemon whose
    // arithmetic drifts mid-chunking is exactly how a payment silently overpays.
    prepare
      .mockResolvedValueOnce(chunk("one", "100000000", "900000000"))
      .mockResolvedValueOnce(chunk("two", "100000000", "900000000"));
    submit.mockResolvedValue({ txid: "f".repeat(64), amount_sompi: 100_000_000, fee_sompi: 3_000_000 });
    const err = await sendNonCustodial(
      "ab".repeat(32), "mainnet", "zkas:test", 10, undefined, undefined, undefined, true,
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSendError);
    expect((err as PartialSendError).parts).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("reports what went and what is still owed when the chunk cap is reached", async () => {
    // Consistent chunks that each pay a sliver: the run has to stop at the cap and say
    // what did and did not go, rather than returning a success for a part-paid invoice.
    // The mock answers from the amount actually ASKED for, so the figures stay coherent
    // the way a real daemon's would.
    prepare.mockImplementation(async (_fvk: string, _to: string, owed: bigint) => {
      // MAX_CHUNKS is 24; 10 ZKAS in 1e8 slivers is ten chunks and completes, so the
      // sliver has to be small enough that the total cannot be covered in 24 of them.
      const pay = 20_000_000n;
      const paying = owed > pay ? pay : owed;
      return {
        session: "n", bundle_hex: "aa", disclosure: {}, spend_auth: [],
        amount_sompi_exact: paying.toString(),
        fee_sompi_exact: "3000000",
        remaining_sompi_exact: (owed - paying).toString(),
      };
    });
    submit.mockImplementation(async () => ({ txid: "f".repeat(64), amount_sompi: 20_000_000, fee_sompi: 3_000_000 }));
    const err = await sendNonCustodial(
      "ab".repeat(32), "mainnet", "zkas:test", 10, undefined, undefined, undefined, true,
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSendError);
    // Several chunks really were broadcast, and every one is accounted for.
    expect((err as PartialSendError).parts.length).toBeGreaterThan(1);
    expect((err as PartialSendError).parts.length).toBe(submit.mock.calls.length);
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
    //
    // Derived, not hardcoded. This assertion used to read 390_000_000n, which encoded a
    // flat 10,000,000 reserve — and that reserve was the bug: the real relay minimum for a
    // full 38-note transaction is 24,578,600, so consolidation asked for more than it
    // could pay for and the daemon refused every time with "insufficient matured funds".
    // Pinning the number here is what let that ship; pinning the FORMULA cannot.
    const reserve = BigInt(feeReserveSompi(MAX_NOTES_PER_TX));
    expect(prepare).toHaveBeenNthCalledWith(2, expect.any(String), "zkas:self", 400_000_000n - reserve, undefined, undefined, true);
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
