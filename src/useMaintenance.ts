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

/// How often the policy is consulted. Cheap — it is a pure function over state
/// already in hand — and the real rate limit is `MAINTENANCE_MIN_INTERVAL_MS`.
const POLL_MS = 60_000;

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
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const { status, token, network, busy, getSeed, onMerged } = latest.current;
      if (running.current || cancelled) return;

      const decision = shouldRunMaintenance({
        status,
        busy,
        enabled: isMaintenanceEnabled(),
        lastRunAt: lastMaintenanceRun(token),
        now: Date.now(),
      });
      if (!decision.run || !status?.address) return;

      running.current = true;
      try {
        const seed = await getSeed();
        const spendable = BigInt(status.spendable_sompi ?? "0");
        // ONE round. The point is to keep the count down over time, not to empty
        // the wallet into a merge storm the moment the app opens.
        const merged = await consolidateNonCustodial(seed, network, status.address, spendable, undefined, 1);
        if (!cancelled && merged.rounds > 0) {
          // Recorded only on success, so a daemon that is busy or a device that
          // cannot sign does not consume the wallet's next maintenance window.
          recordMaintenanceRun(token, Date.now());
          onMerged?.();
        }
      } catch {
        // Locked app, no seed on this device, prover busy, node unreachable — all
        // ordinary and all temporary. Stay silent and let the next tick decide.
      } finally {
        running.current = false;
      }
    };

    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
