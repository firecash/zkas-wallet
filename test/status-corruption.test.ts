import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, WalletdUnauthorizedError } from "../src/api";

/**
 * What the wallet does with a reply it cannot trust.
 *
 * Each case here was reproduced by driving the built app against a daemon that answers
 * badly, and each one put a WRONG NUMBER in front of the user rather than failing. For a
 * wallet that is the worst available outcome short of losing the coins: somebody opens the
 * app, reads "0 ZKAS", and believes their money is gone.
 *
 * The rule the tests pin: a reply that cannot be trusted is rejected WHOLE, so the poll
 * fails and the UI keeps showing the last status it actually received. Nothing here
 * repairs or clamps a figure, because a repaired figure is still not the wallet's.
 */
const ok = {
  has_wallet: true, synced: true, address: "zkas:test", network: "mainnet",
  balance_fc: "12.5", spendable_fc: "12.5", maturing_fc: "0",
  note_count: 3, scanned_blocks: 7_000_000, chain_len: 7_000_000,
};

function answer(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    status, statusText: "", ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
    headers: new Headers({ "content-type": "application/json" }),
  }));
}

describe("a status reply that cannot be trusted", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
    localStorage.setItem("walletd_base", "http://127.0.0.1:8899");
  });

  it("rejects a 200 with no body instead of reading it as an empty wallet", async () => {
    // `data` started life as `{}` and was only overwritten when there was text to parse,
    // so a truncated response — a proxy closing after the headers is enough — returned
    // `{}`, was cast to Status, and rendered as SHIELDED BALANCE 0 ZKAS with the wallet
    // reported ready. Measured against a daemon answering 200 with an empty body.
    answer(200, "");
    await expect(api.status()).rejects.toThrow();
  });

  it("rejects a negative balance rather than showing it as zero", async () => {
    // History had a sanitiser; status, which is where the balance comes from, had none.
    // "-1" reached the screen as "0 ZKAS ... Ready".
    answer(200, JSON.stringify({ ...ok, balance_fc: "-1" }));
    await expect(api.status()).rejects.toThrow();
  });

  it("rejects a non-numeric balance", async () => {
    answer(200, JSON.stringify({ ...ok, balance_fc: "not-a-number" }));
    await expect(api.status()).rejects.toThrow();
  });

  it("rejects a negative note count or scan cursor", async () => {
    answer(200, JSON.stringify({ ...ok, note_count: -5 }));
    await expect(api.status()).rejects.toThrow();
    answer(200, JSON.stringify({ ...ok, scanned_blocks: -1 }));
    await expect(api.status()).rejects.toThrow();
  });

  it("still accepts a genuinely empty wallet, which is not corruption", async () => {
    // The guard must not reject a real zero: a new wallet holds nothing and has to be
    // able to say so.
    answer(200, JSON.stringify({ ...ok, balance_fc: "0", spendable_fc: "0", note_count: 0 }));
    await expect(api.status()).resolves.toMatchObject({ balance_fc: "0", note_count: 0 });
  });

  it("accepts a 204, which means no content by definition", async () => {
    answer(204, "");
    await expect(api.status()).resolves.toBeDefined();
  });

  it("calls a 401 an auth failure, not an unreachable daemon", async () => {
    // Five of these counted as failed polls produced "Can't reach the wallet service"
    // for a daemon answering every request and only refusing the token — exactly the
    // hunt for a non-existent network problem that WalletdUnauthorizedError exists to
    // prevent. It was only ever thrown from the manual-connect probe.
    answer(401, JSON.stringify({ error: "missing or invalid bearer token" }));
    const err = await api.status().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WalletdUnauthorizedError);
    expect((err as WalletdUnauthorizedError).detail).toBe("missing or invalid bearer token");
  });

  it("marks other non-2xx with the status, since the daemon did answer", async () => {
    // A 502 while the daemon restarts is a different fact from a refused connection,
    // and the caller could not tell them apart.
    answer(503, JSON.stringify({ error: "service unavailable" }));
    const err = await api.status().then(() => null, (e: unknown) => e);
    expect((err as { httpStatus?: number }).httpStatus).toBe(503);
  });
});
