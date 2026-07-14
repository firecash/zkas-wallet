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
  pending: boolean; // true until the chain confirms it (see reconcile)
  confs?: number;   // confirmations reported by the chain, once known
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
 * Record what the chain says about a broadcast send.
 *
 * This is the authority. The previous rule inferred "the send went through" from the
 * daemon's balance falling to `preFc - spentFc` — but `preFc` was whatever the daemon
 * reported at the moment of sending, and if the wallet happened to be loading then, that
 * was 0. The test became `balance <= -spentFc`, which is never true, so a fully
 * confirmed transaction stayed on screen as "1 unconfirmed send (0-conf)" forever AND
 * kept its amount subtracted from the displayed balance. A transaction's status is a
 * fact about the chain, so ask the chain.
 */
export function applyChainStatus(txid: string, confirmations: number): LocalTx[] {
  let changed = false;
  const txs = loadTxs().map((t) => {
    if (t.txid !== txid) return t;
    const pending = confirmations < 1;
    if (t.pending !== pending || t.confs !== confirmations) changed = true;
    return { ...t, pending, confs: confirmations };
  });
  if (changed) save(txs);
  return txs;
}

/**
 * Fallback reconciliation for sends the chain hasn't answered about (yet). Still clears
 * on the balance drop when that signal is trustworthy — `preFc` must be a balance the
 * daemon actually knew — and ages out stale pendings so nothing can get stuck forever.
 */
export function reconcile(daemonFc: number, synced: boolean): LocalTx[] {
  const now = Date.now();
  let changed = false;
  const txs = loadTxs().map((t) => {
    if (!t.pending) return t;
    // preFc <= 0 means the balance was unknown (wallet loading) when this was recorded,
    // so the drop test below is meaningless for it — leave it to the chain / the age-out.
    const dropSeen = t.preFc > 0 && synced && daemonFc <= t.preFc - t.spentFc + EPS;
    if (dropSeen || now - t.ts > PENDING_MAX_AGE_MS) {
      changed = true;
      return { ...t, pending: false };
    }
    return t;
  });
  if (changed) save(txs);
  return txs;
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
