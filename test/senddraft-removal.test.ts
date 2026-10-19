import { beforeEach, describe, expect, it } from "vitest";
import { forgetSendDraft, loadSendDraft, saveSendDraft } from "../src/lib/senddraft";
import { wipeWalletState } from "../src/walletstate";

/**
 * A send draft holds the recipient address, the amount and the memo — who you were about to
 * pay and what for. That is the same category of metadata as a contact name or a transaction
 * label, and `walletstate` erases both of those on "Remove wallet", on the stated premise that
 * "every one of those has to go together".
 *
 * This key was missed for the same reason the transaction labels were (#58): it is GLOBAL
 * (`send_draft_v1`, with the token stored inside the value), so no per-wallet prefix sweep
 * could match it. `loadSendDraft` already refuses a draft whose token does not match, so
 * nothing leaked into the next wallet's form — what survived was the metadata itself, at rest,
 * for up to its 24-hour life, after the user had deliberately removed the wallet.
 */
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const draft = { to: "zkas:" + "q".repeat(70), amount: "1.25", memo: "rent" };

describe("removing a wallet erases what it was about to pay", () => {
  beforeEach(() => localStorage.clear());

  it("wipeWalletState clears that wallet's draft", () => {
    localStorage.setItem("wallet_token", A);
    saveSendDraft(A, draft);
    expect(loadSendDraft(A)?.to).toBe(draft.to);

    wipeWalletState(A);

    // Not merely unreadable — gone from storage, memo and all.
    expect(loadSendDraft(A)).toBeNull();
    const all = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? "").join("|");
    expect(all).not.toContain("rent");
    expect(all).not.toContain(draft.to);
  });

  it("does not touch another wallet's draft", () => {
    // Removing wallet A must not erase what wallet B was about to pay.
    localStorage.setItem("wallet_token", B);
    saveSendDraft(B, draft);
    forgetSendDraft(A);
    expect(loadSendDraft(B)?.amount).toBe("1.25");
  });

  it("is harmless with no draft, no token, or blocked storage", () => {
    expect(() => forgetSendDraft(A)).not.toThrow();
    expect(() => forgetSendDraft("")).not.toThrow();
  });
});
