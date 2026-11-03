import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `lastTotalSompi` is ONE global key in the background worker's SharedPreferences, and the app
 * switches wallets. So the baseline could be wallet A's while the status being compared was
 * wallet B's:
 *
 *   A holds 5 → baseline 500000000. User switches to B, which holds 100. Next run compares
 *   10000000000 against 500000000 and announces "95 ZKAS arrived in your wallet."
 *
 * A payment that never happened, on the lock screen. The file's own first-run rule is already
 * the right one — "announcing the whole balance as 'received' is exactly the lie the in-app
 * announcement avoids too" — it just had no way to tell that a switch IS a first run.
 *
 * The widget read the same key, so it showed the previous wallet's balance on the home screen
 * until the next background run.
 */
const worker = readFileSync("android/app/src/main/java/com/firecash/wallet/SyncWorker.java", "utf8");
const widget = readFileSync("android/app/src/main/java/com/firecash/wallet/WalletWidget.java", "utf8");

describe("a background balance baseline belongs to one wallet", () => {
  it("records which wallet the baseline is for, alongside it", () => {
    expect(worker).toMatch(/\.putString\("baselineToken", token\)/);
    // Written in the SAME edit as the balance, so the two cannot disagree.
    const i = worker.indexOf('putString("lastTotalSompi"');
    expect(worker.slice(i, i + 200)).toContain('putString("baselineToken"');
  });

  it("announces only when the baseline is this wallet's", () => {
    expect(worker).toMatch(/if \(last != null && baselineToken\.equals\(token\)\) \{/);
  });

  it("still records the new baseline on a switch rather than announcing it", () => {
    // The write is unconditional and precedes the guard, so the switched-to wallet has a
    // correct baseline from its very first run and its next real receipt is measured right.
    const write = worker.indexOf('putString("lastTotalSompi"');
    const guard = worker.indexOf("baselineToken.equals(token)");
    expect(write).toBeGreaterThan(0);
    expect(write).toBeLessThan(guard);
  });

  it("passes the token in, since the baseline cannot be attributed without it", () => {
    expect(worker).toMatch(/private void processStatus\(SharedPreferences p, JSONObject status, String token\)/);
    expect(worker).toMatch(/processStatus\(p, status, token\);/);
  });

  it("keeps the widget from showing another wallet's balance", () => {
    expect(widget).toMatch(/baselineToken\.equals\(prefs\.getString\("token", ""\)\)/);
    // Falls back to the existing "Open to sync" copy rather than inventing a state.
    expect(widget).toContain("sompi = null;");
    expect(widget).toContain("String balance = context.getString(R.string.widget_open_to_sync);");
    expect(readFileSync("android/app/src/main/res/values/strings.xml", "utf8")).toMatch(/name="widget_open_to_sync">Open to sync</);
  });
});
