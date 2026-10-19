import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Stopping the embedded engine drains and flushes it. The foreground service is the only thing
 * keeping the process alive while that happens, and the service's own timeout path spells out
 * the cost of losing it: "a flush discards everything since the last checkpoint — the same
 * loss that made a sync look like it restarted."
 *
 * `EngineControl.stopEngine` gets this right — engine, then service — and `onTimeout` uses it.
 * The plugin's `stop()` had the opposite order: service first, flush afterwards on a
 * background thread, with the process no longer foreground and the app usually already behind.
 */
const plugin = readFileSync("android/app/src/main/java/com/firecash/wallet/EmbeddedEnginePlugin.kt", "utf8");
const control = readFileSync("android/app/src/main/java/com/firecash/wallet/EngineControl.kt", "utf8");
const service = readFileSync("android/app/src/main/java/com/firecash/wallet/EngineForegroundService.kt", "utf8");

describe("the engine flushes while the process is still protected", () => {
  it("stopEngine keeps the right order", () => {
    const i = control.indexOf("fun stopEngine");
    const body = control.slice(i, i + 260);
    expect(body.indexOf("zkas_walletd_mobile.stop()")).toBeLessThan(body.indexOf("EngineForegroundService.stop(ctx)"));
  });

  it("the plugin defers to it instead of keeping a second copy", () => {
    const i = plugin.indexOf("fun stop(call: PluginCall)");
    const body = plugin.slice(i, i + 220);
    expect(body).toContain("EngineControl.stopEngine(context)");
    // The old order — service down first — must not come back.
    expect(body).not.toContain("EngineForegroundService.stop(context)");
  });

  it("still does it off the main thread", () => {
    // A UniFFI drain on the main thread is an ANR; that part was right before.
    const i = plugin.indexOf("fun stop(call: PluginCall)");
    const body = plugin.slice(i, i + 220);
    expect(body).toContain("Thread {");
    expect(body.indexOf("Thread {")).toBeLessThan(body.indexOf("EngineControl.stopEngine"));
  });

  it("the service's timeout path uses the same helper", () => {
    const i = service.indexOf("override fun onTimeout");
    expect(service.slice(i, i + 320)).toContain("EngineControl.stopEngine(applicationContext)");
  });
});
