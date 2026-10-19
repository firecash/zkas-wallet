import { readLocal, writeLocal } from "./lib/safestore";
import { elapsedSince } from "./lib/elapsed";
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
  /// When `confs` was learned. The count grows continuously (~1 block/s) but is only
  /// sampled every few seconds, so the display interpolates from this instant instead
  /// of jumping when a poll lands. See `confirmations.ts`.
  confAt?: number;
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
  return `local_txs_${readLocal("wallet_token") || "default"}`;
}

/**
 * Apply a change to the stored send list, reading it at the moment of WRITING.
 *
 * Every writer here was read -> change -> write the WHOLE list, and two tabs share this
 * storage. `reconcile` runs on every poll in every tab, so the window was hit routinely:
 * tab A records a send, tab B's next reconcile writes a list it read BEFORE that, and the
 * send record is gone. Losing it loses the optimistic subtraction with it, so the balance
 * goes back to showing coins that have already left — and the obvious thing to do with a
 * balance that still shows the money is to send it again.
 *
 * Re-reading inside the writer closes it to the gap between these two statements, which no
 * other tab can interleave because each is synchronous. The transform must therefore be
 * written against "whatever the list is now" rather than a list captured earlier — that is
 * why these take a function instead of an array.
 */
function mutate(fn: (txs: LocalTx[]) => LocalTx[]): LocalTx[] {
  const next = fn(loadTxs());
  save(next);
  return next;
}

export function loadTxs(): LocalTx[] {
  try {
    const v = JSON.parse(readLocal(key()) || "[]");
    if (!Array.isArray(v)) return [];
    // Only the ARRAY was checked here, never the records in it, so a corrupt or
    // hand-edited entry travelled all the way to the screen: a non-numeric `confAt`
    // reached tickedConfirmations and came back NaN, which History printed as "NaN
    // confirmations". Same rule saneHistory states for chain rows — a record that cannot
    // be understood is dropped rather than repaired, because inventing an amount puts a
    // wrong number in a list of payments, which is worse than a missing line.
    return (v as unknown[]).filter((r): r is LocalTx => {
      if (!r || typeof r !== "object") return false;
      const t = r as Partial<LocalTx>;
      // Only what genuinely cannot be defaulted. The first version of this check also
      // required preFc, feeFc and spentFc — and two existing tests caught it, because
      // `recordSend` is called WITHOUT preFc (and without `to`). Requiring them would have
      // deleted real send history, including every record written by an older build: this
      // type already documents that older records lack fields (`payId` says so), and a
      // migration that silently drops a user's payment list is far worse than the NaN it
      // was trying to prevent.
      if (typeof t.txid !== "string" || !t.txid) return false;
      if (!Number.isFinite(t.amountFc) || !Number.isFinite(t.ts)) return false;
      // The money fields that CAN be defaulted are, rather than costing the record. 0 is
      // already a defined state downstream: reconcile reads preFc <= 0 as "the balance was
      // unknown when this was recorded" and ages the row out instead of testing a drop,
      // and a spentFc of 0 subtracts nothing from the displayed balance.
      if (!Number.isFinite(t.feeFc)) t.feeFc = 0;
      if (!Number.isFinite(t.preFc)) t.preFc = 0;
      if (!Number.isFinite(t.spentFc)) t.spentFc = 0;
      // The optional chain-status pair is cleaned rather than fatal: a send with no
      // confirmation yet is the normal case, so only a PRESENT-but-broken value goes.
      if (t.confs !== undefined && !Number.isFinite(t.confs)) delete t.confs;
      if (t.confAt !== undefined && !Number.isFinite(t.confAt)) delete t.confAt;
      return true;
    });
  } catch {
    return [];
  }
}

function save(txs: LocalTx[]) {
  // writeLocal, to match the reader. `loadTxs` already reads through safestore, so a raw
  // write here could never populate what that reader consults: on a browser with site storage
  // blocked, a send recorded the instant after it was broadcast vanished from history
  // immediately, rather than surviving the page the way safestore's session copy allows.
  // Contacts states the same rule for the same reason — "a raw read here would not see it, so
  // a contact would vanish the instant it was saved" — and this file had it the other way
  // round. Still best-effort across a reload, which is all this list ever claimed to be.
  writeLocal(key(), JSON.stringify(txs.slice(0, MAX)));
}

/** Record a freshly broadcast send. Returns the updated list. */
export function recordSend(t: Omit<LocalTx, "pending">): LocalTx[] {
  return mutate((txs) => [{ ...t, pending: true }, ...txs.filter((x) => x.txid !== t.txid)]);
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
  const next = mutate((txs) =>
    txs.map((t) => {
      if (t.txid !== txid) return t;
      if (t.confs !== confirmations || t.confTries) changed = true;
      return { ...t, confs: confirmations, confAt: Date.now(), confTries: 0 };
    }),
  );
  // `changed` only gates whether this was worth persisting; the write is harmless either
  // way now that it is a merge onto the current list rather than an overwrite of a stale one.
  void changed;
  return next;
}

/** Count one unanswered confirmation lookup against `txid` (see `confTries`). */
export function bumpConfTry(txid: string): LocalTx[] {
  return mutate((txs) => txs.map((t) => (t.txid === txid ? { ...t, confTries: (t.confTries ?? 0) + 1 } : t)));
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
      // NOT released on `pending_out_fc`. I used it as a release signal and it is
      // the one thing this file forbids: api.ts defines it as 0-conf value the
      // CHAIN has seen, and the `pending` doc above says, from a real incident,
      // that clearing on a chain signal makes the sent coins reappear
      // (10 -> 6 -> 10 -> 6) because the daemon re-scans minutes later. The
      // asymmetry it was meant to fix — Send refusing to spend money the hero
      // was already showing — belongs on the Send screen, which now subtracts
      // the same `max(daemon pendingOut, local)` the hero does.
      const maxAge = r.confs != null ? PENDING_CONFIRMED_MAX_AGE_MS : PENDING_MAX_AGE_MS;
      if (dropCovers || elapsedSince(r.ts, now) > maxAge) clear.add(r.txid);
    }
  }
  if (clear.size === 0) return txs;
  return applyPendingCleared(clear);
}

/**
 * Clear `pending` on exactly these txids, against the list as it is NOW.
 *
 * Split out from `reconcile` so the two phases are separable, because the gap between them
 * is where the bug was: reconcile decides from a list it read at its top, and writing that
 * same list back erased anything another tab had recorded in between — a send, most of the
 * time, since that is the only thing that adds a row. It runs on every poll in every tab,
 * so the window was hit routinely rather than theoretically.
 *
 * The DECISION still comes from the earlier read, which is right: those are the rows whose
 * balance drop was actually measured. Only the WRITE has to be current. Separating them also
 * makes the interleaving testable, which it was not while both lived in one function.
 */
export function applyPendingCleared(clear: Set<string>): LocalTx[] {
  return mutate((cur) => cur.map((t) => (t.pending && clear.has(t.txid) ? { ...t, pending: false } : t)));
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
  // `readLocal`, like `key()` twenty lines up. This file had one of each: the local-tx key
  // was migrated to the safe reader and the snapshot key was left reading the accessor
  // directly, so on a browser with site storage blocked — where the accessor throws rather
  // than returning null — the last-known-balance safety net died entirely instead of
  // falling back to the default token. The callers catch, so it was never a crash, just
  // the net quietly gone on the browsers most likely to need it.
  return `last_known_${readLocal("wallet_token") || "default"}`;
}

export function saveSnapshot(s: Snapshot) {
  // Through safestore both ways, like the list above. The comment on `snapKey` describes the
  // last-known-balance net dying on exactly the browsers most likely to need it; a raw write
  // leaves it dead for the session even when the read is safe.
  writeLocal(snapKey(), JSON.stringify(s));
}

export function loadSnapshot(): Snapshot | null {
  try {
    const raw = readLocal(snapKey());
    if (!raw) return null;
    const s = JSON.parse(raw) as Snapshot;
    return typeof s?.balanceFc === "number" ? s : null;
  } catch {
    return null;
  }
}
