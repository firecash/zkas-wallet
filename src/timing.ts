// How long the slow operations actually take, remembered so the next one can be
// counted down instead of merely clocked.
//
// Proving a shielded payment takes seconds to minutes, and the wallet had only ever
// shown elapsed time. Elapsed answers "is it moving?" but not the question people
// actually have, which is "how much longer?" — and without an answer they close the
// app. That is not hypothetical: a payment on the hosted daemon spent eight minutes
// in prepare and the app gave up at five.
//
// The estimate is MEASURED, never invented. Nothing is shown until this device has
// completed the same kind of operation at least once. A guess dressed as a countdown
// is worse than no countdown — it teaches people the number is fiction, and then they
// ignore the honest ones too.
//
// ## Why the first model over-predicted so badly
//
// It fit `ms = rate × notes` from the median ms-per-note. Two things break that:
//
//   1. **The cost is affine, not proportional.** A payment is a fixed cost (queueing
//      for a prover slot, building the bundle, one Halo2 proof) plus a marginal cost
//      per note. Deriving a per-note RATE from a one-note payment folds the entire
//      fixed cost into that rate, and predicting anything larger then multiplies the
//      fixed cost by the note count.
//   2. **A cold wallet and a warm wallet are different operations.** The witness step
//      is milliseconds against a warm subtree cache and MINUTES against a cold one —
//      measured on the hosted daemon the same day: 38.9ms for one note warm, 425.5s
//      for 38 notes cold. Averaging those together describes neither.
//
// Live consequence, reported by a user: a send predicted "about 3 minutes" and
// finished in ~40 seconds. The estimate was carrying a cold sample into a warm run.
//
// So samples now record whether the wallet was warm, estimates are drawn only from
// the matching bucket, and the fit is affine whenever the samples can support one.

export type TimedOperation = "prepare" | "consolidate-pass";

/// Samples kept per operation. Enough to shrug off one anomalous run without
/// averaging in results from a machine or a chain height that no longer resembles
/// today's.
const MAX_SAMPLES = 8;

/// Below this a sample says more about clock jitter than about the work.
const MIN_SAMPLE_MS = 250;

/// Samples older than this describe a wallet, daemon and chain height that no longer
/// exist. Kept generous — someone who pays once a month still deserves a countdown.
const SAMPLE_TTL_MS = 30 * 24 * 60 * 60_000;

/// Never predict from a rate this extreme; a sample that survived a pathological run
/// should not set the expectation for a normal one.
const MAX_MS_PER_NOTE = 120_000;

/// Marginal cost of one additional spent note, used only when the samples cannot
/// support a fitted slope (they are all the same size). Measured: proving is roughly
/// 2.4 core-seconds per note on the hosted daemon. Deliberately a MARGINAL figure —
/// it is added to a real observed duration, never multiplied by the note count.
const MARGINAL_MS_PER_NOTE = 2_400;

/// A prediction may not exceed this multiple of the largest matching sample. Guards
/// the extrapolation when someone's first big payment follows several tiny ones.
const MAX_EXTRAPOLATION = 4;

export interface Sample {
  /// Notes spent — the cost driver, so samples of different sizes stay comparable.
  notes: number;
  ms: number;
  /// Whether the wallet could already spend without a witness rebuild. Absent on
  /// samples recorded before this was tracked; those are treated as unknown and used
  /// only when nothing better exists.
  warm?: boolean;
  /// When it was recorded, for ageing samples out.
  at?: number;
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

function read(op: TimedOperation, token: string, store: Storage | null, now = Date.now()): Sample[] {
  try {
    const raw = store?.getItem(key(op, token));
    const parsed = raw ? (JSON.parse(raw) as Sample[]) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) =>
        Number.isFinite(s?.ms) &&
        Number.isFinite(s?.notes) &&
        s.ms >= MIN_SAMPLE_MS &&
        s.notes > 0 &&
        (s.at === undefined || now - s.at <= SAMPLE_TTL_MS),
    );
  } catch {
    return [];
  }
}

/** Remember a completed run. Per wallet, because the cost depends on that wallet's
 * history depth, and per operation, because a consolidation pass and a payment are
 * not the same shape.
 *
 * `warm` is the wallet's spend-readiness at the moment the run STARTED — the thing
 * that decides whether the witness step costs milliseconds or minutes. Recording it
 * is what keeps a cold run from setting the expectation for a warm one. */
export function recordDuration(
  op: TimedOperation,
  token: string,
  notes: number,
  ms: number,
  warm?: boolean,
  store: Storage | null = storage(),
): void {
  if (!(ms >= MIN_SAMPLE_MS) || !(notes > 0)) return;
  try {
    const samples = [...read(op, token, store), { notes, ms, warm, at: Date.now() }].slice(-MAX_SAMPLES);
    store?.setItem(key(op, token), JSON.stringify(samples));
  } catch {
    // A prediction is a convenience. Losing it must never interrupt a payment.
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Least-squares `ms = intercept + slope × notes`, or `null` when the samples are all
 * the same size (no slope is observable) or the fit is degenerate.
 *
 * A negative slope or intercept is not "the payment gets faster with more notes" — it
 * is noise in a handful of samples — so a fit that implies either is refused rather
 * than clamped into a shape the data does not support.
 */
function affineFit(samples: Sample[]): { intercept: number; slope: number } | null {
  if (samples.length < 2) return null;
  const n = samples.length;
  const meanX = samples.reduce((s, r) => s + r.notes, 0) / n;
  const meanY = samples.reduce((s, r) => s + r.ms, 0) / n;
  const varX = samples.reduce((s, r) => s + (r.notes - meanX) ** 2, 0);
  if (varX <= 0) return null; // every sample the same size
  const cov = samples.reduce((s, r) => s + (r.notes - meanX) * (r.ms - meanY), 0);
  const slope = cov / varX;
  const intercept = meanY - slope * meanX;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept) || slope < 0 || intercept < 0) return null;
  return { intercept, slope };
}

/**
 * Expected duration in ms for `notes`, or `null` when this device cannot honestly
 * predict one.
 *
 * `null` is a real answer and callers must honour it by showing elapsed time instead.
 * It is returned not only for a first run but also when the only samples available
 * describe a *different* kind of run — predicting a warm payment from cold samples is
 * exactly the over-promise that produced "about 3 minutes" for a 40-second send.
 */
export function estimateDuration(
  op: TimedOperation,
  token: string,
  notes: number,
  warm?: boolean,
  store: Storage | null = storage(),
): number | null {
  const all = read(op, token, store);
  if (!all.length || !(notes > 0)) return null;

  // Prefer samples from the same regime. A sample with no recorded warmth predates
  // the distinction; it is usable, but never in place of a matching one.
  const matching = warm === undefined ? all : all.filter((s) => s.warm === warm);
  const usable = matching.length ? matching : all.filter((s) => s.warm === undefined);
  if (!usable.length) {
    // Only opposite-regime samples exist. Silence beats a number we know is wrong.
    return null;
  }

  const fit = affineFit(usable);
  const raw = fit ? fit.intercept + fit.slope * notes : predictFromSameSized(usable, notes);
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;

  // However it was derived, refuse to extrapolate far beyond anything observed.
  const largest = Math.max(...usable.map((s) => s.ms));
  const capped = Math.min(raw, largest * MAX_EXTRAPOLATION);
  if (capped / notes > MAX_MS_PER_NOTE) return null;
  return Math.round(capped);
}

/// Samples that are all one size cannot yield a slope, so the observed duration is
/// taken as-is and only the DIFFERENCE in note count is priced. This is the step the
/// old model got wrong: it divided by the note count and multiplied back up, turning
/// a one-note payment's fixed cost into a per-note rate.
function predictFromSameSized(samples: Sample[], notes: number): number | null {
  const base = median(samples.map((s) => s.ms));
  const baseNotes = median(samples.map((s) => s.notes));
  if (!Number.isFinite(base) || !Number.isFinite(baseNotes)) return null;
  return Math.max(MIN_SAMPLE_MS, base + MARGINAL_MS_PER_NOTE * (notes - baseNotes));
}

/**
 * What to show for a run that is `elapsedMs` in, given an estimate.
 *
 * Overrunning is expected — the estimate is a central tendency, so roughly half of
 * all runs pass it — and it must not produce a countdown that hits zero and sits
 * there, or worse goes negative. Past the estimate the honest thing is to stop
 * predicting and say the work is still going, which is also true.
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
