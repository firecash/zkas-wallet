// The version, as support actually needs it.
//
// A release number alone does not identify what someone is running: the web can
// be redeployed ahead of a tagged release, so two people "on 1.0.22" may not have
// the same code. Version + platform + build stamp does identify it.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  delete (globalThis as Record<string, unknown>).Capacitor;
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("version reporting", () => {
  it("reports the version vite baked in, not a hardcoded string", async () => {
    const { APP_VERSION, versionTag } = await import("../src/version");
    // Matches package.json because vite.config.ts injects it from there.
    const pkg = (await import("../package.json")).default as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(versionTag()).toBe(`v${pkg.version}`);
  });

  it("carries a build stamp, which is what separates two builds of one version", async () => {
    const { APP_BUILT } = await import("../src/version");
    expect(APP_BUILT).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("names the platform it is running on", async () => {
    const { platformName } = await import("../src/version");
    expect(platformName()).toBe("Web");

    vi.resetModules();
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const desktop = await import("../src/version");
    expect(desktop.platformName()).toBe("Desktop");

    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    };
    const android = await import("../src/version");
    expect(android.platformName()).toBe("Android");
  });

  it("puts everything a bug report needs on one copyable line", async () => {
    const { versionLine, APP_VERSION, APP_BUILT } = await import("../src/version");
    const line = versionLine();
    expect(line).toContain(APP_VERSION);
    expect(line).toContain("Web");
    expect(line).toContain(APP_BUILT);
  });
});
