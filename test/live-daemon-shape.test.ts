import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

/**
 * The guards run against a reply captured from the LIVE hosted daemon
 * (wallet.zkas.info/daemon, captured 2026-10-18) rather than one this repo made up.
 *
 * saneStatus rejects a status it cannot trust, which means a mistake in it breaks the real
 * wallet rather than a test. walletd's own structs say that cannot happen — every figure is
 * u64/usize or a decimal string — but a struct is not a running server, so this pins the
 * running server's actual bytes. If a future daemon changes shape, this fails here instead
 * of on someone's phone.
 */
const LIVE_STATUS = "{\"has_wallet\":false,\"address\":null,\"private_sends\":false,\"network\":\"mainnet\",\"node_connected\":true,\"daa_score\":7259587,\"synced\":false,\"warming\":false,\"scanned_blocks\":0,\"chain_len\":7259587,\"balance_sompi\":\"0\",\"balance_fc\":\"0.00000000\",\"spendable_sompi\":\"0\",\"spendable_fc\":\"0.00000000\",\"maturing_sompi\":\"0\",\"maturing_fc\":\"0.00000000\",\"pending_in_sompi\":\"0\",\"pending_in_fc\":\"0.00000000\",\"pending_out_sompi\":\"0\",\"pending_out_fc\":\"0.00000000\",\"pending_change_sompi\":\"0\",\"pending_change_fc\":\"0.00000000\",\"note_count\":0,\"updated_unix\":0,\"error\":null,\"watch_only\":false,\"missing_history\":false,\"spend_ready\":false,\"loading\":false,\"blocks_behind\":0}";

describe("a reply captured from the live daemon", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
    localStorage.setItem("walletd_base", "http://127.0.0.1:8899");
  });

  it("is accepted by the status guard exactly as sent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 200, statusText: "OK", ok: true,
      text: () => Promise.resolve(LIVE_STATUS),
      headers: new Headers({ "content-type": "application/json" }),
    }));
    const s = await api.status();
    // The shape the app depends on, straight from production.
    expect(s.network).toBe("mainnet");
    expect(typeof s.chain_len).toBe("number");
    expect(s.balance_fc).toBe("0.00000000");
  });

  it("carries every field the guard inspects, so none is silently optional", () => {
    // If the daemon ever drops one of these the guard stops checking it and says nothing,
    // which is how an unchecked figure reaches the screen again.
    const live = JSON.parse(LIVE_STATUS) as Record<string, unknown>;
    for (const k of [
      "balance_fc", "spendable_fc", "maturing_fc",
      "pending_in_fc", "pending_out_fc", "pending_change_fc",
      "note_count", "scanned_blocks", "chain_len", "daa_score",
    ]) {
      expect(live, `live daemon no longer sends ${k}`).toHaveProperty(k);
    }
  });

  it("is still rejected once a figure in it goes impossible", () => {
    // Proves the guard is actually engaged on this real shape rather than passing it by.
    const bad = JSON.stringify({ ...JSON.parse(LIVE_STATUS), balance_fc: "-1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 200, statusText: "OK", ok: true,
      text: () => Promise.resolve(bad),
      headers: new Headers({ "content-type": "application/json" }),
    }));
    return expect(api.status()).rejects.toThrow();
  });
});
