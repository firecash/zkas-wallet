// One chronological history out of three sources that record time differently.
//
// History is assembled from three places, and they used to be rendered as three
// CONCATENATED blocks — every inferred arrival, then every device-recorded send, then
// every chain row. Each block was sorted internally and none was sorted against the
// others, so the list was not in time order at all:
//
//     Received +1.81 ZKAS   Seen arriving · 12/08/2026, 12:23:25
//     Received +2.84 ZKAS   Seen arriving · 12/08/2026, 12:12:22
//     − 1 ZKAS  CONFIRMED   to zkas:py82h42m9qj…  12 Aug, 12:19
//
// The 12:19 send belongs between the two arrivals. A newer payment appearing below an
// older one makes people think a payment is missing, and they are right to: a list that
// claims to be history has to be in order.
//
// The three sources:
//
//   * `Receipt`  — an arrival INFERRED from the balance moving. Knows the amount and
//     when this device noticed, and nothing else: no txid, and no sender, which is
//     unknowable for a shielded payment. Only used when chain history is off; with it on
//     the chain reports receives itself and these would double up.
//   * `LocalTx`  — a send this device made and recorded itself. Has a txid and the
//     broadcast time. Readable with chain history off, because it never left the device.
//   * `ChainHistoryRow` — recovered from the chain. Authoritative, but its `timestamp` is
//     0 when the scanning node predated block metadata.

export type HistoryKindFilter = "all" | "received" | "sent" | "coinbase";

/** A row's place in the timeline, with the "we genuinely don't know" case kept separate. */
export interface Timed {
  /** Milliseconds, or 0 when this row has no usable time. */
  ts: number;
  /** Chain position, used to order rows whose `ts` is unknown. */
  daaScore?: number;
}

/**
 * Newest first, with rows of unknown time kept together at the END rather than sorted
 * as if they happened in 1970.
 *
 * A chain row with `timestamp: 0` has no time — the node that scanned it served no block
 * metadata. Treating that 0 as a date buries genuine history at the bottom of the list
 * under a 1970 timestamp, which is worse than admitting the gap: among themselves those
 * rows still have a real order, their `daaScore`, so they stay internally chronological.
 */
export function byNewest<T extends Timed>(rows: T[]): T[] {
  const known = rows.filter((r) => r.ts > 0).sort((a, b) => b.ts - a.ts);
  const undated = rows.filter((r) => !(r.ts > 0)).sort((a, b) => (b.daaScore ?? 0) - (a.daaScore ?? 0));
  return [...known, ...undated];
}

/**
 * Does this chain row already describe the arrival a `Receipt` inferred?
 *
 * A receipt has no txid, so it cannot be matched by identity — only by "same amount,
 * around the same time". The device notices an arrival on its next poll, which is after
 * the block, so the receipt's time is LATER than the chain row's, never earlier. The
 * window is generous because polling, background sync and app-open detection can all lag
 * by minutes; a false match hides a duplicate, a missed match shows the same payment
 * twice, and of the two the duplicate is the one users report as "my history is wrong".
 */
export function receiptIsOnChain(receipt: { amountFc: number; ts: number }, chain: { kind: string; amountZkas: number; timestamp: number }[], windowMs = 30 * 60_000): boolean {
  return chain.some(
    (row) =>
      row.kind === "received" &&
      Math.abs(row.amountZkas - receipt.amountFc) < 1e-8 &&
      row.timestamp > 0 &&
      receipt.ts >= row.timestamp - 60_000 &&
      receipt.ts - row.timestamp <= windowMs,
  );
}
