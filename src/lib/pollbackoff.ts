import { elapsedSince } from "./elapsed";

/// Should this status poll be skipped because the service keeps failing?
///
/// The daemon's own supervisor backs off when a restart fails immediately — "one that dies
/// instantly is a bad binary or bad flags, and hammering it helps nobody". The client had no
/// such rule: the status poll runs at 1 Hz and kept running at 1 Hz however long the service
/// had been unreachable. With nginx answering 502 while walletd restarts, every request fails
/// FAST, so the in-flight guard that throttles a slow daemon does nothing — each open client
/// sends a request per second, at exactly the moment the service can least afford it.
///
/// The threshold is deliberately high. `flipAt` is 5, 12, 60 or 120 consecutive failures, and
/// those numbers are SECONDS only because the poll is 1 Hz — so slowing the poll any earlier
/// would stretch "tell the user after 5 seconds" into minutes. Backing off only past the
/// longest of them leaves every user-visible timing untouched: by then the app has already
/// said it cannot reach the service, and a client failing for two minutes will not be rescued
/// by another sub-second retry.
///
/// Nothing needs to clear this: `failedPolls` is reset on success and by the resume handler,
/// so returning to a backgrounded app polls at once.
const BACKOFF_AFTER_FAILURES = 120;
const BACKOFF_EVERY_MS = 15_000;

export function skipPollWhileFailing(failures: number, lastAttemptMs: number, now = Date.now()): boolean {
  if (failures < BACKOFF_AFTER_FAILURES) return false;
  // elapsedSince: a backward clock step makes this negative, which is less than the interval,
  // so the poll would be skipped on every tick and the status screen would stop updating
  // altogether for as long as the skew lasted.
  return elapsedSince(lastAttemptMs, now) < BACKOFF_EVERY_MS;
}
