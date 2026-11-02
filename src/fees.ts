// What a shielded transaction actually costs to relay.
//
// This mirrors `min_relay_fee_for_spends` in `sdk/wallet-engine/src/payment.rs`. The wallet
// needs it because it must RESERVE the fee out of a balance before asking the daemon to
// spend the rest — and a reserve that is too small is not a rounding error, it is a
// transaction the daemon refuses outright.
//
// It was a hardcoded 10,000,000 sompi (0.1 ZKAS). The real fee is byte-priced and a
// shielded action is 884 bytes plus 2,272 bytes of proof, so:
//
//     2 spends  →  0.019 ZKAS
//    15 spends  →  0.100 ZKAS   ← where the old constant ran out
//    38 spends  →  0.246 ZKAS   ← 2.5x the old constant
//
// Consolidation merges up to 38 notes by design, so every consolidation of more than ~15
// notes asked for more than it could pay for and was refused with "insufficient matured
// funds: have X, need X+fee". Reported live by a user whose shortfall (~10.77M sompi)
// pinpointed a 30–34 note merge. Waiting never helped: the balance was never the problem.
//
// Derived rather than pasted so it cannot drift from the node again.

/// Bytes of one Orchard action on the wire: 5 field elements, the note ciphertext, the
/// out-ciphertext and a signature. Mirrors `ActionWire::SERIALIZED_LEN`.
const ACTION_BYTES = 32 * 5 + 580 + 80 + 64;

/// Proof bytes: a fixed part plus a per-action part. Mirrors `expected_proof_len`.
const PROOF_FIXED = 2_720;
const PROOF_PER_ACTION = 2_272;

/// Bundle header. Mirrors the leading constant in `expected_wire_len`.
const BUNDLE_HEADER = 117;

/// Transaction envelope allowance used when pricing. Mirrors `TX_ENVELOPE_BYTES_FEE`.
const ENVELOPE_BYTES = 128;

/// Mass charged per serialized byte, and the relay price per kilogram. Mirrors
/// `TRANSIENT_BYTE_TO_MASS_FACTOR` and `RELAY_FEE_PER_KG`.
const BYTE_TO_MASS = 4;
const RELAY_FEE_PER_KG = 100_000;

/** Serialized size of a bundle with `n` actions. */
export function expectedWireLen(n: number): number {
  return BUNDLE_HEADER + n * ACTION_BYTES + (PROOF_FIXED + PROOF_PER_ACTION * n);
}

/**
 * Minimum fee the node will relay a transaction spending `n` notes for, in sompi.
 *
 * The node applies this floor regardless of what the caller asks for, so a wallet that
 * reserves less than this cannot construct a spendable transaction at all.
 */
export function minRelayFeeForSpends(n: number): number {
  const bytes = expectedWireLen(Math.max(n, 2)) + ENVELOPE_BYTES;
  return Math.floor((Math.floor((bytes * BYTE_TO_MASS) / 2) * RELAY_FEE_PER_KG) / 1000);
}

/**
 * What to hold back from a balance before asking to spend the rest.
 *
 * Priced for a FULL transaction rather than the notes we expect to merge: the daemon
 * chooses the final note count, and reserving for fewer than it picks reproduces exactly
 * the bug this exists to prevent. Over-reserving costs a little unspent change on the
 * round; under-reserving costs the whole operation.
 */
export function feeReserveSompi(maxSpendsPerTx: number): number {
  return chunkFeeSompi(maxSpendsPerTx);
}

/// The wallet's fee floor for a shielded payment. Mirrors `DEFAULT_FEE_SOMPI`: both the wallet
/// service and the in-browser engine charge `max(this, relay minimum)` when no fee is chosen
/// (`chunk_fee`), so a quote of the relay minimum alone was 0.018554 on a payment that then
/// paid 0.03 - over the "Total <=" the confirm screen promised (test wallet, 2 Nov).
export const WALLET_FEE_FLOOR_SOMPI = 3_000_000;

/** What a payment spending `n` notes is charged when no fee is chosen. Mirrors `chunk_fee`. */
export function chunkFeeSompi(n: number): number {
  return Math.max(WALLET_FEE_FLOOR_SOMPI, minRelayFeeForSpends(n));
}
