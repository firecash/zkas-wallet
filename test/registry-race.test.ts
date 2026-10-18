import { beforeEach, describe, expect, it } from "vitest";
import { addWallet, ensureRegistered, listWallets, renameWallet, unregisterWallet } from "../src/wallets";
import { setToken } from "../src/api";

/**
 * Two tabs share this storage, and every mutation here is read -> change -> write the WHOLE
 * list. That is a lost-update race, and most of it heals: the status poll re-registers a row
 * it finds missing, and a freshly minted wallet becomes active and re-registers itself.
 *
 * Removal does not heal — it un-heals. Tab A removes a wallet and writes the shorter list;
 * tab B writes a list it read BEFORE that, and the removed wallet is back in the switcher,
 * with its data already wiped, so it returns as a wallet this device cannot spend from.
 */
const LIST = "wallets_v1";
const GONE = "wallets_removed_v1";

describe("the wallet registry under a concurrent write", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
  });

  it("does not resurrect a removed wallet when another tab writes a stale list", () => {
    localStorage.setItem(LIST, JSON.stringify([{ token: "w1", label: "W1" }, { token: "w2", label: "W2" }]));
    const stale = JSON.parse(localStorage.getItem(LIST)!);   // what the other tab already read

    unregisterWallet("w2");
    expect(listWallets().map((w) => w.token)).toEqual(["w1"]);

    // The other tab now writes its stale list — w2 is back in STORAGE...
    stale[0].label = "renamed in the other tab";
    localStorage.setItem(LIST, JSON.stringify(stale));
    expect(JSON.parse(localStorage.getItem(LIST)!)).toHaveLength(2);

    // ...but not in the switcher, because the removal is a tombstoned fact rather than a
    // state a later list can overwrite.
    expect(listWallets().map((w) => w.token)).toEqual(["w1"]);
    expect(listWallets()[0].label).toBe("renamed in the other tab");   // the rename survives
  });

  it("lets a DELIBERATELY re-adopted token come back", () => {
    // Pairing, or a desktop shell handing the same token back. Without clearing the
    // tombstone the paired wallet would be filtered out of the switcher forever.
    // A REAL token shape: setToken refuses anything shorter than 16 hex chars, so a toy
    // value like "abc123" returns early and never reaches clearTombstone — which is how
    // the first version of this test failed, on its own input rather than on the code.
    const tok = "abcdef0123456789abcdef0123456789";
    localStorage.setItem(LIST, JSON.stringify([{ token: tok, label: "W" }]));
    unregisterWallet(tok);
    expect(listWallets()).toHaveLength(0);

    setToken(tok);
    ensureRegistered(tok, "zkas:something");
    expect(listWallets().map((w) => w.token)).toEqual([tok]);
  });

  it("does not let the poll quietly clear a tombstone", () => {
    // ensureRegistered runs every second; if IT cleared tombstones the guard would be
    // worthless. Only an explicit setToken does.
    localStorage.setItem(LIST, JSON.stringify([{ token: "w9", label: "W9" }]));
    unregisterWallet("w9");
    ensureRegistered("w9", "zkas:addr");
    expect(listWallets()).toHaveLength(0);
  });

  it("caps the tombstone list", () => {
    for (let i = 0; i < 30; i++) unregisterWallet(`t${i}`);
    expect(JSON.parse(localStorage.getItem(GONE)!).length).toBeLessThanOrEqual(20);
  });

  it("still registers, renames and mints normally", () => {
    const t = addWallet(false);
    ensureRegistered(t, "zkas:addr");
    renameWallet(t, "Mine");
    expect(listWallets().find((w) => w.token === t)?.label).toBe("Mine");
  });
});
