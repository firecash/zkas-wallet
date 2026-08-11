import { beforeEach, describe, expect, it } from "vitest";
import {
  MAINTENANCE_MIN_INTERVAL_MS,
  MAINTENANCE_NOTE_THRESHOLD,
  isMaintenanceEnabled,
  lastMaintenanceRun,
  recordMaintenanceRun,
  setMaintenanceEnabled,
  shouldRunMaintenance,
} from "../src/maintenance";
import type { Status } from "../src/api";

const NOW = 1_760_000_000_000;

function status(over: Partial<Status> = {}): Status {
  return {
    has_wallet: true,
    address: "zkas:self",
    network: "mainnet",
    node_connected: true,
    daa_score: 1_000_000,
    synced: true,
    spend_ready: true,
    note_count: MAINTENANCE_NOTE_THRESHOLD + 1,
    spendable_sompi: "5000000000",
    ...over,
  } as Status;
}

function decide(over: Partial<Parameters<typeof shouldRunMaintenance>[0]> = {}) {
  return shouldRunMaintenance({ status: status(), busy: false, enabled: true, lastRunAt: null, now: NOW, ...over });
}

describe("when a wallet merges its own notes", () => {
  beforeEach(() => localStorage.clear());

  it("merges once the count passes the point where a payment stops fitting", () => {
    expect(decide()).toEqual({ run: true });
    expect(decide({ status: status({ note_count: MAINTENANCE_NOTE_THRESHOLD }) })).toEqual({
      run: false,
      because: "few-notes",
    });
  });

  // Every refusal names itself. The daemon's own merger shipped switched on,
  // believed to be working, and structurally unable to act — it took reading its
  // logs to discover it had never merged anything. A silent "no" is the bug.
  it("says why it is not merging", () => {
    expect(decide({ enabled: false })).toEqual({ run: false, because: "disabled" });
    expect(decide({ busy: true })).toEqual({ run: false, because: "busy" });
    expect(decide({ status: status({ synced: false }) })).toEqual({ run: false, because: "not-synced" });
    expect(decide({ status: status({ spend_ready: false }) })).toEqual({ run: false, because: "not-spend-ready" });
    expect(decide({ status: null })).toEqual({ run: false, because: "not-synced" });
  });

  // Merging is a spend to yourself: it costs a fee and a proving slot, so its rate
  // must not be set by how often a poll happens to fire.
  it("holds off until the interval has passed", () => {
    expect(decide({ lastRunAt: NOW - 1_000 })).toEqual({ run: false, because: "too-soon" });
    expect(decide({ lastRunAt: NOW - MAINTENANCE_MIN_INTERVAL_MS - 1 })).toEqual({ run: true });
  });

  it("refuses when there is not enough spendable value to cover the fee", () => {
    expect(decide({ status: status({ spendable_sompi: "1000" }) })).toEqual({
      run: false,
      because: "nothing-spendable",
    });
  });

  // A wallet that cannot yet spend must not be asked to. `spend_ready` is the
  // daemon's own answer, and anything weaker just moves the refusal to /prepare.
  it("waits for the daemon to say it would accept a spend", () => {
    expect(decide({ status: status({ spend_ready: false, synced: true }) })).toEqual({
      run: false,
      because: "not-spend-ready",
    });
    // Older daemons omit the field; treat absence as "ask and find out" rather
    // than as a refusal, or maintenance would never run against them.
    const legacy = status();
    delete (legacy as { spend_ready?: boolean }).spend_ready;
    expect(decide({ status: legacy })).toEqual({ run: true });
  });

  it("remembers the last run per wallet, so one wallet does not gate another", () => {
    recordMaintenanceRun("token-a", NOW);
    expect(lastMaintenanceRun("token-a")).toBe(NOW);
    expect(lastMaintenanceRun("token-b")).toBeNull();
  });

  it("is on by default and can be turned off", () => {
    expect(isMaintenanceEnabled()).toBe(true);
    setMaintenanceEnabled(false);
    expect(isMaintenanceEnabled()).toBe(false);
    setMaintenanceEnabled(true);
    expect(isMaintenanceEnabled()).toBe(true);
  });
});
