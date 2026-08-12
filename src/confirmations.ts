// Showing confirmations as they actually accrue, rather than in bursts.
//
// The chain produces roughly one block a second; the app asks the explorer for a
// transaction's confirmation count every few seconds. So the number sat still and then
// leapt — 0, then 4, then 12 — which reads as the wallet being asleep and waking up,
// and makes a payment that is settling perfectly normally look erratic.
//
// Nothing is wrong with the polling: asking once a second per pending payment would be
// wasteful and the explorer would rate-limit it. What is wrong is treating a value that
// changes CONTINUOUSLY as if it only exists at the instants we sample it. Between polls
// the count is not unknown — it is the last known count plus the blocks that have been
// produced since, and the block rate is a known property of the chain.
//
// So the display ticks locally between answers and snaps to the truth whenever one
// arrives. Two rules keep that honest:
//
//   * It runs SLOW. Ticking at a shade under one block per second means the local guess
//     tends to lag reality and get corrected upward, rather than running ahead and
//     having to be corrected down.
//   * It never goes backwards. A counter that retreats looks like a payment losing
//     confirmations — the one thing that genuinely alarms people about a transaction —
//     so a server answer below what is already displayed holds the display instead.

/// Assumed spacing between blocks for the local tick. Deliberately above the chain's
/// ~1000ms so the interpolation under-counts and is corrected upward.
const LOCAL_BLOCK_MS = 1_150;

/// How far the local tick may run past the last server answer before it stops. Beyond
/// this the poll interval has certainly elapsed, so continuing to invent confirmations
/// would mean the poll is failing — and inventing them would hide that.
const MAX_LOCAL_ADVANCE = 45;

export interface ConfirmationTick {
  /// Confirmations the server last reported, or null if it has never answered.
  serverConfs: number | null;
  /// When that answer arrived (ms since epoch).
  serverAt: number;
  /// What is on screen now, so the count can be kept monotonic.
  lastShown?: number | null;
  now?: number;
}

/**
 * The confirmation count to display: the last server answer, advanced by the blocks
 * that have plausibly been produced since it arrived.
 *
 * Returns `null` only when the server has never answered — "not seen on chain yet" is a
 * different statement from "zero confirmations" and the caller renders it differently.
 */
export function tickedConfirmations({ serverConfs, serverAt, lastShown, now = Date.now() }: ConfirmationTick): number | null {
  if (serverConfs === null || !Number.isFinite(serverConfs)) {
    // No answer yet. Anything already shown stays — a payment does not un-confirm
    // because one poll timed out.
    return lastShown ?? null;
  }
  const elapsed = Math.max(0, now - serverAt);
  const localAdvance = Math.min(MAX_LOCAL_ADVANCE, Math.floor(elapsed / LOCAL_BLOCK_MS));
  const ticked = serverConfs + (serverConfs > 0 ? localAdvance : 0);
  // A transaction with 0 confirmations is not "about to have 3": it has not been mined.
  // Only a mined payment accrues blocks, which is why the advance is gated above.
  return Math.max(ticked, lastShown ?? 0);
}

/**
 * How a confirmation count should read.
 *
 * Past `settledAt` a precise number is noise — nobody needs to know a month-old payment
 * has 2.6 million confirmations — so it settles to a word.
 */
export function confirmationLabel(confs: number | null, ageMs: number, settledAt = 10 * 60_000): string | null {
  if (confs === null) return null;
  if (confs <= 0) return null;
  if (ageMs > settledAt) return "confirmed";
  return `${confs} conf${confs === 1 ? "" : "s"}`;
}
