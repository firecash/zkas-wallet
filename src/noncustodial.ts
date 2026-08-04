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

/// One transaction of a payment. A payment spread over many small notes needs
/// several, and each carries only its own share of the total — so the wallet must
/// record them individually rather than filing the whole amount under the first
/// txid, which would claim a transaction paid far more than it did.
export interface SendPart {
  txid: string;
  amount_sompi: number;
  fee_sompi: number;
}

/**
 * A send that failed AFTER at least one chunk was already broadcast. The parts
 * that made it to the node are real money in flight — the caller MUST record
 * them (History row + optimistic balance subtraction) before showing the error,
 * or the balance keeps showing funds that already left and invites a double-send.
 */
export class PartialSendError extends Error {
  parts: SendPart[];
  constructor(message: string, parts: SendPart[]) {
    super(message);
    this.name = "PartialSendError";
    this.parts = parts;
  }
}

export interface SendResult {
  txid: string;
  amount_sompi: number;
  fee_sompi: number;
  /// Every transaction the payment took, oldest first. A payment spread over many
  /// small notes needs more than one — `txid` is the first of these.
  txids: string[];
  /// The same transactions with their individual amounts and fees.
  parts: SendPart[];
}

/// Sompi per ZKAS, for converting a remaining balance back to the FC-denominated
/// amount `/prepare` takes.
const SOMPI_PER_ZKAS = 100_000_000;

/// Largest per-transaction fee the device will EVER authorize, in sompi (0.1 ZKAS).
/// The daemon prices fees by transaction bytes; even the largest standard
/// transaction (38 spends at the node's 500,000-mass cap) stays well under this,
/// so the bound never bites an honest daemon — but it caps what a malicious or
/// compromised daemon can burn.
/// Before this ceiling existed the device signed whatever fee the daemon reported,
/// which let a lying daemon spend the wallet's entire change as "fee" (collectable
/// by a miner — plausibly the daemon operator's own pool).
const MAX_FEE_SOMPI = 10_000_000;

/// Hard stop on the chunk loop. One transaction spends at most ~38 notes (the
/// 500,000-mass standard cap), so 24 chunks can still move a wallet fragmented
/// into ~900 small notes — beyond that something is genuinely wrong; better to
/// send what we can, then tell the user plainly how much is left and why.
const MAX_CHUNKS = 24;

/// Where a send currently is, so the UI can show honest progress instead of a
/// single opaque spinner. "proving" is the long step (the daemon builds the
/// Halo 2 proof); signing is on-device and quick; broadcast is near-instant.
export type SendStage = "proving" | "signing" | "broadcasting";

/// Progress of a payment that spans several transactions. A wallet holding many
/// small notes pays a large amount in chunks of at most ~38 notes each, which can
/// take minutes — without this the UI sits on "Building private proof…" the whole
/// time and an entirely healthy send is indistinguishable from a hung one.
export interface SendProgress {
  /// 1-based index of the transaction being built.
  part: number;
  /// Best estimate of how many transactions this payment needs, once known.
  parts: number;
  /// ZKAS already accepted by the node.
  sentFc: number;
  /// ZKAS originally requested.
  totalFc: number;
}

/**
 * Send `amountFc` ZKas to `to`, non-custodially and verified on-device. `seedHex`
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
  onStage?: (stage: SendStage, progress?: SendProgress) => void,
  memo?: string,
): Promise<SendResult> {
  const fvk = await fvkHex(seedHex);
  const sentParts: SendPart[] = [];
  const txids: string[] = [];
  let sent = 0n;
  let fees = 0n;
  // The ONE float→integer conversion, at the user-input boundary. From here on
  // every amount is integer sompi — no floating-point coin math on the wire or
  // in the chunk accounting.
  let owed = BigInt(Math.round(amountFc * Number(SOMPI_PER_ZKAS)));
  const totalSompi = owed;

  // The fee ceiling the on-device signer enforces per transaction. A custom fee is
  // a floor the daemon may raise to the byte-priced relay minimum, so the ceiling
  // is whichever is larger — the user's figure or the standing cap.
  const maxFee = BigInt(Math.max(fee ?? 0, MAX_FEE_SOMPI));

  // One transaction can spend at most ~38 notes (the 500,000-mass standard cap),
  // so a wallet whose balance sits in many small notes — a miner's per-block
  // coinbase, say — pays a large amount across several transactions. Each is a
  // complete, independently valid payment to the same recipient; we keep going
  // until the daemon reports nothing remaining. Only known after the first chunk
  // reports what one transaction can carry.
  let parts = 1;
  try {
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const progress = (): SendProgress => ({
        part: chunk + 1,
        parts: Math.max(parts, chunk + 1),
        sentFc: Number(sent) / Number(SOMPI_PER_ZKAS),
        totalFc: amountFc,
      });
      onStage?.("proving", progress());
      // The memo is sealed into the recipient's encrypted note by the prover; the
      // on-device verification below still checks recipient and amounts, which are
      // what a malicious prover could actually steal with.
      const prep = await api.prepare(fvk, to, owed, fee, memo, true);
      // Exact integer figures; the plain-number fields are the fallback for a
      // daemon that predates the *_exact decimal strings.
      const chunkAmount = BigInt(prep.amount_sompi_exact ?? Math.round(prep.amount_sompi));
      const chunkFee = BigInt(prep.fee_sompi_exact ?? Math.round(prep.fee_sompi));
      const remaining = BigInt(prep.remaining_sompi_exact ?? Math.round(prep.remaining_sompi ?? 0));
      // A daemon that pays less than asked must account for every missing sompi
      // in `remaining` — anything else is it silently rewriting the payment.
      if (chunkAmount + remaining !== owed) {
        throw new Error("The daemon changed the requested amount. Refusing to sign.");
      }
      // Now that one chunk's capacity is known, estimate how many the payment needs.
      if (chunk === 0 && chunkAmount > 0n && remaining > 0n) {
        parts = Number((totalSompi + chunkAmount - 1n) / chunkAmount);
      }
      // Refuse an over-priced chunk BEFORE proving/signing work: the signer would
      // reject it anyway (it reads the real fee from the bundle), but this gives the
      // user a plain answer instead of a signer error.
      if (chunkFee > maxFee) {
        throw new Error(
          `The daemon asked for a fee of ${Number(chunkFee) / Number(SOMPI_PER_ZKAS)} ZKAS — above the ` +
            `${Number(maxFee) / Number(SOMPI_PER_ZKAS)} ZKAS this wallet allows. Refusing to sign.`,
        );
      }
      onStage?.("signing", progress());

      // Verify on-device that this bundle really pays `to` the amount asked — and no
      // more than `maxFee` of fee — then sign the sighash recomputed from the verified
      // bundle. Throws (refusing to sign) on any mismatch — the guard against a
      // malicious prover. The fee the device enforces is read from the bundle itself,
      // NOT from the response figure, which is display data. Note this checks against
      // the amount THIS transaction claims to pay, so a chunked payment is verified
      // chunk by chunk; the loop below is what holds the daemon to the total.
      const sigs = await verifyAndSignPayment(
        seedHex,
        network,
        to.trim(),
        chunkAmount,
        maxFee,
        prep.bundle_hex,
        JSON.stringify(prep.disclosure),
        JSON.stringify(prep.spend_auth),
      );

      onStage?.("broadcasting", progress());
      const res = await api.submit(prep.session, sigs);
      txids.push(res.txid);
      sentParts.push({ txid: res.txid, amount_sompi: res.amount_sompi, fee_sompi: res.fee_sompi });
      sent += BigInt(Math.round(res.amount_sompi));
      fees += BigInt(Math.round(res.fee_sompi));

      if (remaining <= 0n) break;
      owed = remaining;
      if (chunk === MAX_CHUNKS - 1) {
        throw new Error(
          `Sent ${Number(sent) / Number(SOMPI_PER_ZKAS)} ZKAS in ${txids.length} transactions, but ` +
            `${Number(owed) / Number(SOMPI_PER_ZKAS)} ZKAS could not be sent: this wallet's balance is split across ` +
            `too many small notes. Consolidate the wallet and send the rest.`,
        );
      }
    }
  } catch (e) {
    // A failure after ≥1 broadcast is NOT a plain failure: those chunks are real
    // money in flight. Hand the caller the parts so it can record them (History +
    // optimistic balance) before showing the error — otherwise the balance keeps
    // showing funds that already left, inviting a double-send.
    if (sentParts.length > 0) throw new PartialSendError((e as Error).message, [...sentParts]);
    throw e;
  }

  return { txid: txids[0], amount_sompi: Number(sent), fee_sompi: Number(fees), txids, parts: sentParts };
}
