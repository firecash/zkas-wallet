// Drives the note maintenance described in `maintenance.ts`: while the app is
// open, unlocked and idle, occasionally merge the oldest notes so the wallet keeps
// fitting a payment into one transaction.
//
// Deliberately quiet. This is housekeeping the user did not ask for, so it must
// never take the screen, never block a payment, and never report a failure at
// them: if the daemon is busy proving somebody's send it answers 503 and the
// right response is to try again later, not to raise an error about a merge
// nobody requested.

import { useEffect, useRef } from "react";
import { consolidateNonCustodial } from "./noncustodial";
import {
  isMaintenanceEnabled,
  lastMaintenanceRun,
  recordMaintenanceRun,
  shouldRunMaintenance,
} from "./maintenance";
import type { Status } from "./api";
import type { Network } from "./signer";
import { embeddedChosen } from "./embedded";

/// How often the policy is consulted. Cheap — it is a pure function over state
/// already in hand — and the real rate limit is `MAINTENANCE_MIN_INTERVAL_MS`.
const POLL_MS = 60_000;

/// The merge round running right now, if any. `busy` keeps a round from STARTING
/// while the user is on Send, but one already running keeps going — its /prepare
/// holds the wallet on the daemon for the whole proof, and a payment prepared in
/// that window is refused with 429 "merging its own notes". A send checks here
/// first and waits for the round instead of colliding with it. Never rejects.
let inFlight: Promise<void> | null = null;
/// A merge the user started (Combine dialog, Wallet tools), while it runs.
let manualMerge: Promise<void> | null = null;
/** A merge running now, background or user-started: a payment waits for it before preparing. */
export function mergeInFlight(): Promise<void> | null {
  return inFlight ?? manualMerge;
}

/**
 * Run a user-started merge so it never overlaps the background one. Two merges of one wallet
 * at once each picked the same notes and the second was refused by the node as a double spend
 * after paying for its proof (twice on 3 Nov: a full sweep and a one-third split, seconds
 * apart). This waits for a background merge already running, and the background one skips its
 * turn while this runs.
 */
export async function exclusiveMerge<T>(run: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  manualMerge = gate;
  try {
    const background = inFlight;
    if (background) await background.catch(() => undefined);
    return await run();
  } finally {
    if (manualMerge === gate) manualMerge = null;
    release();
  }
}

export interface MaintenanceOptions {
  status: Status | null;
  /// The active wallet's token: the interval is remembered per wallet.
  token: string;
  network: Network;
  /// True while the user is mid-send or has a dialog open.
  busy: boolean;
  /// Resolves this device's seed, or rejects when it is not available — locked
  /// app, watch-only device. Rejection is a normal outcome, not an error.
  getSeed: () => Promise<string>;
  /// Called after a merge lands, so the caller can refresh its view.
  onMerged?: () => void;
}

export function useMaintenance(options: MaintenanceOptions): void {
  // The running flag lives in a ref, not state: a merge takes tens of seconds and
  // re-rendering on it would be visible churn for something the user is not
  // watching.
  const running = useRef(false);
  const failures = useRef(0);
  const lastFailureAt = useRef<number | null>(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const { status, token, network, busy, getSeed, onMerged } = latest.current;
      if (running.current || cancelled || manualMerge) return;

      const decision = shouldRunMaintenance({
        status,
        busy,
        enabled: isMaintenanceEnabled() && !embeddedChosen(),
        lastRunAt: lastMaintenanceRun(token),
        // Session-scoped on purpose: a reload is a user action and clears the backoff, while
        // a wallet left open with a consolidation that keeps failing stops paying for a
        // 38-spend proof every minute. See maintenanceBackoffMs.
        consecutiveFailures: failures.current,
        lastFailureAt: lastFailureAt.current,
        now: Date.now(),
      });
      if (!decision.run || !status?.address) return;
      const address = status.address;
      const spendable = BigInt(status.spendable_sompi ?? "0");

      running.current = true;
      const round = (async () => {
        try {
          const seed = await getSeed();
          // ONE round. The point is to keep the count down over time, not to empty
          // the wallet into a merge storm the moment the app opens.
          const merged = await consolidateNonCustodial(seed, network, address, spendable, undefined, 1);
          if (!cancelled && merged.rounds > 0) {
            // Recorded only on success, so a daemon that is busy or a device that
            // cannot sign does not consume the wallet's next maintenance window.
            recordMaintenanceRun(token, Date.now());
            failures.current = 0;
            lastFailureAt.current = null;
            onMerged?.();
          }
        } catch {
          // Locked app, no seed on this device, prover busy, node unreachable — all
          // ordinary and all temporary. Stay silent and let the next tick decide.
          // Counted, though: "temporary" that repeats for an hour is a round costing the
          // daemon a Halo 2 proof every minute for nothing.
          failures.current += 1;
          lastFailureAt.current = Date.now();
        }
      })();
      inFlight = round;
      try {
        await round;
      } finally {
        running.current = false;
        if (inFlight === round) inFlight = null;
      }
    };

    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
