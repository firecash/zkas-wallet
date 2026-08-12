// Deciding whether the balance going UP means somebody paid you.
//
// The wallet has no way to be *told* about an incoming shielded payment — that is the
// point of the pool — so an arrival is INFERRED from the balance rising between two
// fully-synced readings. That inference has a blind spot, and users hit it:
//
//   * You send a payment. Your notes are spent and the CHANGE comes back to you as a
//     new note. Once it settles the balance rises.
//   * The app subtracts a spend optimistically the moment it is broadcast; the daemon
//     re-scans and agrees a few minutes later. Between those two moments the balance can
//     move up as the optimistic subtraction is released.
//
// Both look exactly like an incoming payment to a delta detector. Reported live: a
// notification "+100 ZKAS arriving — confirmed, settling into your wallet" that was the
// change from the user's own send, arriving ~10 minutes after it — and History rows
// reading "RECEIVED · Noticed when you opened the app" for the same non-event.
//
// Telling someone they were paid when they were not is worse than saying nothing. It is
// unverifiable — there is no txid to check, because there was no payment — and once a
// wallet has cried wolf, the announcements that matter get ignored too.
//
// So: a rise is only called an arrival when this device cannot explain it. While any
// payment of ours is still settling, we can explain it, and we stay quiet. This costs a
// genuine payment that lands in that window its announcement — it still appears in the
// balance and, with chain history on, in History. Silence about a real payment is
// recoverable; a fictional one is not.

/// What a settling payment looks like from here. A subset of `LocalTx`, so this stays
/// testable without constructing whole transactions.
export interface OutgoingRecord {
  /// When it was broadcast.
  ts: number;
  /// True until the DAEMON's balance reflects the spend.
  pending: boolean;
}

/**
 * How long after one of our own payments a balance rise stays unattributable.
 *
 * The change note from a spend has to mature past the shielded anchor (~630 blocks,
 * about 10.5 minutes at one block per second) before the wallet counts it as spendable,
 * and the daemon re-scans our spend on its own schedule. Both are why the false
 * "received" landed roughly ten minutes after the send. The window covers that with
 * room to spare; being slightly too quiet is the safe direction.
 */
export const SETTLING_WINDOW_MS = 20 * 60_000;

/**
 * Can this device explain a balance increase by its own outgoing activity?
 *
 * True while any recorded send is still pending, or finished recently enough that its
 * change could still be landing.
 */
export function ownActivityExplainsRise(sends: OutgoingRecord[], now = Date.now(), windowMs = SETTLING_WINDOW_MS): boolean {
  return sends.some((s) => s.pending || now - s.ts <= windowMs);
}

/**
 * The amount to announce as received, or `null` for "do not announce".
 *
 * `prev === null` is the first fully-synced reading this device has ever taken: it is a
 * baseline, not a windfall, or opening the app would announce the entire balance.
 */
export function arrivalAmount(
  prev: number | null,
  next: number,
  isFinal: boolean,
  sends: OutgoingRecord[] = [],
  now = Date.now(),
): number | null {
  if (!isFinal) return null;
  if (prev === null) return null;
  const delta = next - prev;
  // One sompi is 1e-8 ZKAS; below that is float noise, not a payment.
  if (!(delta > 1e-8)) return null;
  // Attributable to us — see the header. Not an arrival, whatever the balance did.
  if (ownActivityExplainsRise(sends, now)) return null;
  return delta;
}

/**
 * Until when the native background worker should stay silent about balance increases.
 *
 * The worker runs its own delta check against its own stored baseline and cannot read
 * the app's list of sends, so the app hands it a deadline instead. Returns 0 when
 * nothing is settling, which clears any previous hold.
 */
export function quietUntil(sends: OutgoingRecord[], now = Date.now(), windowMs = SETTLING_WINDOW_MS): number {
  const deadlines = sends.filter((s) => s.pending || now - s.ts <= windowMs).map((s) => (s.pending ? now + windowMs : s.ts + windowMs));
  return deadlines.length ? Math.max(...deadlines) : 0;
}
