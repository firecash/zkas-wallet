// Non-custodial (mobile / hardened) send.
//
// The seed NEVER leaves the device. The flow is Orchard's prove/sign split:
//
//   1. Derive the 96-byte full viewing key on-device (grants viewing, not spend).
//   2. `/prepare` — the daemon scans watch-only from the FVK, builds the Halo 2
//      proof, and returns the payment `sighash` plus one `alpha` randomizer per real
//      spend it needs authorized.
//   3. For each request, sign `ask.randomize(alpha)` over the sighash on-device
//      (via firecash-signer WASM). The signatures are the only thing that leaves.
//   4. `/submit` — the daemon applies the signatures, finalizes, and broadcasts.
//
// A compromised daemon can therefore see balances but can NEVER move funds: it
// holds no spend authority. This mirrors the shielded-core round-trip proven by
// `non_custodial_payment_api_roundtrip`.

import { api } from "./api";
import { fvkHex, signSpendAuth } from "./signer";

export interface SendResult {
  txid: string;
  amount_sompi: number;
  fee_sompi: number;
}

/**
 * Send `amountFc` FireCash to `to`, non-custodially. `seedHex` is used ONLY
 * on-device — to derive the viewing key and to sign each spend — and is never
 * transmitted. Rejects if the daemon reports insufficient matured funds, if a
 * signature can't be produced, or if the node rejects the finalized payment.
 */
export async function sendNonCustodial(
  seedHex: string,
  to: string,
  amountFc: number,
  fee?: number,
): Promise<SendResult> {
  const fvk = await fvkHex(seedHex);
  const prep = await api.prepare(fvk, to, amountFc, fee);

  // Sign every requested spend on-device, in the order the daemon asked.
  const sigs: { index: number; sig: string }[] = [];
  for (const sa of prep.spend_auth) {
    const sig = await signSpendAuth(seedHex, sa.alpha, prep.sighash);
    sigs.push({ index: sa.index, sig });
  }

  return api.submit(prep.session, sigs);
}
