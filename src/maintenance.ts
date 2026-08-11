// Background note maintenance — keeping a wallet payable.
//
// A shielded payment can spend at most ~38 notes, because a transaction may not
// exceed the block mass limit. A wallet whose balance is spread over more notes
// than that cannot pay its own balance in one transaction, and the only ways out
// are both bad: split the payment across transactions (the recipient can be paid
// in part, which is not a payment), or merge notes first and wait out the ~10.5
// minute anchor maturity before paying — at the moment somebody is trying to
// settle a bill.
//
// Neither is necessary if the wallet never gets into that state. That is what
// this does: while the app is open and idle, merge the oldest notes occasionally,
// so the note count stays under the ceiling and every payment fits one
// transaction. Atomic delivery then costs nothing and needs no special flow.
//
// WHY THE DEVICE AND NOT THE DAEMON. walletd already has a background merger, and
// on the hosted daemon it has never merged anything — measured, `consolidate:
// merging` appears zero times in its log while it reports "3 of 36 loaded
// wallet(s) are over the 500-note ceiling but none were eligible (3 watch-only)".
// It cannot run: merging is a spend, a spend needs the spend key, and a
// non-custodial wallet deliberately never gives the daemon one. The daemon proves
// and the device signs — so maintenance has to be driven from the side holding
// the key. It reuses the ordinary prepare/verify/sign/submit path, which already
// refuses to sign anything that is not a payment to this wallet itself.

import { MAX_NOTES_PER_TX } from "./noncustodial";
import type { Status } from "./api";

/// Merge once the wallet holds more notes than this.
///
/// Above `MAX_NOTES_PER_TX` a full-balance payment no longer fits one transaction,
/// so that is the line that matters — but merging the instant it is crossed would
/// have a wallet re-merging after every few received payments, paying a fee each
/// time. The gap between the two leaves room for ordinary activity, and a merge
/// takes the count well back under the ceiling rather than skimming it.
export const MAINTENANCE_NOTE_THRESHOLD = MAX_NOTES_PER_TX + 10;

/// Never merge more often than this. A merge costs a network fee and a proving
/// slot, and neither should be spent at a rate driven by how often a poll happens
/// to run. Mining payouts arrive one note per block, which no interval can keep
/// up with — that wallet belongs on a self-hosted daemon whose merger holds a seed.
export const MAINTENANCE_MIN_INTERVAL_MS = 15 * 60 * 1000;

/// Fee ceiling per merge, mirroring the send path's cap.
const MAX_FEE_SOMPI = 10_000_000;

const LAST_RUN_KEY = "maintenance_last_run_";

export type MaintenanceSkip =
  | "disabled"
  | "not-synced"
  | "not-spend-ready"
  | "few-notes"
  | "too-soon"
  | "nothing-spendable"
  | "busy";

export type MaintenanceDecision = { run: true } | { run: false; because: MaintenanceSkip };

export interface MaintenanceInputs {
  status: Status | null;
  /// True while the user is doing something the merge must not compete with — a
  /// send in flight, a dialog open. Maintenance is never worth interrupting.
  busy: boolean;
  enabled: boolean;
  lastRunAt: number | null;
  now: number;
}

/**
 * Whether to run one merge round now.
 *
 * Pure so the policy can be argued about and tested rather than inferred from
 * behaviour. Every "no" names its reason: a maintenance pass that silently never
 * runs is exactly the failure the daemon's own merger shipped with, where the
 * feature was on, believed to be working, and structurally incapable of acting.
 */
export function shouldRunMaintenance(input: MaintenanceInputs): MaintenanceDecision {
  const { status, busy, enabled, lastRunAt, now } = input;
  if (!enabled) return { run: false, because: "disabled" };
  if (busy) return { run: false, because: "busy" };
  if (!status || !status.synced) return { run: false, because: "not-synced" };
  // The daemon's own answer about whether it would accept a spend. Merging is a
  // spend; asking anything weaker here just moves the failure to /prepare.
  if (status.spend_ready === false) return { run: false, because: "not-spend-ready" };
  if ((status.note_count ?? 0) <= MAINTENANCE_NOTE_THRESHOLD) return { run: false, because: "few-notes" };
  if (lastRunAt !== null && now - lastRunAt < MAINTENANCE_MIN_INTERVAL_MS) return { run: false, because: "too-soon" };

  // Merging spends the balance to itself, so there must be enough to cover the
  // fee. Without this the round reaches /prepare only to be refused.
  const spendable = BigInt(status.spendable_sompi ?? "0");
  if (spendable <= BigInt(MAX_FEE_SOMPI)) return { run: false, because: "nothing-spendable" };

  return { run: true };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** When this wallet last merged, per token — so switching wallets does not make
 * one wallet's merge look like another's. */
export function lastMaintenanceRun(token: string, store: Storage | null = storage()): number | null {
  const raw = store?.getItem(LAST_RUN_KEY + token);
  const at = raw ? Number(raw) : NaN;
  return Number.isFinite(at) ? at : null;
}

export function recordMaintenanceRun(token: string, at: number, store: Storage | null = storage()): void {
  try {
    store?.setItem(LAST_RUN_KEY + token, String(at));
  } catch {
    // Full or private storage must not stop a merge; the cost of forgetting is
    // one extra round, which the interval check will still bound afterwards.
  }
}

/// Maintenance is on unless the user turned it off. A wallet that quietly stops
/// being able to pay is a worse default than an occasional background fee.
const ENABLED_KEY = "maintenance_enabled";

export function isMaintenanceEnabled(store: Storage | null = storage()): boolean {
  return store?.getItem(ENABLED_KEY) !== "off";
}

export function setMaintenanceEnabled(on: boolean, store: Storage | null = storage()): void {
  try {
    if (on) store?.removeItem(ENABLED_KEY);
    else store?.setItem(ENABLED_KEY, "off");
  } catch {
    // Same reasoning as above: a preference that cannot be written must not throw
    // out of a settings toggle.
  }
}
