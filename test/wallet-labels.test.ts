import { describe, it, expect, beforeEach } from "vitest";
import { addWallet, unregisterWallet, listWallets, renameWallet } from "../src/wallets";

// The default label is the only wallet identity the balance screen shows, and
// labels are persisted. Numbering from the list LENGTH reused a number that was
// still on screen: remove the second of three and the next add is a second
// "Wallet 3", same avatar digit, indistinguishable forever.
describe("default wallet labels stay unique", () => {
  beforeEach(() => localStorage.clear());

  it("does not reuse a number after a removal", () => {
    const a = addWallet(); // Wallet 1
    const b = addWallet(); // Wallet 2
    addWallet();           // Wallet 3
    unregisterWallet(b);
    addWallet();
    const labels = listWallets().map((w) => w.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain(undefined);
    expect(a).toBeTruthy();
  });

  it("survives several remove/add cycles", () => {
    for (let i = 0; i < 4; i++) addWallet();
    const list = listWallets();
    unregisterWallet(list[1].token);
    unregisterWallet(list[2].token);
    addWallet();
    addWallet();
    const labels = listWallets().map((w) => w.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("counts past a renamed wallet that holds a high number", () => {
    const a = addWallet();
    renameWallet(a, "Wallet 9");
    addWallet();
    const labels = listWallets().map((w) => w.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
