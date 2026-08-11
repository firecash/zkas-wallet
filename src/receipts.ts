// On-device record of money ARRIVING, and the balance baseline that lets the app
// notice an arrival at all.
//
// The wallet already announced incoming payments — but only ones that landed while
// the app was open, and it never wrote them down. Two consequences, both of which
// users hit:
//
//   1. The baseline lived in a `useRef`, so it was `null` on every app start, and
//      the first reading after opening is deliberately treated as a baseline rather
//      than a gain (otherwise opening the app announces your whole balance). An
//      arrival that happened while the app was CLOSED therefore vanished — which is
//      exactly the case the Android background worker exists to catch. The worker
//      notifies natively from a balance delta it computes itself, so the phone said
//      "+11 ZKAS arrived" and the app, opened seconds later, knew nothing about it.
//   2. With chain history off, History holds only sends made from this device.
//      Receives had nowhere to be recorded even in principle, so a notification
//      could never be corroborated inside the app.
//
// A notification you cannot verify is worse than no notification: it teaches people
// to distrust the wallet at the exact moment it is telling the truth.
//
// What is recorded is deliberately modest. An arrival is INFERRED from the balance
// moving, so this knows the amount and the time and nothing else — no txid, and no
// sender, which is unknowable for a shielded payment by design. The UI must say so
// rather than dress these up as chain records.

export interface Receipt {
  /// ZKAS that arrived, as the balance delta that revealed it.
  amountFc: number;
  /// When this device noticed — not necessarily when it landed on-chain.
  ts: number;
  /// True when the arrival happened while the app was closed and was found by
  /// comparing against the stored baseline on the next open. Worth distinguishing:
  /// "noticed on opening" is a different claim from "watched it arrive".
  whileAway: boolean;
}

const MAX = 200;

function token(): string {
  return localStorage.getItem("wallet_token") || "default";
}

function receiptsKey(): string {
  return `local_receipts_${token()}`;
}

function baselineKey(): string {
  return `last_final_balance_${token()}`;
}

export function loadReceipts(): Receipt[] {
  try {
    const raw = JSON.parse(localStorage.getItem(receiptsKey()) || "[]");
    return Array.isArray(raw) ? (raw as Receipt[]).filter((r) => Number.isFinite(r?.amountFc) && Number.isFinite(r?.ts)) : [];
  } catch {
    return [];
  }
}

export function recordArrival(amountFc: number, whileAway: boolean, ts = Date.now()): Receipt[] {
  if (!(amountFc > 0)) return loadReceipts();
  const next = [{ amountFc, ts, whileAway }, ...loadReceipts()].slice(0, MAX);
  try {
    localStorage.setItem(receiptsKey(), JSON.stringify(next));
  } catch {
    // Quota or private mode. The balance is still correct; only the note about how
    // it got there is lost, so this must never throw into the poll.
  }
  return next;
}

/**
 * The last fully-synced balance this device saw, or `null` if it has never seen one.
 *
 * Persisted, unlike the ref it replaces. That is the whole point: a baseline that
 * resets on every launch cannot detect anything that happened between launches, and
 * "between launches" is precisely when background sync is doing its job.
 */
export function loadBaseline(): number | null {
  const raw = localStorage.getItem(baselineKey());
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function saveBaseline(balanceFc: number): void {
  if (!Number.isFinite(balanceFc)) return;
  try {
    localStorage.setItem(baselineKey(), String(balanceFc));
  } catch {
    /* best-effort; a lost baseline costs one missed announcement, never money */
  }
}

/// Clear both when a wallet is forgotten, so a new wallet under the same token
/// cannot inherit another's balance history.
export function forgetReceipts(forToken: string): void {
  try {
    localStorage.removeItem(`local_receipts_${forToken}`);
    localStorage.removeItem(`last_final_balance_${forToken}`);
  } catch {
    /* nothing recoverable to do */
  }
}
