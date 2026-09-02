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
import { feeReserveSompi, minRelayFeeForSpends } from "./fees";

/// One transaction of a payment. Normal payments are exactly one transaction;
/// this list has several entries only after the user explicitly accepts split
/// delivery for a fragmented wallet.
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

/** A normal payment did not fit in one consensus-standard transaction. No
 * transaction has been signed or broadcast when this is raised. */
export class FragmentedWalletError extends Error {
  constructor(message = "This payment needs more notes than one transaction can spend.") {
    super(message);
    this.name = "FragmentedWalletError";
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
export const SOMPI_PER_ZKAS = 100_000_000;

/// Largest per-transaction fee the device will authorize, in sompi — priced for the
/// transaction actually being signed rather than as one flat number.
///
/// The ceiling exists because the device used to sign whatever fee the daemon reported,
/// which let a lying daemon spend the wallet's entire change as "fee" (collectable by a
/// miner — plausibly the daemon operator's own pool). That reasoning is sound and stays.
///
/// The flat 10,000,000 (0.1 ZKAS) that implemented it was not. Its comment claimed "even
/// the largest standard transaction (38 spends) stays well under this"; the real relay
/// minimum for 38 spends is 24,578,600 — two and a half times over. Fees here are priced
/// by BYTES, and a 38-note bundle is ~123 KB, so the ceiling bound legitimate transactions
/// long before it bound malicious ones. It covered about 15 spends.
///
/// Consequences, both reported live: consolidation reserved 0.1 ZKAS for a fee that was
/// 0.246, so it asked to spend more than it could pay for and the daemon refused with
/// "insufficient matured funds: have X, need X+fee" — for hours, because waiting cannot
/// fix arithmetic. And had planning succeeded, the device would then have refused to sign
/// its own consolidation.
///
/// A ceiling that scales with the transaction is both safer and correct: 2x the relay
/// minimum for that spend count still catches a daemon inflating a fee, while never
/// blocking an honest one.
export function maxFeeForSpends(nSpends: number): number {
  return minRelayFeeForSpends(nSpends) * 2;
}

/// Ceiling for a full-size transaction — what to use when the spend count is not yet
/// known, which is every point before the daemon has planned the round.
export const MAX_FEE_SOMPI = maxFeeForSpends(38);

/// Notes one standard transaction can spend, mirroring the node's 500,000 block-mass
/// cap. The wallet only ever uses this to *explain* and to estimate — walletd decides
/// what actually fits — but if the node's mass limit changes, this is the figure that
/// must change with it (see WALLET-STACK "constants that must stay in sync").
export const MAX_NOTES_PER_TX = 38;

/// Hard stop on the chunk loop. One transaction spends at most ~38 notes (the
/// 500,000-mass standard cap), so 24 chunks can still move a wallet fragmented
/// into ~900 small notes — beyond that something is genuinely wrong; better to
/// send what we can, then tell the user plainly how much is left and why.
const MAX_CHUNKS = 24;

/// Where a send currently is, so the UI can show honest progress instead of a
/// single opaque spinner. "proving" is the long step (the daemon builds the
/// Halo 2 proof); signing is on-device and quick; broadcast is near-instant.
export type SendStage = "proving" | "signing" | "broadcasting";

/// Progress of an explicitly approved split payment. A wallet holding many small
/// notes can pay in chunks of at most ~38 notes each, which can take minutes.
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
  allowMultipleTransactions = false,
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
    const chunkLimit = allowMultipleTransactions ? MAX_CHUNKS : 1;
    for (let chunk = 0; chunk < chunkLimit; chunk++) {
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
      // A normal transfer is all-or-nothing: without partial mode walletd
      // rejects an over-fragmented payment before it builds, signs or broadcasts
      // anything. Multi-transaction delivery is an explicit user choice.
      const prep = await api.prepare(fvk, to, owed, fee, memo, allowMultipleTransactions);
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
      if (!allowMultipleTransactions && (remaining !== 0n || chunkAmount !== owed)) {
        throw new FragmentedWalletError(
          "The wallet service could not prepare the complete amount in one transaction.",
        );
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
    if (!allowMultipleTransactions && /needs more than .*input notes|send in smaller chunks/i.test((e as Error).message)) {
      throw new FragmentedWalletError(
        "Nothing was sent. This wallet has too many small notes for that amount to fit in one transaction.",
      );
    }
    throw e;
  }

  return { txid: txids[0], amount_sompi: Number(sent), fee_sompi: Number(fees), txids, parts: sentParts };
}

export interface ConsolidationResult {
  txid: string;
  /// Total notes merged across every round.
  inputs: number;
  amount_sompi: number;
  fee_sompi: number;
  /// One entry per broadcast consolidation transaction, oldest first.
  txids: string[];
  /// How many rounds ran. More than one means the wallet was too fragmented for
  /// a single transaction to reach.
  rounds: number;
  /// True when the loop stopped at `maxRounds` with merging still possible, so
  /// the caller can say the wallet is better but not finished.
  more: boolean;
  /// Why the loop stopped early, when it stopped on a failure rather than on
  /// having nothing left to merge. Present only alongside completed rounds:
  /// those transactions are broadcast and must be reported, not discarded with
  /// the error that ended the run.
  stoppedBecause?: string;
}

/// Rounds one call will run back to back. A round merges at most one standard
/// transaction's worth of notes (~38 at the 500,000-mass cap), so a wallet with
/// hundreds of small notes needs many. The cap keeps a single tap from spending
/// an unbounded number of fees.
export const MAX_CONSOLIDATION_ROUNDS = 12;

/// Below this a round cannot reduce the note count: merging two notes into one
/// change note plus a fee is not progress.
export const MIN_NOTES_PER_ROUND = 3;

/// Why three and not two, which "merging" would suggest:
///
/// A round reserves the fee ceiling for a FULL 38-note transaction but only pays
/// the relay fee for the notes it actually spends. The difference — up to ~0.23
/// ZKAS — comes back as a CHANGE note. So a round spending k notes produces two
/// (the merged note and that change), and only reduces the wallet's note count
/// when k > 2. A two-note round is 2 in, 2 out: a fee for nothing.
export const MIN_NOTES_PER_MERGE = MIN_NOTES_PER_ROUND;

/** Merge matured notes back into this wallet without handing the seed to walletd.
 * Uses the same prepare/verify/sign/submit protocol as a payment, so it works
 * against both hosted and self-run wallet services.
 *
 * Rounds run **back to back with no wait between them**. A submitted note leaves
 * the spendable set the moment it is broadcast (walletd parks it in its pending
 * spends), so the next round selects a completely different set of notes and
 * cannot double-spend the last one. Waiting for maturity between rounds — the
 * obvious-looking alternative — would make a 400-note wallet take hours, which
 * is the whole reason consolidation was not solving anybody's problem. Only the
 * final merged note has to mature before it can be spent.
 */
export async function consolidateNonCustodial(
  seedHex: string,
  network: Network,
  ownAddress: string,
  spendableSompi: bigint,
  onStage?: (stage: SendStage) => void,
  maxRounds = MAX_CONSOLIDATION_ROUNDS,
  onRound?: (round: number, mergedNotes: number) => void,
  /// How many spendable notes to LEAVE the wallet holding.
  ///
  /// Sweeping everything into a single note is the tidiest result and the worst
  /// one to live with: the next payment spends that note and its change is
  /// unmatured for ~10 minutes, so the wallet cannot pay again until it matures.
  /// Ending with a few notes lets the user pay several times back to back. 1 keeps
  /// the old behaviour, which is what background maintenance wants.
  targetNotes = 1,
  /// Spendable notes the wallet currently holds. Splitting is only worth doing
  /// when every note it produces can still be MERGED from several — see
  /// `wantedNotes`. Defaults to 0, which disables splitting, so a caller that
  /// does not know the count can never make the wallet worse.
  noteCount = 0,
  /// GROW mode: instead of merging notes into fewer, split the balance into MORE
  /// notes so the wallet can pay several times back to back (each payment's change
  /// is unspendable for ~10 min, so one note = one payment then a wait). Each round
  /// spends one matured note and produces two (a piece + its change), so this can
  /// add at most one usable note per matured note the wallet holds; the rest come
  /// after they mature. A round that spends one note is the POINT here, not a
  /// fee-wasting mistake, so the merge guards are inverted.
  grow = false,
): Promise<ConsolidationResult> {
  if (spendableSompi <= BigInt(feeReserveSompi(MAX_NOTES_PER_TX)))
    throw new Error("There is not enough spendable balance to consolidate safely.");
  const fvk = await fvkHex(seedHex);
  const txids: string[] = [];
  let inputs = 0;
  let amount = 0n;
  let fees = 0n;
  let more = false;
  let stoppedBecause: string | undefined;
  // Reserving the hard fee ceiling prevents an insufficient-funds error. A
  // heavily fragmented wallet takes the partial-capacity path, which produces
  // one self-note and zero change; smaller wallets may produce one small change
  // note, but this action is offered only when the note count exceeds the
  // standard transaction input cap.
  let available = spendableSompi;
  // Reserve the fee for the notes this wallet could ACTUALLY spend, not always
  // the 38-note ceiling.
  //
  // walletd derives change from the inputs (`change = selected - amount - fee`),
  // so every sompi reserved beyond the real fee comes back as a CHANGE NOTE. At
  // the 38-note ceiling that is 0.2458 ZKAS on a wallet whose four-note pass only
  // costs 0.0312 — so "merge everything into one note" quietly produced two, and
  // the wallet was never as consolidated as it claimed.
  //
  // Reserving by note count is safe in the only direction that matters: walletd
  // can never select more notes than the wallet holds, and the fee is monotone in
  // the count, so this always reserves ENOUGH. Callers that do not know the count
  // pass 0 and keep the old ceiling.
  const reserve = BigInt(feeReserveSompi(
    noteCount > 0 ? Math.min(noteCount, MAX_NOTES_PER_TX) : MAX_NOTES_PER_TX,
  ));
  // Never ask for more chunks than the wallet can produce by MERGING: each one
  // has to come from at least MIN_NOTES_PER_MERGE notes. Asking for more would
  // spend a fee per round without reducing the note count, and end up MORE
  // fragmented — paying for the opposite of what the button promises.
  let wantedNotes = grow
    ? Math.max(2, targetNotes)
    : Math.max(1, Math.min(targetNotes, Math.floor(noteCount / MIN_NOTES_PER_MERGE)));

  for (let round = 0; round < Math.max(1, maxRounds); round++) {
    // Reserve the relay minimum for a FULL transaction. The daemon picks the final note
    // count, and reserving for fewer than it picks is exactly the bug this replaced.
    const sweepable = available - reserve;
    if (sweepable <= 0n) break;
    // Ask for a SHARE of what is left rather than all of it, so the wallet ends up
    // holding `targetNotes` notes instead of one. Each round still merges as many
    // input notes as a transaction can carry — only the size of the note it
    // produces changes. The last wanted note takes the remainder, so nothing is
    // stranded by integer division.
    const stillWanted = Math.max(1, wantedNotes - txids.length);
    const share = stillWanted > 1 ? sweepable / BigInt(stillWanted) : sweepable;
    // Never mint dust: a note worth less than a few fees is not usable change.
    const floor = reserve * 2n;
    let requested = share < floor ? sweepable : share;
    try {
    onStage?.("proving");
    let prep = await api.prepare(fvk, ownAddress, requested, undefined, undefined, true);
    // A split round is only worth its fee if it actually merges notes. When the
    // daemon covers a whole share from ONE note, splitting would move value for
    // nothing — stop splitting and sweep the rest instead. Preparing does not
    // broadcast, so the discarded attempt costs nothing.
    if (!grow && requested !== sweepable && prep.spend_auth.length < MIN_NOTES_PER_MERGE) {
      wantedNotes = 1;
      requested = sweepable;
      prep = await api.prepare(fvk, ownAddress, requested, undefined, undefined, true);
    }
    const roundAmount = BigInt(prep.amount_sompi_exact ?? Math.round(prep.amount_sompi));
    const roundFee = BigInt(prep.fee_sompi_exact ?? Math.round(prep.fee_sompi));
    const remaining = BigInt(prep.remaining_sompi_exact ?? Math.round(prep.remaining_sompi ?? 0));
    // Priced for the notes this round actually spends, so a small round is held to a
    // small ceiling instead of the full-size one.
    if (roundAmount <= 0n || roundFee > BigInt(maxFeeForSpends(prep.spend_auth.length || MAX_NOTES_PER_TX))) {
      if (txids.length) break;
      throw new Error("The wallet service returned an unsafe consolidation.");
    }
    // MERGE needs at least MIN_NOTES_PER_ROUND inputs, or the change note leaves the
    // count unchanged. GROW is the opposite: one input becoming two outputs is exactly
    // what adds a note, so a single-input round is valid — only require that it spends
    // at least one note and actually moves value.
    if (grow) {
      if (prep.spend_auth.length < 1) {
        if (txids.length) break;
        throw new Error("No spendable note is available to split right now. Wait for recent funds to mature (about 10 minutes), then try again.");
      }
    } else if (prep.spend_auth.length < MIN_NOTES_PER_ROUND) {
      // Not a failure once work is already done — it is the natural end of the
      // loop, and reporting it as an error would hide rounds that succeeded.
      if (txids.length) break;
      throw new Error("Fewer than three notes are spendable right now, so consolidating would not reduce the wallet's note count.");
    }
    onStage?.("signing");
    const signatures = await verifyAndSignPayment(
      seedHex,
      network,
      ownAddress,
      roundAmount,
      BigInt(MAX_FEE_SOMPI),
      prep.bundle_hex,
      JSON.stringify(prep.disclosure),
      JSON.stringify(prep.spend_auth),
    );
    onStage?.("broadcasting");
    const submitted = await api.submit(prep.session, signatures);
    txids.push(submitted.txid);
    inputs += prep.spend_auth.length;
    amount += BigInt(Math.round(submitted.amount_sompi));
    fees += BigInt(Math.round(submitted.fee_sompi));
    onRound?.(txids.length, inputs);

    // Growing: stop once enough new notes exist (each round adds one).
    if (grow && txids.length >= wantedNotes - 1) break;
    // Everything the wallet could offer went into this round.
    if (remaining <= reserve) break;
    // When splitting, `remaining` is only the part of THIS round's share that did
    // not fit; the rest of the balance is still there for the next note.
    available = wantedNotes > 1 ? available - roundAmount - roundFee : remaining;
    if (available <= reserve) break;
    if (round === Math.max(1, maxRounds) - 1) more = true;
    } catch (cause) {
      // Rounds already broadcast are real transactions. Throwing here would
      // erase them from the user's view while their fees were already spent and
      // their notes already moved — the same class of mistake as reporting a
      // partially delivered payment as a clean failure.
      if (!txids.length) throw cause;
      stoppedBecause = (cause as Error).message || String(cause);
      more = true;
      break;
    }
  }

  return {
    txid: txids[0],
    inputs,
    amount_sompi: Number(amount),
    fee_sompi: Number(fees),
    txids,
    rounds: txids.length,
    more,
    ...(stoppedBecause ? { stoppedBecause } : {}),
  };
}
