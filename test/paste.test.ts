import { afterEach, describe, expect, it, vi } from "vitest";
import { pasteText } from "../src/lib/utils";

// The bug this exists for: Android's WebView does not implement clipboard READ, so the
// web path can never work there — and the app shipped THREE clipboard readers, only one
// of which was fixed. The Paste button used a private copy in App.tsx and kept failing
// with "this browser won't share the clipboard" in an app that is not a browser.
describe("reading the clipboard in the native shell", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("asks the platform plugin when running natively", async () => {
    const read = vi.fn().mockResolvedValue({ value: "  zkas:pqabc  " });
    vi.doMock("@capacitor/clipboard", () => ({ Clipboard: { read } }));
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    // Re-import so the mock applies to the dynamic import inside pasteText.
    const { pasteText: nativePaste } = await import("../src/lib/utils");
    await expect(nativePaste()).resolves.toEqual({ ok: true, text: "zkas:pqabc" });
    expect(read).toHaveBeenCalled();
  });

  it("reports an empty clipboard as empty, not as a failure", async () => {
    vi.doMock("@capacitor/clipboard", () => ({ Clipboard: { read: vi.fn().mockResolvedValue({ value: "   " }) } }));
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    const { pasteText: nativePaste } = await import("../src/lib/utils");
    await expect(nativePaste()).resolves.toEqual({ ok: false, reason: "empty" });
  });

  // In a real browser the standard api is still the right one.
  it("uses the web clipboard when not native", async () => {
    vi.stubGlobal("Capacitor", undefined);
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn().mockResolvedValue("zkas:pqweb") } });
    await expect(pasteText()).resolves.toEqual({ ok: true, text: "zkas:pqweb" });
  });
});
