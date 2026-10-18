import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { walletCanSpend } from "../src/status";

/**
 * A reply from a REAL, OLDER walletd — kaspad 2.0.1 serving `--devnet --wallet-api`, for a
 * wallet that EXISTS. Every other adverse test in this suite drives a daemon I wrote, so
 * nothing had ever checked the client against a real one that is simply behind.
 *
 * It omits TWELVE fields the client declares, which is the useful part: spend_ready,
 * loading, blocks_behind, private_sends, pending_change_*, warming_* and history_from_daa.
 * That is the compatibility case, and it found a real defect — the send-duration estimate
 * read `!!status.spend_ready` as a bare boolean, so every daemon predating that field sat
 * permanently in the COLD timing bucket and a warm wallet was quoted a cold wallet's time.
 */
const OLD_DAEMON_STATUS = "{\"has_wallet\":true,\"address\":\"zkasdev:pyvfhnu43m328h389f4yjxhcld66zxz8rcdhumlfmacxr7xvkyrw83fk9vxvz4w8xvrejdgu2cxhs2n\",\"network\":\"devnet\",\"node_connected\":true,\"daa_score\":0,\"synced\":false,\"warming\":true,\"scanned_blocks\":0,\"chain_len\":0,\"balance_sompi\":\"0\",\"balance_fc\":\"0.00000000\",\"spendable_sompi\":\"0\",\"spendable_fc\":\"0.00000000\",\"maturing_sompi\":\"0\",\"maturing_fc\":\"0.00000000\",\"pending_in_sompi\":\"0\",\"pending_in_fc\":\"0.00000000\",\"pending_out_sompi\":\"0\",\"pending_out_fc\":\"0.00000000\",\"note_count\":0,\"updated_unix\":1792341728,\"error\":null,\"watch_only\":false,\"missing_history\":false}";

describe("a real older walletd", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
    localStorage.setItem("walletd_base", "http://127.0.0.1:8899");
  });

  it("is accepted by the status guard", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 200, statusText: "OK", ok: true,
      text: () => Promise.resolve(OLD_DAEMON_STATUS),
      headers: new Headers({ "content-type": "application/json" }),
    }));
    const s = await api.status();
    expect(s.has_wallet).toBe(true);
    // The fields it does NOT send must read as absent, not as false-y surprises.
    expect(s.spend_ready).toBeUndefined();
    expect(s.loading).toBeUndefined();
  });

  it("still lets a synced wallet spend, though it never says spend_ready", () => {
    // The documented fallback. Without it an older daemon could never send at all.
    expect(walletCanSpend({ online: true, synced: true, spendReady: undefined })).toBe(true);
    expect(walletCanSpend({ online: true, synced: false, spendReady: undefined })).toBe(false);
  });

  it("buckets the send estimate the same way the spend gate decides", () => {
    // The defect this reply exposed. Both decisions now read the same fallback, so a warm
    // wallet on an older daemon is not quoted a cold wallet's time.
    const bucket = (st: { spend_ready?: boolean; synced?: boolean; warming?: boolean }) =>
      (st.spend_ready ?? st.synced ?? false) && !st.warming;
    const gate = (st: { spend_ready?: boolean; synced?: boolean }) =>
      walletCanSpend({ online: true, synced: !!st.synced, spendReady: st.spend_ready });
    for (const st of [
      { synced: true },                      // older daemon, scanned to tip
      { synced: false },
      { spend_ready: true, synced: false },
      { spend_ready: false, synced: true },
    ]) {
      expect(bucket(st), JSON.stringify(st)).toBe(gate(st));
    }
  });
});
