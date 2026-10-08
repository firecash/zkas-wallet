import { describe, it, expect } from "vitest";
import { sameStatus } from "../src/App";

// `sameStatus` exists to stop a re-render on every 1Hz poll, so anything it does
// not compare is a value the UI can never notice changing. `private_sends` was
// missing: the daemon confirmed Anonymous sends had been turned ON, the comparator
// called the status identical, React kept the old object, and the Settings row
// went on saying "Off" until a full reload — an irreversible privacy choice
// reported backwards.
describe("sameStatus notices what the UI shows", () => {
  const base = {
    has_wallet: true, address: "zkas:p1", synced: true, warming: false,
    spend_ready: true, loading: false, node_connected: true,
    balance_fc: "1", spendable_fc: "1", maturing_fc: "0",
    pending_in_fc: "0", pending_out_fc: "0", pending_change_fc: "0",
    note_count: 1, error: null, missing_history: false, watch_only: false,
    private_sends: false,
  } as never;

  it("sees anonymous sends being turned on", () => {
    expect(sameStatus(base, { ...(base as object), private_sends: true } as never)).toBe(false);
  });

  it("still treats an unchanged status as unchanged", () => {
    expect(sameStatus(base, { ...(base as object) } as never)).toBe(true);
  });
});
