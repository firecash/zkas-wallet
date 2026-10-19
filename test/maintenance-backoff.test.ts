import { describe, expect, it } from "vitest";
import { MAINTENANCE_MIN_INTERVAL_MS, maintenanceBackoffMs, shouldRunMaintenance } from "../src/maintenance";

/**
 * A failed round is deliberately NOT recorded as a run — "so a daemon that is busy or a device
 * that cannot sign does not consume the wallet's next maintenance window". Right for a
 * transient failure, wrong for a persistent one: the tick is every 60s, and a round that fails
 * inside `/prepare` has already cost the daemon a 38-spend Halo 2 proof, measured at 40-92 s on
 * the hosted deployment. Retrying that once a minute, from every note-heavy wallet whose
 * consolidation keeps failing, is load the daemon can least afford.
 *
 * Same shape as the status poll's backoff (#69), and the daemon's own supervisor states the
 * principle: hammering it helps nobody.
 */
const ok = {
  status: { synced: true, spend_ready: true, note_count: 100, spendable_sompi: "9999999999", address: "zkas:q" } as never,
  busy: false,
  enabled: true,
  lastRunAt: null,
  now: 1_000_000_000,
};

describe("a consolidation that keeps failing stops paying for proofs", () => {
  it("does not back off before anything has failed", () => {
    expect(maintenanceBackoffMs(0)).toBe(0);
    expect(shouldRunMaintenance({ ...ok, consecutiveFailures: 0 }).run).toBe(true);
  });

  it("grows the wait with consecutive failures, and caps it", () => {
    expect(maintenanceBackoffMs(1)).toBe(MAINTENANCE_MIN_INTERVAL_MS);
    expect(maintenanceBackoffMs(2)).toBe(MAINTENANCE_MIN_INTERVAL_MS * 2);
    expect(maintenanceBackoffMs(3)).toBe(MAINTENANCE_MIN_INTERVAL_MS * 4);
    // Capped, so it never becomes "never".
    expect(maintenanceBackoffMs(50)).toBe(4 * 60 * 60_000);
    expect(maintenanceBackoffMs(99)).toBe(maintenanceBackoffMs(50));
  });

  it("skips while inside the backoff and runs once past it", () => {
    const d1 = shouldRunMaintenance({ ...ok, consecutiveFailures: 2, lastFailureAt: ok.now - 1000 });
    expect(d1.run).toBe(false);
    expect(d1.run === false && d1.because).toBe("backing-off");

    const past = ok.now - (MAINTENANCE_MIN_INTERVAL_MS * 2 + 1);
    expect(shouldRunMaintenance({ ...ok, consecutiveFailures: 2, lastFailureAt: past }).run).toBe(true);
  });

  it("leaves every existing reason to skip intact", () => {
    expect(shouldRunMaintenance({ ...ok, enabled: false }).run).toBe(false);
    expect(shouldRunMaintenance({ ...ok, busy: true }).run).toBe(false);
    expect(shouldRunMaintenance({ ...ok, status: { ...ok.status, synced: false } as never }).run).toBe(false);
    expect(shouldRunMaintenance({ ...ok, status: { ...ok.status, spend_ready: false } as never }).run).toBe(false);
    expect(shouldRunMaintenance({ ...ok, status: { ...ok.status, note_count: 2 } as never }).run).toBe(false);
    expect(shouldRunMaintenance({ ...ok, lastRunAt: ok.now - 1000 }).run).toBe(false);
    expect(shouldRunMaintenance({ ...ok, status: { ...ok.status, spendable_sompi: "1" } as never }).run).toBe(false);
  });

  it("is a no-op for callers that pass neither field", () => {
    // The fields are optional so existing callers and tests keep their meaning.
    expect(shouldRunMaintenance(ok).run).toBe(true);
  });
});
