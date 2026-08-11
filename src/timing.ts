// How long the slow operations actually take, remembered so the next one can be
// counted down instead of merely clocked.
//
// Proving a shielded payment takes tens of seconds to minutes, and the wallet has
// only ever shown elapsed time. Elapsed answers "is it moving?" but not the
// question people actually have, which is "how much longer?" — and without an
// answer they close the app. That is not hypothetical: a payment on the hosted
// daemon spent eight minutes in prepare and the app gave up at five.
//
// The estimate is MEASURED, never invented. Nothing is shown until this device has
// completed the same kind of operation at least once, and the prediction is scaled
// by the one variable that dominates the cost: how many notes are being spent
// (~2.4 core-seconds each, so a 38-note payment is not a 2-note payment). A guess
// dressed as a countdown is worse than no countdown — it teaches people the number
// is fiction, and then they ignore the honest ones too.

export type TimedOperation = "prepare" | "consolidate-pass";

/// Samples kept per operation. Enough to shrug off one anomalous run (a cold
/// wallet, a busy daemon) without averaging in results from a machine or a chain
/// height that no longer resembles today's.
const MAX_SAMPLES = 5;

/// Below this a sample says more about clock jitter than about the work.
const MIN_SAMPLE_MS = 250;

/// Never predict from a rate this extreme; a sample that survived a pathological
/// run should not set the expectation for a normal one.
const MAX_MS_PER_NOTE = 120_000;

interface Sample {
  /// Notes spent — the cost driver, so samples of different sizes stay comparable.
  notes: number;
  ms: number;
}

function key(op: TimedOperation, token: string): string {
  return `timing_${op}_${token}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(op: TimedOperation, token: string, store: Storage | null): Sample[] {
  try {
    const raw = store?.getItem(key(op, token));
    const parsed = raw ? (JSON.parse(raw) as Sample[]) : [];
    return Array.isArray(parsed)
      ? parsed.filter((s) => Number.isFinite(s?.ms) && Number.isFinite(s?.notes) && s.ms >= MIN_SAMPLE_MS && s.notes > 0)
      : [];
  } catch {
    return [];
  }
}

/** Remember a completed run. Per wallet, because the cost depends on that wallet's
 * history depth, and per operation, because a consolidation pass and a payment are
 * not the same shape. */
export function recordDuration(
  op: TimedOperation,
  token: string,
  notes: number,
  ms: number,
  store: Storage | null = storage(),
): void {
  if (!(ms >= MIN_SAMPLE_MS) || !(notes > 0)) return;
  try {
    const samples = [...read(op, token, store), { notes, ms }].slice(-MAX_SAMPLES);
    store?.setItem(key(op, token), JSON.stringify(samples));
  } catch {
    // A prediction is a convenience. Losing it must never interrupt a payment.
  }
}

/**
 * Expected duration in ms for `notes`, or `null` when this device has not yet
 * watched one finish.
 *
 * `null` is a real answer and callers must honour it by showing elapsed time
 * instead. The first run of anything is genuinely unpredictable, and saying so is
 * the difference between a countdown people trust and one they learn to ignore.
 *
 * Uses the MEDIAN rate rather than the mean: one pathological run — a cold wallet
 * replaying the chain, a daemon busy proving for somebody else — would otherwise
 * drag every later estimate up with it and never wash out.
 */
export function estimateDuration(
  op: TimedOperation,
  token: string,
  notes: number,
  store: Storage | null = storage(),
): number | null {
  const samples = read(op, token, store);
  if (!samples.length || !(notes > 0)) return null;
  const rates = samples.map((s) => s.ms / s.notes).sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  const rate = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_MS_PER_NOTE) return null;
  return Math.round(rate * notes);
}

/**
 * What to show for a run that is `elapsedMs` in, given an estimate.
 *
 * Overrunning is expected — the estimate is a median, so roughly half of all runs
 * pass it — and it must not produce a countdown that hits zero and sits there, or
 * worse goes negative. Past the estimate the honest thing is to stop predicting and
 * say the work is still going, which is also true.
 */
export function remainingLabel(estimateMs: number | null, elapsedMs: number): string | null {
  if (estimateMs === null) return null;
  const left = Math.round((estimateMs - elapsedMs) / 1000);
  if (left <= 0) return "any moment now";
  if (left < 60) return `about ${left}s left`;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return s >= 10 ? `about ${m}m ${s}s left` : `about ${m}m left`;
}
