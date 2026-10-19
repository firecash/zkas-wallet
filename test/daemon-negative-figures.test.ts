import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepare, submit, fvkHex, verifyAndSignPayment } = vi.hoisted(() => ({
  prepare: vi.fn(),
  submit: vi.fn(),
  fvkHex: vi.fn(async () => "00".repeat(96)),
  verifyAndSignPayment: vi.fn(async () => [{ index: 0, sig: "sig" }]),
}));
vi.mock("../src/api", () => ({ api: { prepare, submit } }));
vi.mock("../src/signer", () => ({ fvkHex, verifyAndSignPayment }));

import { sendNonCustodial } from "../src/noncustodial";

/**
 * The device guard is `verifyAndSignPayment(seed, net, to, chunkAmount, maxFee, bundle, …)`:
 * it checks the bundle pays `to` exactly `chunkAmount` and signs a sighash recomputed from
 * the bundle. Strong — but `chunkAmount` is computed on THIS side from the daemon's own
 * numbers, so whatever the daemon can make that figure become, the device will dutifully
 * verify and sign.
 *
 * `chunkAmount + remaining === owed` was the only check, and it holds just as well with
 * remaining = -X and chunkAmount = owed + X. Then `remaining <= 0n` breaks the chunk loop, so
 * the result is one quiet transaction paying up to the entire spendable balance to the
 * recipient the user typed, while the user asked for a fraction of it.
 */
const SEED = "ab".repeat(32);

function prep(amount: string, remaining: string, fee = "3000000") {
  return {
    session: "s", bundle_hex: "aa", disclosure: {}, spend_auth: [{ index: 0 }],
    amount_sompi_exact: amount, fee_sompi_exact: fee, remaining_sompi_exact: remaining,
  };
}

describe("the daemon's arithmetic is checked for sign before it is used", () => {
  beforeEach(() => {
    prepare.mockReset();
    submit.mockReset();
    verifyAndSignPayment.mockClear();
  });

  it("refuses a negative remaining that inflates the chunk", async () => {
    // User asks for 10 ZKAS. Daemon claims it is paying 1,000 with -990 left to go.
    prepare.mockResolvedValue(prep("100000000000", "-99000000000"));
    await expect(sendNonCustodial(SEED, "mainnet", "zkas:test", 10)).rejects.toThrow();
    // The point: it must never reach the signer, because the signer would verify the
    // inflated figure it was handed and sign it.
    expect(verifyAndSignPayment).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a negative amount and a negative fee too", async () => {
    prepare.mockResolvedValue(prep("-1000000000", "2000000000"));
    await expect(sendNonCustodial(SEED, "mainnet", "zkas:test", 10)).rejects.toThrow();
    prepare.mockResolvedValue(prep("1000000000", "0", "-5"));
    await expect(sendNonCustodial(SEED, "mainnet", "zkas:test", 10)).rejects.toThrow();
    expect(verifyAndSignPayment).not.toHaveBeenCalled();
  });

  it("still accepts an honest exact payment", async () => {
    prepare.mockResolvedValue(prep("1000000000", "0"));
    submit.mockResolvedValue({ txid: "t", amount_sompi: 1_000_000_000, fee_sompi: 3_000_000 });
    const res = await sendNonCustodial(SEED, "mainnet", "zkas:test", 10);
    expect(res.txids).toEqual(["t"]);
    expect(verifyAndSignPayment).toHaveBeenCalledOnce();
    // Verified against the USER's figure, which is the whole basis of the guard.
    expect(verifyAndSignPayment.mock.calls[0][3]).toBe(1_000_000_000n);
  });

  it("still accepts an honest short payment that accounts for the rest", async () => {
    prepare.mockResolvedValueOnce(prep("600000000", "400000000"));
    prepare.mockResolvedValueOnce(prep("400000000", "0"));
    submit.mockResolvedValue({ txid: "t", amount_sompi: 600_000_000, fee_sompi: 3_000_000 });
    const res = await sendNonCustodial(SEED, "mainnet", "zkas:test", 10, undefined, undefined, undefined, true);
    expect(res.txids.length).toBe(2);
  });
});
