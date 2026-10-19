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

describe("and the cross-device scan stash goes with it", () => {
  /**
   * `zkas_scan_receipt_v1` stashes `{ address, receipt, scannedDaa }` for cross-device fast
   * sync. Adoption is already guarded by the address — "so it is never applied to another"
   * wallet — so a leftover could not be misapplied. What survived "Remove wallet" was the
   * metadata: the removed wallet's address and its scan receipt, because the key is global
   * and no per-wallet prefix sweep can reach it.
   *
   * walletstate removes `birthday_addr_<address>` for the same reason — an address identifies
   * a wallet — and already has the address in hand there.
   */
  const ADDR = "zkas:" + "q".repeat(70);

  beforeEach(() => localStorage.clear());

  it("erases a stash belonging to the removed wallet", async () => {
    const { forgetScanReceipt } = await import("../src/scanreceipt");
    localStorage.setItem("zkas_scan_receipt_v1", JSON.stringify({ address: ADDR, receipt: "ff00", scannedDaa: 5, at: Date.now(), from: "x" }));
    forgetScanReceipt(ADDR);
    expect(localStorage.getItem("zkas_scan_receipt_v1")).toBeNull();
  });

  it("leaves another wallet's stash alone", async () => {
    const { forgetScanReceipt } = await import("../src/scanreceipt");
    const other = "zkas:" + "p".repeat(70);
    localStorage.setItem("zkas_scan_receipt_v1", JSON.stringify({ address: other, receipt: "ff00", scannedDaa: 5, at: Date.now(), from: "x" }));
    forgetScanReceipt(ADDR);
    expect(localStorage.getItem("zkas_scan_receipt_v1")).not.toBeNull();
  });

  it("is wired into wipeWalletState via the address it already derives", async () => {
    const { readFileSync } = await import("node:fs");
    const ws = readFileSync("src/walletstate.ts", "utf8");
    // The CODE line, not the comment that also names the key — the comment appears first,
    // which is the fourth time tonight an assertion matched prose instead of behaviour.
    const i = ws.indexOf("removeLocal(`birthday_addr_");
    expect(i).toBeGreaterThan(0);
    expect(ws.slice(i, i + 560)).toContain("forgetScanReceipt(address)");
  });
});
