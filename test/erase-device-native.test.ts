import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "Erase this device" on the lock screen is the panic path. It wipes every wallet's state, the
 * master phrase, the registry, the account counter, the sealed lock record and the biometric
 * binding — the handler's own comment records fixing exactly this class once already: "without
 * this the flag survived an erase while the secret it unlocks no longer opens anything".
 *
 * The native background worker was the next one. Its SharedPreferences hold the wallet token,
 * the daemon bearer, the last known balance and `enabled`, none of them in localStorage and
 * none reachable by that sweep. Left alone it keeps asking the daemon about a wallet the user
 * has just erased — possibly under duress — and can still put a payment on the lock screen.
 */
const lock = readFileSync("src/AppLockScreen.tsx", "utf8");
const bg = readFileSync("src/bgsync.ts", "utf8");
const plugin = readFileSync("android/app/src/main/java/com/firecash/wallet/BackgroundSyncPlugin.java", "utf8");

describe("erasing the device erases the background worker too", () => {
  it("forgets the worker on the panic path", () => {
    const i = lock.indexOf("bgSyncForget()");
    expect(i).toBeGreaterThan(0);
    expect(lock).toContain('import { bgSyncForget } from "./bgsync";');
  });

  it("does it BEFORE the reload, not after", () => {
    // A panic wipe must not depend on the app coming back up to finish erasing.
    const forget = lock.indexOf("bgSyncForget()");
    const reload = lock.indexOf("location.reload()", forget - 600);
    expect(forget).toBeLessThan(reload);
    expect(lock.slice(forget - 20, forget + 20)).toContain("await");
  });

  it("clears the stored credentials rather than only cancelling the schedule", () => {
    // `disable` deliberately keeps the configuration so re-enabling is cheap; that is exactly
    // what makes it the wrong call here.
    const i = plugin.indexOf("public void forget(");
    expect(i).toBeGreaterThan(0);
    const body = plugin.slice(i, i + 420);
    expect(body).toContain("prefs().edit().clear().apply()");
    expect(body).toContain("cancelUniqueWork(WORK_NAME)");
    expect(body).toContain("cancelUniqueWork(WORK_NOW)");
    // And the home screen stops showing a balance for a wallet that is gone.
    expect(body).toContain("WalletWidget.refreshAll");
  });

  it("stays safe where the plugin does not exist", () => {
    const i = bg.indexOf("export async function bgSyncForget");
    const body = bg.slice(i, i + 460);
    expect(body).toContain("if (!bgSyncAvailable()) return;");
    expect(body).toContain("catch");
    // The localStorage flag goes either way, so the UI cannot show it as still on.
    expect(body).toContain("removeLocal(FLAG)");
  });

  it("leaves the ordinary disable path alone", () => {
    const i = bg.indexOf("export async function bgSyncDisable");
    expect(bg.slice(i, i + 160)).toContain("Native.disable()");
    expect(bg.slice(i, i + 160)).not.toContain("Native.forget()");
  });
});
