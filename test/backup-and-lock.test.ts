import { describe, it, expect, beforeEach, vi } from "vitest";

// Two independent fund-loss paths found by driving onboarding.
describe("a wallet cannot quietly end up with no backup and no lock", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  // One tap on "Explore" — the nav sits 40px under the card and is live — or a
  // plain reload used to destroy the backup screen for good. The phrase had never
  // been revealed, the quiz never ran, and nothing recorded that it was skipped:
  // `main.tsx` claims "which is why the backup nag exists" and no nag exists.
  it("remembers that a phrase was never written down, across a reload", async () => {
    const { markBackupPending, backupPending, clearBackupPending } = await import("../src/lib/deviceseed");
    expect(backupPending("tok")).toBeNull();
    markBackupPending("tok", "zkas:pabc");
    expect(backupPending("tok"), "must survive leaving the screen").toBe("zkas:pabc");
    clearBackupPending("tok");
    expect(backupPending("tok"), "cleared only by finishing the backup").toBeNull();
  });

  it("forgets it when the wallet is removed", async () => {
    const { markBackupPending, backupPending } = await import("../src/lib/deviceseed");
    markBackupPending("tok", "zkas:pabc");
    const { wipeWalletState } = await import("../src/walletstate");
    wipeWalletState("tok");
    expect(backupPending("tok")).toBeNull();
  });

  // Removing the last wallet left `{"version":2,"kind":"pin","wallets":{}}`.
  // `unlock()` has a `nothingToVerify` branch, so that record accepted ANY PIN and
  // then held it as the session secret — sealing the NEXT wallet's seed and master
  // phrase under a string typed once, blind, with no confirm field. The real PIN
  // was refused forever.
  it("does not keep a lock record that can only ever accept a wrong secret", async () => {
    const { isLockEnabled } = await import("../src/applock");
    localStorage.setItem("app_lock_v2", JSON.stringify({ version: 2, kind: "pin", wallets: {} }));
    expect(isLockEnabled(), "an empty record protects nothing and must not gate the app").toBe(false);
  });

  it("still reports a lock that genuinely seals something", async () => {
    const { isLockEnabled } = await import("../src/applock");
    localStorage.setItem(
      "app_lock_v2",
      JSON.stringify({ version: 2, kind: "pin", wallets: { tok: { salt: "00", nonce: "00", ct: "00" } } }),
    );
    expect(isLockEnabled()).toBe(true);
  });
});
