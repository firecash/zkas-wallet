/// Is a typed scan birthday ahead of the chain tip?
///
/// A wallet's birthday is the height its scan starts from. The date-based path in the restore
/// dialog is bounded at both ends — floored at 0, and a date in the future falls through to 0
/// — but the typed EXACT HEIGHT had no bound at all, on either side: walletd does not check it
/// against the tip either.
///
/// A height past the tip starts the scan after every block that could hold this wallet's
/// notes, so it finds nothing and the restored wallet reports an empty balance. That is the
/// worst reading this app can give, and it is one mistyped digit away.
///
/// Returns the TIP when the typed value is ahead of it (so the caller can name it), and null
/// when there is nothing to complain about — including when the tip is unknown, because a
/// restore can run before any status has arrived and "cannot check" must not become "refuse".
export function birthdayAheadOfTip(typed: string, tip: number | null): number | null {
  const t = typed.trim();
  if (!t || tip === null || !(tip > 0)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > tip ? tip : null;
}

/// A chain point the DAA score is anchored to: DAA 757,000 was 2026-08-04 08:48:22 UTC
/// (the NU1 fork block), and mainnet advances one DAA per second. Measured since: the real
/// tip runs ~0.04% AHEAD of this estimate, so the estimate errs early — the safe side.
const ANCHOR_DAA = 757_000;
const ANCHOR_MS = Date.UTC(2026, 7, 4, 8, 48, 22);
/// Extra slack when the tip is only estimated, so a chain that ever ran slower than one DAA a
/// second still never puts a birthday after the wallet's first block.
const ESTIMATE_SLACK_SECS = 86_400;
/// Every date-derived birthday starts this much earlier than the date says (time zones, a
/// date remembered a day late).
const DATE_SLACK_SECS = 2 * 86_400;

/// The tip DAA score the wall clock implies.
export function estimatedTipDaa(nowMs: number = Date.now()): number {
  return Math.max(0, Math.floor(ANCHOR_DAA + (nowMs - ANCHOR_MS) / 1000));
}

/// The scan birthday for a wallet created on `createdDate` (YYYY-MM-DD, local midnight).
///
/// `tip` is the chain tip when known. When it is not — the on-phone engine has not reached its
/// node yet, so status reads 0 — this used to return 0, which the daemon reads as "scan from
/// genesis": a user who picked "created 30 days ago" got a full-chain scan of millions of
/// blocks. The tip is then estimated from the clock instead (with extra slack). Returns 0 only
/// for a missing or future date.
export function birthdayFromDate(createdDate: string, tip: number, nowMs: number = Date.now()): number {
  if (!createdDate) return 0;
  const created = new Date(createdDate + "T00:00:00").getTime();
  if (!Number.isFinite(created)) return 0;
  const ageSec = Math.floor((nowMs - created) / 1000);
  if (!(ageSec > 0)) return 0;
  const at = tip > 0 ? tip : estimatedTipDaa(nowMs) - ESTIMATE_SLACK_SECS;
  return Math.max(0, Math.floor(at - ageSec - DATE_SLACK_SECS));
}
