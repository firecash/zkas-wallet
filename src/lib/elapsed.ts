/// How long ago a stored timestamp was, with a clock that may have moved.
///
/// `Date.now() - stored` goes NEGATIVE whenever the clock steps backwards — an NTP
/// correction, a user fixing their timezone the wrong way, a laptop waking with a stale
/// RTC — and every decision in this app phrased as `elapsed > limit` or `elapsed < limit`
/// then sticks on the wrong answer for as long as the skew lasts. Three of them mattered:
///
///   - the app lock's grace period: `now - hiddenAt >= GRACE` never became true, so the
///     wallet NEVER AUTO-LOCKED again;
///   - the pending-spend age-out: `now - ts > maxAge` never became true, so a subtraction
///     that exists to self-heal back to the daemon's balance never released, leaving the
///     balance permanently understated;
///   - the price cache: `now - asOf < FRESH` stayed true, so the figure under the balance
///     never refreshed.
///
/// A timestamp in the future means the clock moved, which makes the duration unknowable —
/// so this reports it as unbounded rather than as a small or negative number. Every caller
/// above then lands on its safe side: lock, release the subtraction, refetch the price.
/// None of them is harmed by treating "I cannot tell" as "a long time ago"; all three were
/// harmed by treating it as "no time at all".
export function elapsedSince(ts: number, now = Date.now()): number {
  if (!Number.isFinite(ts) || ts <= 0) return Number.POSITIVE_INFINITY;
  const d = now - ts;
  // A tiny negative is ordinary jitter between two Date.now() reads on some platforms and
  // should not trip an age-out; a real step backwards is seconds or more.
  if (d < -1_000) return Number.POSITIVE_INFINITY;
  return Math.max(0, d);
}
