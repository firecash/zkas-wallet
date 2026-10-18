import { describe, expect, it } from "vitest";
import { expectedWireLen, minRelayFeeForSpends, feeReserveSompi } from "../src/fees";
import { MAX_NOTES_PER_TX } from "../src/noncustodial";

/**
 * The client's fee model has to agree with the NODE's, constant for constant, and nothing
 * held that agreement.
 *
 * Under-reserving does not cost a little change: the daemon refuses the transaction
 * outright, which is the "Max produces an unpayable amount" failure recorded in App.tsx —
 * Max was computed from a flat reserve, every wallet with more than six notes got an amount
 * the daemon rejected with "insufficient matured funds", and tapping Max again refilled the
 * same unpayable figure.
 *
 * The existing fee tests pin only RELATIVE properties — that the curve rises, that it beats
 * the old flat constant. A constant drifting (884 -> 900, say) would keep every one of them
 * green while the figures diverged from the node's, so these pin the ABSOLUTE sompi.
 *
 * Derived from the canonical Rust, which is the authority:
 *   shielded-core/src/bundle.rs       expected_wire_len(n) = 117 + n*884 + (2720 + 2272n)
 *                                     where 884 = FIELD*5 + ENC 580 + OUT 80 + SIG 64
 *   sdk/wallet-engine/src/payment.rs  min_relay_fee_for_spends(n) =
 *                                       (bytes + TX_ENVELOPE_BYTES_FEE 128)
 *                                       * TRANSIENT_BYTE_TO_MASS_FACTOR 4 / 2
 *                                       * RELAY_FEE_PER_KG 100_000 / 1000
 *   mining/src/mempool/config.rs      DEFAULT_MINIMUM_RELAY_TRANSACTION_FEE = 100_000
 *
 * If one of these fails, check the Rust side FIRST — it is the node's policy that decides
 * what gets relayed, and this file is the follower.
 */
describe("the client's fee model matches the node's", () => {
  it("reproduces the canonical wire length", () => {
    // 117 header + n*884 action + (2720 + 2272n) proof.
    for (const n of [1, 2, 5, 10, 38]) {
      expect(expectedWireLen(n), `wire len at ${n}`).toBe(117 + n * 884 + (2720 + 2272 * n));
    }
  });

  it("reproduces the canonical relay minimum, to the sompi", () => {
    // Computed from the Rust formula above; these are also the figures the UI quotes.
    expect(minRelayFeeForSpends(1)).toBe(1_855_400);   // 0.018554 ZKAS — the floor the
    expect(minRelayFeeForSpends(2)).toBe(1_855_400);   // Send screen shows as its low end
    expect(minRelayFeeForSpends(5)).toBe(3_749_000);
    expect(minRelayFeeForSpends(10)).toBe(6_905_000);
    expect(minRelayFeeForSpends(20)).toBe(13_217_000);
    expect(minRelayFeeForSpends(38)).toBe(24_578_600);  // 0.245786 — the "0.2458" in the
  });                                                   // comment that explains this reserve

  it("treats one spend as two, as the node's floor does", () => {
    // `n.max(2)` in both: a single-spend bundle still pays the two-action minimum.
    expect(minRelayFeeForSpends(1)).toBe(minRelayFeeForSpends(2));
  });

  it("reserves the FULL-transaction fee, because the daemon picks the note count", () => {
    // Reserving for the notes the client expects to merge is exactly the bug: the daemon
    // chooses, and anything less than its choice is refused.
    expect(feeReserveSompi(MAX_NOTES_PER_TX)).toBe(minRelayFeeForSpends(MAX_NOTES_PER_TX));
    expect(feeReserveSompi(MAX_NOTES_PER_TX)).toBe(24_578_600);
  });

  it("never reserves less than the node would charge, at any size", () => {
    // The property that actually matters, stated directly rather than via the curve.
    for (let n = 1; n <= MAX_NOTES_PER_TX; n++) {
      expect(feeReserveSompi(n), `reserve at ${n}`).toBeGreaterThanOrEqual(minRelayFeeForSpends(n));
    }
  });
});
