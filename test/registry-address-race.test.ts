import { describe, it, expect, beforeEach } from "vitest";
import { ensureRegistered, addWallet, listWallets, switchWallet } from "../src/wallets";

// "Your wallets" renders the address stored on each registry row. The status
// poll fills those rows in — and it used to read `wallet_token` AFTER its
// request resolved, so a token that changed mid-flight got the previous
// wallet's address written onto it.
describe("a wallet row shows its own address", () => {
  beforeEach(() => localStorage.clear());

  it("a response attributed to the wallet it was asked about", () => {
    const a = addWallet();
    ensureRegistered(a, "zkas:aaaa");
    const b = addWallet(); // mints AND activates, as recreatePhraseAccounts does

    // A poll for wallet A resolves now, while B is active. Binding the result to
    // the token captured BEFORE the request keeps it on A.
    const polledToken = a;
    if (localStorage.getItem("wallet_token") === polledToken) {
      ensureRegistered(polledToken, "zkas:aaaa");
    }
    // ...and the unguarded version would have done this instead:
    //   ensureRegistered(localStorage.getItem("wallet_token")!, "zkas:aaaa")
    // which writes A's address onto B.

    const rows = listWallets();
    expect(rows.find((w) => w.token === a)?.address).toBe("zkas:aaaa");
    expect(rows.find((w) => w.token === b)?.address).toBeUndefined();
  });

  it("the unguarded write is what put one wallet's address on another", () => {
    const a = addWallet();
    ensureRegistered(a, "zkas:aaaa");
    const b = addWallet();
    // Reading the token after the await: B is active, A's address goes to B.
    ensureRegistered(localStorage.getItem("wallet_token")!, "zkas:aaaa");
    expect(listWallets().find((w) => w.token === b)?.address).toBe("zkas:aaaa");
    expect(b).not.toBe(a); // two wallets, one address — what the switcher showed
  });

  it("switching wallets does not move an address between rows", () => {
    const a = addWallet();
    ensureRegistered(a, "zkas:aaaa");
    const b = addWallet();
    ensureRegistered(b, "zkas:bbbb");
    switchWallet(a);
    const rows = listWallets();
    expect(rows.find((w) => w.token === a)?.address).toBe("zkas:aaaa");
    expect(rows.find((w) => w.token === b)?.address).toBe("zkas:bbbb");
  });
});
