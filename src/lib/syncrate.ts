/// How fast is this wallet actually catching up, and when will it arrive?
///
/// `/api/status` answers "where am I" (`scanned_blocks`) and "where is the chain"
/// (`daa_score`), but never "am I moving". That difference is the whole question a user has
/// while a wallet sits behind: a wallet 20,000 blocks back and closing at 300 blocks/s is
/// fine and will be done in a minute, and a wallet 200 blocks back that has not moved in five
/// minutes is broken. The two look identical in the UI today, which is why the debug view was
/// useless against a hosted daemon — it showed the on-device engine's log, and a desktop or
/// web user talking to a remote daemon has no on-device engine at all.
///
/// So this keeps a short history of readings and derives the rate from it. Nothing here asks
/// the daemon for anything new; it is the same status poll the app already runs.
///
/// Deliberately NOT a running average of per-poll deltas: polls are irregular (the app backs
/// off when hidden), and one long gap would dominate. The rate is computed over the whole
/// window, oldest to newest, which is what "blocks per second over the last minute" means.

import { elapsedSince } from "./elapsed";

/// One reading. `tip` is the chain's height as the DAEMON sees it, not as the node does — if
/// the daemon's own view of the tip is stale, that is itself the bug, and recording the
/// daemon's number is what makes it visible.
export interface SyncSample {
  /// `Date.now()` when the reading arrived.
  at: number;
  scanned: number;
  tip: number;
}

/// Blocks walletd deliberately holds back from the tip: it never appends a block to the
/// wallet's (append-only) tree until it is `SYNC_TIP_MARGIN` = 200 blue score below the
/// sink, so a routine reorg cannot corrupt it. Payments inside that window are not lost —
/// walletd trial-decrypts them as a 0-conf "preview" and they show as pending within a
/// second of being mined. Mirrors zkas-walletd's `SYNC_TIP_MARGIN`.
export const SETTLE_MARGIN = 200;
/// On top of the margin: `scanned` and the tip are DAA scores while the margin is blue
/// score (DAA runs ahead of blue on a DAG), and a caught-up wallet ingests in passes, not
/// per block. Measured on a real device on 2026-10-22: a caught-up wallet rested 203-254
/// DAA behind. Lag inside margin + slack is the design, not a delay.
export const TIP_SLACK = 64;

export interface SyncRate {
  /// `tip - scanned`, floored at 0. Includes the settlement margin, so a caught-up wallet
  /// reads ~200-260 here; see `lag` for how far it is from where it should be.
  behind: number;
  /// Blocks behind beyond the settlement margin and slack: real catching up still to do.
  /// 0 for a wallet that is as current as walletd will ever make it.
  lag: number;
  /// Blocks per second across the window, or `null` until there are two usable samples.
  blocksPerSec: number | null;
  /// Seconds until `lag` reaches 0 at the current rate, or `null` when unknowable —
  /// no rate yet, not moving, or already caught up.
  etaSecs: number | null;
  /// Seconds spanned by the samples the rate was computed from.
  windowSecs: number;
  samples: number;
  /// Moving measurably backwards or not at all, over a window long enough to mean it.
  /// This is the state worth shouting about: it is what "stuck" looks like.
  stalled: boolean;
}

/// Readings kept. At the app's ~1s synced poll this is a couple of minutes of history, and at
/// the hidden-tab backoff it is much longer — which is fine, because the rate is computed from
/// the window's real span rather than from a sample count.
const MAX_SAMPLES = 120;

/// Below this the window is too short to call anything, including a stall: a wallet that has
/// not moved for three seconds is not stuck, it is between blocks.
const MIN_WINDOW_SECS = 20;

const samples: SyncSample[] = [];
/// The daemon the samples describe; see `recordSyncSample`.
let lastBase = "";

/// Record a reading. Call it wherever status arrives; it is cheap and allocation-free.
///
/// Two readings are REFUSED rather than averaged in:
///
///   * a `scanned` that went BACKWARDS. The daemon restarted, or the wallet was reloaded from
///     an older checkpoint, or it was evicted and re-opened. The history before that describes
///     a different run, and blending them reports a negative rate — so the history is dropped
///     and measurement starts again from here.
///   * a reading whose clock is unusable (`elapsedSince` answers `Infinity` for a timestamp in
///     the future). Keeping it would put a bogus span in the window.
export function recordSyncSample(scanned: number, tip: number, base = "", now = Date.now()): void {
  if (!Number.isFinite(scanned) || !Number.isFinite(tip) || scanned < 0) return;
  // A change of daemon invalidates everything measured so far: progress against one service
  // says nothing about another, and carrying it across would report a bogus rate or a stall
  // that is really just a different starting point. The module owns this rather than asking
  // every caller to remember it.
  if (base !== lastBase) {
    lastBase = base;
    samples.length = 0;
  }
  const last = samples[samples.length - 1];
  if (last && scanned < last.scanned) {
    samples.length = 0;
  }
  samples.push({ at: now, scanned, tip });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

/// Forget the history — used when the daemon the app talks to changes, because progress
/// against one daemon says nothing about another.
export function resetSyncSamples(): void {
  samples.length = 0;
  lastBase = "";
}

export function syncRate(now = Date.now()): SyncRate {
  const newest = samples[samples.length - 1];
  const behind = newest ? Math.max(0, newest.tip - newest.scanned) : 0;
  const lag = lagOf(behind);
  const base: SyncRate = {
    behind,
    lag,
    blocksPerSec: null,
    etaSecs: null,
    windowSecs: 0,
    samples: samples.length,
    stalled: false,
  };
  if (!newest || samples.length < 2) return base;

  // Oldest sample whose age is still measurable. `elapsedSince` protects the span from a
  // clock that stepped backwards — it answers Infinity, and an infinite span would read as a
  // rate of zero and so as a false stall.
  const oldest = samples[0];
  const spanMs = newest.at - oldest.at;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return base;
  const windowSecs = spanMs / 1000;
  const advanced = newest.scanned - oldest.scanned;
  const blocksPerSec = advanced / windowSecs;

  // "Not moving" is only meaningful over a long enough window, and only while there is
  // something left to do: a caught-up wallet advances at the chain's own rate and dips to zero
  // between blocks, which is not a stall.
  //
  // Measured against `lag`, not `behind`: a wallet resting at the settlement margin does
  // not move between ingest passes, and a fresh wallet sits at its birthday until 200
  // blocks have settled past it (~4 minutes). Both read as "STALLED" when the margin was
  // counted as work left (seen on a real device, 2026-10-22).
  const stalled = windowSecs >= MIN_WINDOW_SECS && advanced <= 0 && lag > 0;

  // ETA needs real forward progress. A rate at or below zero gives no arrival time, and
  // saying "0s" or "-4s" would be worse than saying nothing. The destination is the
  // settled point, not the tip walletd never ingests.
  const etaSecs = lag > 0 && blocksPerSec > 0 ? lag / blocksPerSec : null;

  return { behind, lag, blocksPerSec, etaSecs, windowSecs, samples: samples.length, stalled };
}

/// Blocks behind beyond what walletd holds back by design.
export function lagOf(behind: number): number {
  return Math.max(0, behind - SETTLE_MARGIN - TIP_SLACK);
}

/// `1,234` — thousands separated, because these are six- and seven-digit block heights and
/// an unseparated one cannot be read at a glance.
export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/// A duration a person can act on: `45s`, `12m 30s`, `3h 05m`. Returns `—` for null so every
/// caller does not need its own fallback.
export function fmtDuration(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs) || secs < 0) return "—";
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/// Blocks per second at a useful precision: `312 blk/s` reads better than `312.4176`, and
/// below 10 the fraction is the whole story (`0.4 blk/s` vs `0 blk/s`).
export function fmtRate(blocksPerSec: number | null): string {
  if (blocksPerSec === null || !Number.isFinite(blocksPerSec)) return "—";
  if (blocksPerSec <= 0) return "0 blk/s";
  if (blocksPerSec < 10) return `${blocksPerSec.toFixed(1)} blk/s`;
  return `${Math.round(blocksPerSec)} blk/s`;
}
