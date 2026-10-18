import { beforeEach, describe, expect, it } from "vitest";
import { getTxLabel, setTxLabel } from "../src/txlabels";
import { wipeWalletState } from "../src/walletstate";

/**
 * A transaction label is the user's own note about what a payment WAS — and on a shielded
 * chain that is often the entire disclosure, because the chain itself says nothing. It is
 * the same category of metadata as a contact name, which `contacts.ts` calls "the ONLY
 * place a payment can acquire a human name".
 *
 * It was stored under ONE GLOBAL key, so `walletstate.ts` — whose premise is that every
 * piece of a wallet's state has to go together on removal — never swept it: a global key
 * cannot be matched by a per-wallet prefix. Labels therefore outlived the wallet they
 * described, indefinitely.
 */
const TXID = "a".repeat(64);

describe("transaction labels belong to one wallet", () => {
  beforeEach(() => localStorage.clear());

  it("does not show one wallet's labels under another", () => {
    localStorage.setItem("wallet_token", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    setTxLabel(TXID, "rent, March");
    expect(getTxLabel(TXID)).toBe("rent, March");

    localStorage.setItem("wallet_token", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(getTxLabel(TXID)).toBe("");
  });

  it("erases a wallet's labels when the wallet is removed", () => {
    const token = "cccccccccccccccccccccccccccccccc";
    localStorage.setItem("wallet_token", token);
    setTxLabel(TXID, "paid Dave back");
    expect(getTxLabel(TXID)).toBe("paid Dave back");

    wipeWalletState(token);

    // Nothing of it left anywhere in storage — not just invisible, gone.
    localStorage.setItem("wallet_token", token);
    expect(getTxLabel(TXID)).toBe("");
    const all = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? "").join("|");
    expect(all).not.toContain("paid Dave back");
  });

  it("adopts labels written before they were keyed per wallet, once", () => {
    // A user upgrading must not lose the labels they already have.
    localStorage.setItem("zkas_tx_labels_v1", JSON.stringify({ [TXID]: "old note" }));
    localStorage.setItem("wallet_token", "dddddddddddddddddddddddddddddddd");

    expect(getTxLabel(TXID)).toBe("old note");
    // The legacy key is cleared, so it cannot be re-adopted by a second wallet later.
    expect(localStorage.getItem("zkas_tx_labels_v1")).toBeNull();

    localStorage.setItem("wallet_token", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    expect(getTxLabel(TXID)).toBe("");
  });

  it("survives a malformed legacy blob", () => {
    localStorage.setItem("zkas_tx_labels_v1", "[1,2,3]");
    localStorage.setItem("wallet_token", "ffffffffffffffffffffffffffffffff");
    expect(getTxLabel(TXID)).toBe("");
    expect(() => setTxLabel(TXID, "fresh")).not.toThrow();
    expect(getTxLabel(TXID)).toBe("fresh");
  });
});
