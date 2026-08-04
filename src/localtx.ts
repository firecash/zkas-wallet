// On-device record of sends performed from THIS device, scoped to the wallet
// token. The daemon exposes no per-wallet transaction history, so this powers two
// things purely client-side (nothing here ever leaves the device):
//
//   1. Optimistic balance — subtract a just-sent spend from the displayed balance
//      immediately and keep it reduced across app restarts, until the daemon's own
//      balance reflects the spend (a shielded send takes a block or two to scan).
//   2. A transaction history list.

export type LocalTx = {
  txid: string;
  to: string;
  amountFc: number; // amount sent, excluding fee
  feeFc: number;
  ts: number; // unix ms, when broadcast
  preFc: number; // daemon balance_fc at send time (still includes the spent notes)
  spentFc: number; // amountFc + feeFc — total leaving the wallet
  // Groups the chunks of ONE payment: every chunk shares the payId and the same
  // preFc, so `reconcile` must release their subtractions CUMULATIVELY (see there).
  // Undefined on records from before payIds existed — treated as its own group.
  payId?: string;
  // true until the DAEMON'S balance actually reflects the spend — this is what drives
  // the optimistic subtraction. Cleared ONLY by `reconcile` (daemon balance dropped, or
  // age-out), NEVER by chain confirmations: a shielded spend confirms on-chain in ~1s but
  // the daemon only re-scans it ~3 min later, and clearing the subtraction on the earlier
  // signal made the sent coins REAPPEAR (balance 10 → 6 → 10 → 6). See `confs` for the
  // separate chain-confirmation status used by History.
  pending: boolean;
  confs?: number;   // chain confirmations, for display only — does NOT gate the balance subtraction
  // How many confirmation lookups have come back empty for this row. A txid the
  // chain will never answer for (a send whose transaction was dropped, a record
  // from before a relaunch) used to be retried on EVERY 1-second poll forever —
  // dead rows ate the whole lookup budget and starved the row the user was
  // actually watching. Reset whenever the chain does answer.
  confTries?: number;
};

const MAX = 200;
// A pending spend that the daemon never visibly applies (e.g. funds were received
// in the same window, masking the drop) stops being subtracted after this long, so
// the balance always self-heals to the daemon's truth.
const PENDING_MAX_AGE_MS = 20 * 60 * 1000;
const EPS = 1e-6;

function key(): string {
  return `local_txs_${localStorage.getItem("wallet_token") || "default"}`;
}

export function loadTxs(): LocalTx[] {
  try {
    const v = JSON.parse(localStorage.getItem(key()) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(txs: LocalTx[]) {
  try {
    localStorage.setItem(key(), JSON.stringify(txs.slice(0, MAX)));
  } catch {
    /* quota / private mode — history is best-effort */
  }
}

/** Record a freshly broadcast send. Returns the updated list. */
export function recordSend(t: Omit<LocalTx, "pending">): LocalTx[] {
  const next = [{ ...t, pending: true }, ...loadTxs().filter((x) => x.txid !== t.txid)];
  save(next);
  return next;
}

/**
 * Record what the chain says about a broadcast send — for DISPLAY ONLY (History badge).
 *
 * Chain confirmation must NOT stop the optimistic balance subtraction: a shielded spend
 * confirms on-chain in about a second, but the daemon only re-scans it into the wallet's
 * balance ~3 minutes later (past the reorg margin). Clearing `pending` on the chain signal
 * dropped the subtraction while `balance_fc` still showed the pre-send figure, so the sent
 * coins REAPPEARED (10 → 6 → 10 → 6). The subtraction is now owned solely by `reconcile`,
 * which waits for the daemon's own balance to fall — so here we only record `confs`.
 */
export function applyChainStatus(txid: string, confirmations: number): LocalTx[] {
  let changed = false;
  const txs = loadTxs().map((t) => {
    if (t.txid !== txid) return t;
    if (t.confs !== confirmations || t.confTries) changed = true;
    return { ...t, confs: confirmations, confTries: 0 };
  });
  if (changed) save(txs);
  return txs;
}

/** Count one unanswered confirmation lookup against `txid` (see `confTries`). */
export function bumpConfTry(txid: string): LocalTx[] {
  const txs = loadTxs().map((t) => (t.txid === txid ? { ...t, confTries: (t.confTries ?? 0) + 1 } : t));
  save(txs);
  return txs;
}

// A pending spend that the CHAIN has confirmed keeps its subtraction much longer:
// the money is provably gone on-chain, so expiring it would re-credit spendable
// funds that do not exist (congestion or a daemon rescan can delay the daemon's
// own balance drop well past 20 minutes). It still expires eventually so the
// balance self-heals to the daemon's truth if the drop never becomes visible
// (e.g. masked by funds received in the same window).
const PENDING_CONFIRMED_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Reconciliation that owns the optimistic subtraction. Clears a row when the
 * daemon's own balance has fallen enough to cover it — `preFc` must be a balance
 * the daemon actually knew — and ages out stale pendings so nothing gets stuck.
 *
 * Chunks of one payment share a payId AND the same preFc stamp, so the drop test
 * is CUMULATIVE per payment, oldest chunk first: the observed drop must cover the
 * sum of the chunks up to that row. Testing each row on its own released every
 * chunk's subtraction the moment the FIRST chunk's drop arrived, and the rest
 * popped back into the displayed balance minutes before the daemon accounted for
 * them — spendable money that did not exist.
 */
export function reconcile(daemonFc: number, synced: boolean): LocalTx[] {
  const now = Date.now();
  const txs = loadTxs();
  // Group pending rows by payment (a row without a payId is its own group).
  const groups = new Map<string, LocalTx[]>();
  for (const t of txs) {
    if (!t.pending) continue;
    const g = t.payId ?? t.txid;
    const arr = groups.get(g);
    if (arr) arr.push(t);
    else groups.set(g, [t]);
  }
  const clear = new Set<string>();
  for (const rows of groups.values()) {
    // Oldest first: the daemon's balance reflects chunks in broadcast order.
    rows.sort((a, b) => a.ts - b.ts);
    const preFc = Math.max(...rows.map((r) => r.preFc));
    // preFc <= 0 means the balance was unknown (wallet loading) when these were
    // recorded, so the drop test is meaningless — leave those to the age-out.
    const drop = preFc > 0 && synced ? preFc - daemonFc : 0;
    let cumulative = 0;
    for (const r of rows) {
      cumulative += r.spentFc;
      const dropCovers = drop > 0 && drop >= cumulative - EPS;
      const maxAge = r.confs != null ? PENDING_CONFIRMED_MAX_AGE_MS : PENDING_MAX_AGE_MS;
      if (dropCovers || now - r.ts > maxAge) clear.add(r.txid);
    }
  }
  if (clear.size === 0) return txs;
  const next = txs.map((t) => (t.pending && clear.has(t.txid) ? { ...t, pending: false } : t));
  save(next);
  return next;
}

/** Total still-pending outflow — the amount to subtract from the daemon balance. */
export function pendingTotal(txs: LocalTx[]): number {
  return txs.reduce((s, t) => (t.pending ? s + t.spentFc : s), 0);
}

// ---------------------------------------------------------------------------
// Last-known balance snapshot.
//
// The hosted daemon holds a wallet's scanned state in RAM. When it is not resident
// — after a daemon restart, or when the wallet was evicted — the next request
// triggers a load, and until that load finishes `/api/status` truthfully answers
// `balance 0 / 0 notes / scanned 0 / error "loading…"`. Rendering that verbatim tells
// the user their coins are GONE, which is the single most alarming thing a wallet can
// do and is exactly what it did on 2026-07-13. The daemon is saying "I don't know
// yet", not "you have nothing" — so remember what it last told us and show that,
// clearly marked as stale, until the real number arrives.

export type Snapshot = { balanceFc: number; spendableFc: number; maturingFc: number; noteCount: number; ts: number };

function snapKey(): string {
  return `last_known_${localStorage.getItem("wallet_token") || "default"}`;
}

export function saveSnapshot(s: Snapshot) {
  try {
    localStorage.setItem(snapKey(), JSON.stringify(s));
  } catch {
    /* storage full / disabled — the snapshot is an optimization, never a source of truth */
  }
}

export function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(snapKey());
    if (!raw) return null;
    const s = JSON.parse(raw) as Snapshot;
    return typeof s?.balanceFc === "number" ? s : null;
  } catch {
    return null;
  }
}
