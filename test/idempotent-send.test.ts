import { beforeEach, describe, expect, it, vi } from "vitest";

// A payment whose broadcast outcome is unknown must never be paid a second time: the retry
// reuses the payment's request id, and walletd answers with the transaction it already sent.
const { prepare, submit, fvkHex, verifyAndSignPayment } = vi.hoisted(() => ({
  prepare: vi.fn(),
  submit: vi.fn(),
  fvkHex: vi.fn(async () => "00".repeat(96)),
  verifyAndSignPayment: vi.fn(async () => [{ index: 0, sig: "sig" }]),
}));
vi.mock("../src/api", () => ({ api: { prepare, submit } }));
vi.mock("../src/signer", () => ({ fvkHex, verifyAndSignPayment }));

import { sendNonCustodial, SubmitUnknownError } from "../src/noncustodial";

const prep = (session: string) => ({
  session, bundle_hex: "aa", disclosure: {}, spend_auth: [{ index: 0 }],
  amount_sompi_exact: "500000000", fee_sompi_exact: "3000000", remaining_sompi_exact: "0",
});
const alreadySent = (txid: string) =>
  Object.assign(new Error("this payment was already sent"), {
    httpStatus: 409,
    alreadySent: { txid, amount_sompi: 500000000, fee_sompi: 3000000, amount_sompi_exact: "500000000", fee_sompi_exact: "3000000" },
  });

describe("idempotent sends", () => {
  beforeEach(() => {
    localStorage.clear();
    prepare.mockReset();
    submit.mockReset();
  });

  it("a retry after an unknown outcome reuses the request id and records the original transaction", async () => {
    prepare.mockResolvedValueOnce(prep("s1"));
    submit.mockRejectedValueOnce(Object.assign(new Error("timed out"), { timedOut: true }));
    await expect(sendNonCustodial("ab".repeat(32), "mainnet", "zkas:dest", 5)).rejects.toBeInstanceOf(SubmitUnknownError);
    const firstId = prepare.mock.calls[0][6];
    expect(typeof firstId).toBe("string");

    // The broadcast had gone through; walletd now answers the same id with it.
    prepare.mockRejectedValueOnce(alreadySent("tx-original"));
    const r = await sendNonCustodial("ab".repeat(32), "mainnet", "zkas:dest", 5);
    expect(prepare.mock.calls[1][6]).toBe(firstId);
    expect(r.txid).toBe("tx-original");
    expect(r.amount_sompi).toBe(500000000);
    expect(submit).toHaveBeenCalledTimes(1); // only the first, lost, broadcast
  });

  it("a fresh payment never accepts an 'already sent' claim", async () => {
    prepare.mockRejectedValueOnce(alreadySent("tx-made-up"));
    await expect(sendNonCustodial("ab".repeat(32), "mainnet", "zkas:dest", 5)).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });

  it("a different payment gets a different id", async () => {
    prepare.mockResolvedValue(prep("s"));
    submit.mockResolvedValue({ txid: "t", amount_sompi: 500000000, fee_sompi: 3000000 });
    await sendNonCustodial("ab".repeat(32), "mainnet", "zkas:dest", 5);
    await sendNonCustodial("ab".repeat(32), "mainnet", "zkas:dest", 5);
    expect(prepare.mock.calls[0][6]).not.toBe(prepare.mock.calls[1][6]);
  });
});
