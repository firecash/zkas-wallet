// Non-custodial (mobile / hardened) send — with on-device verification.
//
// The seed NEVER leaves the device, and the device NEVER blind-signs:
//
//   1. Derive the 96-byte full viewing key on-device (grants viewing, not spend).
//   2. `/prepare` — the daemon scans watch-only from the FVK, builds the Halo 2
//      proof, and returns the UNSIGNED bundle, a per-action disclosure of what it
//      pays, and one `alpha` randomizer per real spend.
//   3. On-device, `verifyAndSignPayment` reconstructs the bundle, checks it pays
//      exactly the recipient and amount the user asked for (everything else change
//      back to us), recomputes the sighash from that verified bundle, and only then
//      signs. A malicious daemon that returns a payment to itself is refused here.
//   4. `/submit` — the daemon applies the signatures, finalizes, and broadcasts.
//
// So a compromised daemon can see balances but can neither move funds (no spend key)
// nor trick the device into authorizing a payment it did not intend (it would fail a
// note/value commitment check, and the signature is over the sighash of the *checked*
// bundle, which will not finalize any other bundle).

import { api } from "./api";
import { fvkHex, verifyAndSignPayment, type Network } from "./signer";

export interface SendResult {
  txid: string;
  amount_sompi: number;
  fee_sompi: number;
}

/**
 * Send `amountFc` FireCash to `to`, non-custodially and verified on-device. `seedHex`
 * is used ONLY on this device — to derive the viewing key, to check the prepared
 * payment, and to sign it — and is never transmitted. Rejects if the daemon reports
 * insufficient matured funds, if the prepared payment does not match what was asked
 * (a lying daemon), or if the node rejects the finalized payment.
 */
export async function sendNonCustodial(
  seedHex: string,
  network: Network,
  to: string,
  amountFc: number,
  fee?: number,
): Promise<SendResult> {
  const fvk = await fvkHex(seedHex);
  const prep = await api.prepare(fvk, to, amountFc, fee);

  // Verify on-device that this bundle really pays `to` the amount asked, then sign the
  // sighash recomputed from the verified bundle. Throws (refusing to sign) on any
  // mismatch — the guard against a malicious prover.
  const sigs = await verifyAndSignPayment(
    seedHex,
    network,
    to.trim(),
    BigInt(prep.amount_sompi),
    BigInt(prep.fee_sompi),
    prep.bundle_hex,
    JSON.stringify(prep.disclosure),
    JSON.stringify(prep.spend_auth),
  );

  return api.submit(prep.session, sigs);
}
