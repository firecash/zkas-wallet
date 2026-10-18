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
