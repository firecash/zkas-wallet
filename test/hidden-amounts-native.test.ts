import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The JS path is careful about this, and says so: "The eye toggle masks the balance to ••••••
 * precisely so someone glancing cannot read it. Announcing the exact figure in a toast at the
 * top of the screen — and in an OS notification on the lock screen — defeated that completely
 * … Hidden means hidden: the arrival is still announced, the amount is not."
 *
 * Two NATIVE surfaces never got that memo, and they are the two that matter most:
 *   SyncWorker.notifyPayment  — fires while the app is CLOSED, i.e. onto a lock screen
 *   WalletWidget              — sits on the HOME SCREEN
 * Both read their own SharedPreferences and were never told about the toggle.
 */
const bg = readFileSync("src/bgsync.ts", "utf8");
const plugin = readFileSync("android/app/src/main/java/com/firecash/wallet/BackgroundSyncPlugin.java", "utf8");
const worker = readFileSync("android/app/src/main/java/com/firecash/wallet/SyncWorker.java", "utf8");
const widget = readFileSync("android/app/src/main/java/com/firecash/wallet/WalletWidget.java", "utf8");

describe("hidden balances stay hidden on the lock screen and the home screen", () => {
  it("every configure call carries the flag", () => {
    const calls = bg.match(/Native\.configure\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect((bg.match(/hideAmounts: balancesHidden\(\)/g) ?? []).length).toBe(calls.length);
  });

  it("the plugin persists it where both native readers look", () => {
    expect(plugin).toMatch(/call\.getBoolean\("hideAmounts", false\)/);
    expect(plugin).toMatch(/\.putBoolean\("hideAmounts", hideAmounts\)/);
  });

  it("the notification omits the figure but still announces the arrival", () => {
    // Anchor on the PAYMENT notification: the first setContentText in this file belongs to
    // the foreground-service notice, which carries no amount at all.
    const i = worker.indexOf('ZKAS arrived in your wallet.');
    expect(i).toBeGreaterThan(0);
    expect(worker.slice(i - 420, i + 60)).toContain("hideAmounts()");
    // Still tells the user something arrived — hiding must not mean silence.
    expect(worker).toMatch(/A payment arrived in your wallet\./);
    expect(worker).toMatch(/amountZkas \+ " ZKAS arrived in your wallet\."/);
  });

  it("the widget masks the balance but keeps the widget", () => {
    expect(widget).toMatch(/prefs\.getBoolean\("hideAmounts", false\)/);
    expect(widget).toMatch(/hidden \? "•+ ZKAS"/);
  });

  it("toggling the eye reaches native at once, not at the next unrelated event", () => {
    // Without this the lock-screen notification kept showing figures until a send or a
    // relaunch happened to reconfigure — exactly the window after someone decides to hide.
    expect(bg).toContain("onHideBalancesChange(");
    const i = bg.indexOf("onHideBalancesChange(");
    expect(bg.slice(i, i + 120)).toContain("bgSyncReconfigure()");
  });
});
