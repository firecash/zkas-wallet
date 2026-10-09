import { describe, it, expect, beforeEach } from "vitest";
import { nextFreeAccount, setAccountOf, clearAccountOf, releaseAccount, accountOf } from "../src/accounts";
import { addWallet, unregisterWallet, listWallets } from "../src/wallets";

// The index a new account gets comes from a high-water mark that only rises, so
// a removed wallet's index is never reissued. A FAILED creation reserved one
// the same way and never gave it back, so the numbering ran ahead of reality:
// "Wallet 4" labelled "Account 6".
describe("account indices", () => {
  beforeEach(() => localStorage.clear());

  it("a failed creation gives its index back", () => {
    const home = addWallet();
    setAccountOf(home, 0);
    expect(nextFreeAccount()).toBe(1);

    // Attempt that fails after reserving: this is the rollback path.
    const doomed = addWallet();
    setAccountOf(doomed, 1);
    clearAccountOf(doomed);
    releaseAccount(1);
    unregisterWallet(doomed);

    expect(nextFreeAccount()).toBe(1); // not 2
  });

  it("an index still in use is never released", () => {
    const home = addWallet();
    setAccountOf(home, 0);
    const kept = addWallet();
    setAccountOf(kept, 1);
    releaseAccount(1); // something still holds it
    expect(nextFreeAccount()).toBe(2);
  });

  it("a REMOVED wallet's index is still never reissued", () => {
    // The whole reason the mark exists: reissuing would derive the removed
    // wallet's keys again, and its balance would reappear under a new name.
    const home = addWallet();
    setAccountOf(home, 0);
    const second = addWallet();
    setAccountOf(second, 1);
    const third = addWallet();
    setAccountOf(third, 2);
    clearAccountOf(second);
    unregisterWallet(second);
    expect(nextFreeAccount()).toBe(3);
    releaseAccount(1); // below the mark: must NOT be handed back
    expect(nextFreeAccount()).toBe(3);
  });

  it("each account keeps its own index across the registry", () => {
    const tokens = [0, 1, 2].map((n) => { const t = addWallet(); setAccountOf(t, n); return t; });
    expect(tokens.map((t) => accountOf(t))).toEqual([0, 1, 2]);
    expect(listWallets()).toHaveLength(3);
  });
});
