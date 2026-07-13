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
  pending: boolean; // true until the daemon balance reflects it
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
 * Reconcile pending flags against the daemon's current balance. A pending spend is
 * "applied" once the wallet is synced and the daemon balance has fallen to at/below
 * the value expected after that spend — at which point the daemon's own number takes
 * over seamlessly (same figure, no jump). Also ages out stale pendings.
 */
export function reconcile(daemonFc: number, synced: boolean): LocalTx[] {
  const now = Date.now();
  let changed = false;
  const txs = loadTxs().map((t) => {
    if (!t.pending) return t;
    const applied = synced && daemonFc <= t.preFc - t.spentFc + EPS;
    if (applied || now - t.ts > PENDING_MAX_AGE_MS) {
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
