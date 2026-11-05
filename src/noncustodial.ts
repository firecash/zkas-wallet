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

import { error as diagError, event as diagEvent, span as diagSpan } from "./diag/log";
import { api, type PrepareResp } from "./api";
import { elapsedSince } from "./lib/elapsed";
import { readLocal, writeLocal } from "./lib/safestore";
import { fvkHex, verifyAndSignPayment, type Network } from "./signer";
import { feeReserveSompi, minRelayFeeForSpends } from "./fees";
import i18n from "./i18n";

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
/// A submit whose outcome the wallet does not know.
///
/// `/api/wallet/submit` is the call that broadcasts. If it answers — even with an error —
/// the daemon decided, and the daemon is explicit when it has not broadcast ("cannot reach
/// the node to broadcast; nothing was sent"). If it does NOT answer, the wallet knows
/// nothing: `api.ts` marks a request that timed out, and its own note says a timeout means
/// "something accepted the connection and is still working". For a broadcast that is the
/// dangerous case — the transaction may already be on the network.
///
/// It had no type of its own, so a 60-second submit timeout reached the user as "the wallet
/// service is not responding", worded exactly like a failure that never left the device.
/// Being told a payment failed when it is in flight is how somebody pays twice.
export class SubmitUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmitUnknownError";
  }
}

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
  constructor(message = i18n.t("noncustodial.fragmentedDefault")) {
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
/// single opaque spinner. "warming" is the one-time step a first payment from a
/// local engine may hit — the daemon building the wallet's spend index, with a
/// real percentage; "proving" is the long step (the daemon builds the
/// Halo 2 proof); signing is on-device and quick; broadcast is near-instant.
export type SendStage = "warming" | "proving" | "signing" | "broadcasting";

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
  /// While `stage` is "warming": how far the daemon's spend-index build is, as the
  /// daemon reports it (`status.warming_pct` / `warming_eta_secs`). Null when the
  /// daemon has not produced a rate yet.
  warmingPct?: number | null;
  warmingEtaSecs?: number | null;
  /// While `stage` is "warming" for a reason other than the index build — the
  /// wallet is finishing its own background merge — the one line to show for it.
  note?: string;
}

/// A spend-index build the daemon reports in flight (see `Status.warming_pct`).
export interface IndexProgress {
  pct: number | null;
  etaSecs: number | null;
  done: number | null;
}

/// How often the send flow asks the daemon where its spend-index build is.
const INDEX_POLL_MS = 2_000;
/// Give up waiting if the build's leaf counter has not moved for this long: the
/// daemon reports progress every ~1 K leaves, so a genuinely running build advances
/// many times a minute, and one that has not for ten minutes is not going to.
const INDEX_STALL_MS = 10 * 60_000;

/// The daemon's spend-index build for this wallet, if one is running right now.
async function indexProgress(): Promise<IndexProgress | null> {
  try {
    const s = await api.status();
    if (typeof s.warming_pct !== "number") return null;
    return { pct: s.warming_pct, etaSecs: s.warming_eta_secs ?? null, done: s.warming_done_leaves ?? null };
  } catch {
    return null;
  }
}

/// Wait for a running spend-index build to finish, reporting its progress as it goes.
/// Resolves true when the daemon no longer reports one (built, or given up on its
/// side — either way a prepare can be asked for), false if it stalled.
async function waitForSpendIndex(onProgress: (p: IndexProgress) => void): Promise<boolean> {
  let lastDone: number | null = null;
  let movedAt = Date.now();
  for (;;) {
    const p = await indexProgress();
    if (!p) return true;
    onProgress(p);
    if (p.done !== lastDone) {
      lastDone = p.done;
      movedAt = Date.now();
      // elapsedSince: a backward step makes this negative, which is never >= the limit, so a
      // genuinely stalled index would never be detected and this loop would wait forever.
    } else if (elapsedSince(movedAt) >= INDEX_STALL_MS) {
      return false;
    }
    await new Promise((r) => setTimeout(r, INDEX_POLL_MS));
  }
}

/// A prepare that did not come back because the wallet's spend index was being built
/// behind it: the transport gave up at its ceiling, or the daemon answered 429 naming
/// the build. Only meaningful together with the daemon CONFIRMING a build in flight —
/// a timeout for any other reason, or a 429 for a genuine second payment, stays the
/// failure it always was.
function looksLikeIndexWait(message: string): boolean {
  return /timed out|still being prepared|spend index/i.test(message);
}

/// A prepare refused (429) because THIS wallet already has one in flight: the app's
/// own background merge (`useMaintenance`), or a previous payment whose proof is
/// still running on the server. Both finish on their own — a merge holds the
/// wallet for the length of one proof, typically 30-60 s — and the daemon's own
/// wording says "your payment can be sent straight after". So it is a wait, not a
/// failure to hand back with the form.
function looksLikeBusyWallet(message: string): boolean {
  return /merging its own notes|still being prepared/i.test(message);
}
/// How long a send will wait for the wallet's in-flight prepare before giving up
/// with the daemon's message. Well above one merge proof; short of a hang.
const BUSY_WALLET_WAIT_MS = 120_000;

/// The one-line reason shown while waiting out a busy wallet.
function busyWalletNote(message: string): string {
  return /merging its own notes/i.test(message) ? i18n.t("noncustodial.finishingMerge") : i18n.t("noncustodial.waitingPrevious");
}

/**
 * `api.prepare`, made aware of the one-time spend-index build a first payment from a
 * local engine may be waiting on.
 *
 * The daemon runs that build detached and keeps its result whatever the client does,
 * but the UI used to abort the request at its 300 s ceiling and report "not
 * responding" — while the engine went on building for the better part of an hour with
 * nothing on screen. Now: if a build is already running, wait for it first with its
 * percentage on screen; while a prepare is in flight, keep polling so the same
 * percentage shows instead of a bare spinner; and if the request does time out (or is
 * refused) while the daemon confirms a build is running, wait it out and ask again
 * rather than fail. The daemon's own per-wallet guard means a re-issued prepare never
 * duplicates work.
 */
async function prepareWaitingForIndex<T>(
  prepare: () => Promise<T>,
  onWarming: (p: IndexProgress) => void,
  onProving: () => void,
  /// When given, a 429 for a prepare THIS wallet already has running (its own
  /// background merge, a previous payment) is waited out — polling every
  /// INDEX_POLL_MS for up to BUSY_WALLET_WAIT_MS — with the reason reported here,
  /// instead of failing the send. Absent, such a 429 is the error it always was.
  onBusy?: (note: string, waitedSecs: number) => void,
): Promise<T> {
  const settle = async () => {
    const finished = await waitForSpendIndex(onWarming);
    onProving();
    return finished;
  };
  if (await indexProgress()) await settle();
  let busySince: number | null = null;
  for (let attempt = 0; ; ) {
    // Side poll: a build the daemon starts FOR this prepare shows up here, so the
    // scene reads "Preparing … 12%" rather than "proving" for five silent minutes.
    let stop = false;
    void (async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, INDEX_POLL_MS));
        if (stop) return;
        const p = await indexProgress();
        if (p && !stop) onWarming(p);
      }
    })();
    try {
      return await prepare();
    } catch (e) {
      stop = true;
      const msg = (e as Error).message ?? "";
      // A wallet busy with its own earlier prepare: wait, then ask again. These
      // retries do not count against the index-build attempts below — the merge
      // that caused them can itself be waiting on the index.
      if (onBusy && looksLikeBusyWallet(msg)) {
        // The earlier prepare may itself be waiting on the one-time index build:
        // that is the build's clock (with its percentage), not the busy one.
        if (await indexProgress()) {
          if (!(await settle())) throw e;
          busySince = null;
          continue;
        }
        if (busySince == null) busySince = Date.now();
        // elapsedSince, because this is a decision and not just a display: a backward clock
        // step makes a raw subtraction negative, which is never >= the limit, so the wait for
        // a busy wallet would never time out and the send would sit here indefinitely.
        const waited = elapsedSince(busySince);
        if (waited >= BUSY_WALLET_WAIT_MS) throw e;
        onBusy(busyWalletNote(msg), Math.round(waited / 1000));
        await new Promise((r) => setTimeout(r, INDEX_POLL_MS));
        continue;
      }
      attempt++;
      if (attempt > 2 || !looksLikeIndexWait(msg) || !(await indexProgress())) throw e;
      if (!(await settle())) throw e;
    } finally {
      stop = true;
    }
  }
}

/// Await a prepare already in flight (one started ahead of the send) while showing
/// the spend-index build the daemon may be running behind it, exactly as a prepare
/// issued here would — the early one reported its progress to nobody.
async function awaitShowingIndex<T>(inFlight: Promise<T>, onWarming: (p: IndexProgress) => void, onProving: () => void): Promise<T> {
  let stop = false;
  let warming = false;
  void (async () => {
    while (!stop) {
      await new Promise((r) => setTimeout(r, INDEX_POLL_MS));
      if (stop) return;
      const p = await indexProgress();
      if (stop) return;
      if (p) {
        warming = true;
        onWarming(p);
      } else if (warming) {
        warming = false;
        onProving();
      }
    }
  })();
  try {
    return await inFlight;
  } finally {
    stop = true;
  }
}

/// The integer sompi a user-typed amount stands for — the ONE float→integer
/// conversion, shared by the send and by a prepare started ahead of it so the
/// two agree to the sompi on what was asked.
function amountToSompi(amountFc: number): bigint {
  return BigInt(Math.round(amountFc * Number(SOMPI_PER_ZKAS)));
}

/// A /prepare started when the Confirm screen opened, before "Confirm & send".
///
/// The witness lookup and the Halo2 proof are the slow part of a payment and
/// nothing about them depends on the tap: the few seconds a person spends reading
/// the confirmation used to be pure dead time before the proof even began. The
/// daemon only records a session for a prepare — no note is parked until
/// /submit, and the session simply expires after 5 minutes — so one that is never
/// submitted costs nothing but the proof. Keyed by exactly what was asked, so an
/// edited amount or recipient can never be sent on a stale proof.
export interface PreparedAhead {
  key: string;
  startedAt: number;
  /// When the daemon answered — the moment its 5-minute session clock starts.
  /// Null while the proof is still running.
  finishedAt: number | null;
  promise: Promise<PrepareResp>;
  /// The request id this prepare was made under, and whether it reused one remembered after an
  /// unknown outcome. A payment that adopts this prepare MUST carry the same id: the daemon
  /// records a broadcast under the id of the prepare that built it.
  rid: string;
  retry: boolean;
}

/// Answered longer ago than this, a prepared session is too close to the daemon's
/// 5-minute expiry (counted from its answer, not from the request) to trust at
/// submit time; the send starts afresh instead. One still in flight is always
/// adopted: a second /prepare beside it would only be refused by the per-wallet guard.
const PREPARED_AHEAD_MAX_AGE_MS = 240_000;

// ---- Idempotent sends -----------------------------------------------------------------------
//
// Every payment carries a request id to /prepare. When a submit's outcome is UNKNOWN (no answer:
// it may be on the network) the id is kept on this device against the exact payment, and any
// retry of that payment — including the early prepare of the Confirm screen — reuses it. walletd
// answers a prepare whose id it already broadcast with the original transaction instead of
// building a second payment from other coins, which is how a lost response used to pay twice.
//
// The "already sent" answer is accepted ONLY for a reused id (a retry after an unknown outcome):
// for a fresh payment an honest daemon cannot have broadcast it, so the claim is refused rather
// than letting a lying daemon convince the user a payment went out.
const UNKNOWN_SUBMITS_KEY = "zkas_unknown_submits";
const UNKNOWN_SUBMIT_TTL_MS = 24 * 3600_000;
type UnknownSubmits = Record<string, { rid: string; at: number }>;

function loadUnknownSubmits(): UnknownSubmits {
  try {
    const all = JSON.parse(readLocal(UNKNOWN_SUBMITS_KEY) || "{}") as UnknownSubmits;
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v && typeof v.rid === "string" && now - v.at < UNKNOWN_SUBMIT_TTL_MS));
  } catch {
    return {};
  }
}

/** The request id for this payment intent, and whether it is a retry of an unknown outcome. */
export function requestIdFor(intent: string): { rid: string; retry: boolean } {
  const known = loadUnknownSubmits()[intent];
  if (known) return { rid: known.rid, retry: true };
  const rid =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return { rid, retry: false };
}

/** Keep `rid` against payment `intent` after an unknown submit outcome, so a retry reuses it and
 *  walletd answers with the transaction it already broadcast. A multi-transaction payment whose
 *  later transaction was unknown is also remembered under the REMAINDER the app then offers (a
 *  different amount, so a different intent), with the id its first transaction will carry —
 *  exactly the unknown transaction's (`chunkRid`). */
export function rememberUnknownSubmit(intent: string, rid: string): void {
  const all = loadUnknownSubmits();
  all[intent] = { rid, at: Date.now() };
  writeLocal(UNKNOWN_SUBMITS_KEY, JSON.stringify(all));
}

export function forgetUnknownSubmit(intent: string): void {
  const all = loadUnknownSubmits();
  if (!(intent in all)) return;
  delete all[intent];
  writeLocal(UNKNOWN_SUBMITS_KEY, JSON.stringify(all));
}

interface AlreadySent {
  txid: string;
  amount_sompi: number;
  fee_sompi: number;
  amount_sompi_exact?: string;
  fee_sompi_exact?: string;
}

/** The request id of transaction `chunk` of a payment: the payment's own id for the first, so a
 *  remainder retried as a new payment of its own reuses exactly the id it was sent under. */
export function chunkRid(rid: string, chunk: number): string {
  return chunk === 0 ? rid : `${rid}.${chunk}`;
}

/** walletd's "already sent" answer carried on a refused prepare, if any. */
export function alreadySentOf(e: unknown): AlreadySent | null {
  const s = (e as { alreadySent?: AlreadySent })?.alreadySent;
  return s && typeof s.txid === "string" ? s : null;
}

export function prepareKey(to: string, owed: bigint, fee: number | undefined, memo: string | undefined, allowMultiple: boolean): string {
  return [to.trim(), owed.toString(), fee ?? "", (memo ?? "").trim(), allowMultiple ? 1 : 0].join("|");
}

/// Would `sendNonCustodial` adopt this early prepare for this payment? Exactly the
/// same request, and young enough for its session to outlive the send.
export function prepareAheadUsable(
  ahead: PreparedAhead | null | undefined,
  to: string,
  amountFc: number,
  fee?: number,
  memo?: string,
  allowMultipleTransactions = false,
): boolean {
  return (
    !!ahead &&
    ahead.key === prepareKey(to, amountToSompi(amountFc), fee, memo, allowMultipleTransactions) &&
    // elapsedSince: a clock that stepped BACKWARDS makes `Date.now() - finishedAt` negative,
    // and a negative is less than any limit — so a prepare whose daemon session had long
    // expired would read as fresh and be adopted, and the payment would be submitted against
    // a session that is gone. Unknowable elapsed time reports as Infinity, which is not less
    // than the limit, so this falls back to preparing again: slower, and correct.
    (ahead.finishedAt === null || elapsedSince(ahead.finishedAt) < PREPARED_AHEAD_MAX_AGE_MS)
  );
}

/// Start the first transaction's /prepare for a payment now. The result is only
/// ever used by a `sendNonCustodial` asked for exactly the same payment; a
/// rejection is kept for that call to surface (or ignored, if the user backs out).
export function prepareAhead(
  seedHex: string,
  to: string,
  amountFc: number,
  fee?: number,
  memo?: string,
  allowMultipleTransactions = false,
): PreparedAhead {
  const owed = amountToSompi(amountFc);
  const { rid, retry } = requestIdFor(prepareKey(to, owed, fee, memo, allowMultipleTransactions));
  const promise = (async () => {
    const fvk = await fvkHex(seedHex);
    return prepareWaitingForIndex(
      () => api.prepare(fvk, to, owed, fee, memo, allowMultipleTransactions, rid),
      () => undefined,
      () => undefined,
    );
  })();
  const ahead: PreparedAhead = { key: prepareKey(to, owed, fee, memo, allowMultipleTransactions), startedAt: Date.now(), finishedAt: null, promise, rid, retry };
  // Nobody may be listening if the user backs out; an unhandled rejection is not
  // an error here. The send that adopts the promise re-awaits it and gets it.
  promise.then(
    () => {
      ahead.finishedAt = Date.now();
    },
    () => undefined,
  );
  return ahead;
}

/**
 * Send `amountFc` ZKas to `to`, non-custodially and verified on-device. `seedHex`
 * is used ONLY on this device — to derive the viewing key, to check the prepared
 * payment, and to sign it — and is never transmitted. Rejects if the daemon reports
 * insufficient matured funds, if the prepared payment does not match what was asked
 * (a lying daemon), or if the node rejects the finalized payment.
 *
 * `ahead`: a `prepareAhead` started for this same payment; adopted for the first
 * transaction when its key matches and it is young enough, otherwise ignored.
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
  ahead?: PreparedAhead | null,
): Promise<SendResult> {
  // The diagnostic log's view of a payment: one span per stage, the stage a failure
  // happened in, and how long proving took per spent note. Never the amount (a magnitude
  // bucket), the recipient, the memo or anything the signer handles.
  const whole = diagSpan("send", "done", { kind: "noncustodial" });
  let stage = "fvk";
  let spendsTotal = 0;
  let proveMsTotal = 0;
  diagEvent("send", "start", { kind: "noncustodial", multi: allowMultipleTransactions, amount_zkas: amountFc, adopted_ahead: !!ahead });
  const fvkSpan = diagSpan("signer", "op", { op: "fvk" });
  const fvk = await fvkHex(seedHex);
  fvkSpan.end();
  const sentParts: SendPart[] = [];
  const txids: string[] = [];
  let sent = 0n;
  let fees = 0n;
  // The ONE float→integer conversion, at the user-input boundary. From here on
  // every amount is integer sompi — no floating-point coin math on the wire or
  // in the chunk accounting.
  let owed = amountToSompi(amountFc);
  const totalSompi = owed;
  const intent = prepareKey(to, totalSompi, fee, memo, allowMultipleTransactions);
  // Adopt a prepare started at the Confirm screen only for THIS exact payment
  // and only while its session is comfortably inside the daemon's expiry.
  const adopted = ahead && prepareAheadUsable(ahead, to, amountFc, fee, memo, allowMultipleTransactions) ? ahead.promise : null;
  // An adopted prepare's id, not a second fresh one. Drawing a new id here while broadcasting the
  // transaction the early prepare built under ITS id meant that after an unknown outcome the app
  // remembered an id walletd had never seen: the retry prepared a new payment from the wallet's
  // other coins instead of being told "already sent" (e2e 5 Nov: ids cbca93d2… then 01fd9bc1…),
  // so a payment whose answer was lost was paid twice — on the normal Confirm path.
  const { rid, retry } = adopted && ahead ? { rid: ahead.rid, retry: ahead.retry } : requestIdFor(intent);
  // An unknown submit outcome: keep the id against this payment, and against the remainder the
  // app then offers (see rememberUnknownSubmit). `owed` is this transaction's amount.
  const noteUnknown = (chunk: number) => {
    rememberUnknownSubmit(intent, rid);
    if (chunk > 0) rememberUnknownSubmit(prepareKey(to, owed, fee, memo, allowMultipleTransactions), chunkRid(rid, chunk));
  };
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
      stage = "prepare";
      const prepSpan = diagSpan("send", "prepare", { part: chunk + 1 });
      // The memo is sealed into the recipient's encrypted note by the prover; the
      // on-device verification below still checks recipient and amounts, which are
      // what a malicious prover could actually steal with.
      // A normal transfer is all-or-nothing: without partial mode walletd
      // rejects an over-fragmented payment before it builds, signs or broadcasts
      // anything. Multi-transaction delivery is an explicit user choice.
      // The first transaction may already be proving since the Confirm screen
      // opened (`prepareAhead`); a second /prepare for it would only be refused
      // by the daemon's per-wallet guard anyway.
      // A refusal of that early attempt (the wallet was mid-merge when the screen
      // opened, say) is not this payment's answer: ask again, properly staged.
      let prep: PrepareResp | null =
        chunk === 0 && adopted
          ? await awaitShowingIndex(
              adopted,
              (p) => onStage?.("warming", { ...progress(), warmingPct: p.pct, warmingEtaSecs: p.etaSecs }),
              () => onStage?.("proving", progress()),
            ).catch(() => null)
          : null;
      if (!prep) {
        try {
        prep = await prepareWaitingForIndex(
          () => api.prepare(fvk, to, owed, fee, memo, allowMultipleTransactions, chunkRid(rid, chunk)),
          (p) => onStage?.("warming", { ...progress(), warmingPct: p.pct, warmingEtaSecs: p.etaSecs }),
          () => onStage?.("proving", progress()),
          // The wallet's own background merge (or an earlier payment) still proving:
          // wait it out on the same screen rather than bounce back to the form.
          (note, waitedSecs) => onStage?.("warming", { ...progress(), note: waitedSecs >= 5 ? i18n.t("noncustodial.noteWaited", { note, secs: waitedSecs }) : note }),
        );
        } catch (e) {
          // walletd already broadcast this exact payment (a retry after an unknown outcome):
          // record that transaction as this chunk instead of paying again. Only for a reused
          // id, and never for more than this chunk still owes.
          const done = alreadySentOf(e);
          if (!done) throw e;
          const paid = BigInt(done.amount_sompi_exact ?? Math.round(done.amount_sompi));
          const paidFee = BigInt(done.fee_sompi_exact ?? Math.round(done.fee_sompi));
          if (!retry || paid <= 0n || paid > owed || paidFee < 0n) throw new Error(i18n.t("noncustodial.amountChanged"));
          prepSpan.end({ already_sent: true });
          txids.push(done.txid);
          sentParts.push({ txid: done.txid, amount_sompi: Number(paid), fee_sompi: Number(paidFee) });
          sent += paid;
          fees += paidFee;
          owed -= paid;
          if (owed <= 0n) break;
          continue;
        }
      }
      {
        const spends = prep.spend_auth?.length ?? 0;
        spendsTotal += spends;
        const ms = prepSpan.end({ spends, fast_path: prep.fast_path, from_ahead: chunk === 0 && !!adopted });
        proveMsTotal += ms;
      }
      stage = "check";
      // Exact integer figures; the plain-number fields are the fallback for a
      // daemon that predates the *_exact decimal strings.
      const chunkAmount = BigInt(prep.amount_sompi_exact ?? Math.round(prep.amount_sompi));
      const chunkFee = BigInt(prep.fee_sompi_exact ?? Math.round(prep.fee_sompi));
      const remaining = BigInt(prep.remaining_sompi_exact ?? Math.round(prep.remaining_sompi ?? 0));
      // None of these can be negative, and the equation below does NOT catch it.
      //
      // `chunkAmount + remaining === owed` holds just as nicely with remaining = -X and
      // chunkAmount = owed + X. That matters because the figure the device verifies against
      // is the one computed HERE: `verifyAndSignPayment` is handed `chunkAmount` and checks
      // that the bundle pays the user's recipient exactly that, so an inflated chunkAmount
      // is an inflated payment that verifies and signs cleanly. The recipient stays the
      // user's; the amount would not be, and it is bounded only by what the wallet can
      // spend. `remaining <= 0n` then breaks the loop, so it would be one quiet transaction
      // for up to the whole balance.
      //
      // This is the daemon the architecture already refuses to trust — "the guard against a
      // malicious prover" — so its arithmetic gets checked for sign before it is used.
      // A chunk that pays nothing would be signed and sent as a fee-only transaction, and the
      // loop could repeat it up to MAX_CHUNKS times: the service never builds one (a partial
      // chunk needs capacity > 0), and this device does not take its word for it.
      if (chunkAmount <= 0n || chunkFee < 0n || remaining < 0n) {
        throw new Error(i18n.t("noncustodial.amountChanged"));
      }
      // A daemon that pays less than asked must account for every missing sompi
      // in `remaining` — anything else is it silently rewriting the payment.
      if (chunkAmount + remaining !== owed) {
        throw new Error(i18n.t("noncustodial.amountChanged"));
      }
      if (!allowMultipleTransactions && (remaining !== 0n || chunkAmount !== owed)) {
        throw new FragmentedWalletError(
          i18n.t("noncustodial.couldNotPrepareComplete"),
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
          i18n.t("noncustodial.feeAboveLimit", {
            fee: Number(chunkFee) / Number(SOMPI_PER_ZKAS),
            max: Number(maxFee) / Number(SOMPI_PER_ZKAS),
          }),
        );
      }
      onStage?.("signing", progress());
      stage = "sign";
      const signSpan = diagSpan("send", "sign", { part: chunk + 1 });

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

      signSpan.end({ spends: prep.spend_auth?.length ?? 0 });
      onStage?.("broadcasting", progress());
      stage = "submit";
      const submitSpan = diagSpan("send", "submit", { part: chunk + 1 });
      // A submit that never got an answer is NOT a failed send — it is an unknown one.
      // Only this one call broadcasts, so this is the only place the distinction exists.
      // Also unknown: walletd saying so (its node connection failed mid-broadcast), and a reply
      // that is not walletd's — a proxy's 5xx page (nginx giving up on a slow broadcast) or an
      // empty 2xx. Both were reported as a plain failure, so the request id was not kept and a
      // retry built a new payment from other coins while the first may have gone out. A proxy's
      // 4xx (a body it refused, say) never reached walletd and stays a failure.
      let res;
      try {
        res = await api.submit(prep.session, sigs);
        submitSpan.end({ outcome: "accepted" });
      } catch (e) {
        submitSpan.end({ outcome: "failed", err: (e as Error)?.name }, { lvl: "warn" });
        const marked = e as { timedOut?: boolean; unreachable?: boolean; outcomeUnknown?: boolean; notWalletd?: boolean; httpStatus?: number };
        const proxyAnswered = !!marked?.notWalletd && ((marked.httpStatus ?? 0) >= 500 || (marked.httpStatus ?? 0) < 300);
        if (marked?.timedOut || marked?.unreachable || marked?.outcomeUnknown || proxyAnswered) {
          noteUnknown(chunk);
          throw new SubmitUnknownError(i18n.t("send.submitOutcomeUnknown"));
        }
        throw e;
      }
      txids.push(res.txid);
      // Prefer the daemon's EXACT decimal strings, as the prepare path above already
      // does. walletd's SendResp carries them for "clients whose number type cannot
      // represent u64", and this path was reading the JSON number instead: sompi passes
      // 2^53 at ~90 million ZKAS, so past that the amount and fee recorded for a send
      // drift from what was actually paid. The transaction itself is unaffected — it was
      // signed from the bundle — but History and the optimistic balance are rebuilt from
      // these figures, so they are what the owner is shown afterwards.
      const paidAmount = BigInt(res.amount_sompi_exact ?? Math.round(res.amount_sompi));
      const paidFee = BigInt(res.fee_sompi_exact ?? Math.round(res.fee_sompi));
      sentParts.push({ txid: res.txid, amount_sompi: Number(paidAmount), fee_sompi: Number(paidFee) });
      sent += paidAmount;
      fees += paidFee;

      if (remaining <= 0n) break;
      owed = remaining;
      if (chunk === MAX_CHUNKS - 1) {
        throw new Error(
          i18n.t("noncustodial.partialSent", {
            sent: Number(sent) / Number(SOMPI_PER_ZKAS),
            n: txids.length,
            owed: Number(owed) / Number(SOMPI_PER_ZKAS),
          }),
        );
      }
    }
  } catch (e) {
    diagError("send", "error", e, { kind: "noncustodial", stage, parts_sent: sentParts.length });
    // A failure after ≥1 broadcast is NOT a plain failure: those chunks are real
    // money in flight. Hand the caller the parts so it can record them (History +
    // optimistic balance) before showing the error — otherwise the balance keeps
    // showing funds that already left, inviting a double-send.
    if (sentParts.length > 0) throw new PartialSendError((e as Error).message, [...sentParts]);
    if (!allowMultipleTransactions && /needs more than .*input notes|send in smaller chunks/i.test((e as Error).message)) {
      throw new FragmentedWalletError(
        i18n.t("noncustodial.nothingSent"),
      );
    }
    throw e;
  }

  whole.end({ parts: txids.length, spends: spendsTotal, prove_ms_per_spend: spendsTotal ? Math.round(proveMsTotal / spendsTotal) : undefined, fee_sompi: Number(fees) });
  forgetUnknownSubmit(intent);
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
/// Note merging, timed for the diagnostic log as one span (rounds and notes merged).
export async function consolidateNonCustodial(...args: Parameters<typeof consolidateNonCustodialInner>): Promise<ConsolidationResult> {
  const sp = diagSpan("send", "consolidate", { kind: "noncustodial" });
  try {
    const r = await consolidateNonCustodialInner(...args);
    sp.end({ rounds: r.rounds, inputs: r.inputs, tx_count: r.txids.length });
    return r;
  } catch (e) {
    diagError("send", "consolidate_error", e, { kind: "noncustodial" });
    throw e;
  }
}

async function consolidateNonCustodialInner(
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
    throw new Error(i18n.t("noncustodial.notEnoughToConsolidate"));
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
    let prep = await prepareWaitingForIndex(
      () => api.prepare(fvk, ownAddress, requested, undefined, undefined, true),
      () => onStage?.("warming"),
      () => onStage?.("proving"),
    );
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
      throw new Error(i18n.t("noncustodial.unsafeConsolidation"));
    }
    // MERGE needs at least MIN_NOTES_PER_ROUND inputs, or the change note leaves the
    // count unchanged. GROW is the opposite: one input becoming two outputs is exactly
    // what adds a note, so a single-input round is valid — only require that it spends
    // at least one note and actually moves value.
    if (grow) {
      if (prep.spend_auth.length < 1) {
        if (txids.length) break;
        throw new Error(i18n.t("noncustodial.noSpendableToSplit"));
      }
    } else if (prep.spend_auth.length < MIN_NOTES_PER_ROUND) {
      // Not a failure once work is already done — it is the natural end of the
      // loop, and reporting it as an error would hide rounds that succeeded.
      if (txids.length) break;
      throw new Error(i18n.t("noncustodial.fewerThanThree"));
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
