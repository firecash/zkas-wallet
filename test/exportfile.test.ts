import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exportFile, exportMessage } from "../src/exportfile";

// The bug these guard against: exporting was an `<a download>` click, which a browser
// honours and a Capacitor/Tauri WebView silently ignores. The button "worked" and
// produced nothing, with no error — so the tests that matter are the ones asserting
// something ALWAYS happens, and that we report which thing.

const origShare = (navigator as Navigator & { share?: unknown }).share;
const origCanShare = (navigator as Navigator & { canShare?: unknown }).canShare;
const origClipboard = navigator.clipboard;

function setNav(props: Record<string, unknown>) {
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(navigator, k, { value: v, configurable: true, writable: true });
  }
}

beforeEach(() => {
  setNav({ share: undefined, canShare: undefined, clipboard: undefined });
  // jsdom has no object URLs; the download path only needs these to not throw.
  globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  setNav({ share: origShare, canShare: origCanShare, clipboard: origClipboard });
  vi.restoreAllMocks();
});

describe("getting a file out of the wallet on any platform", () => {
  it("uses the native share sheet when it can take a file", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNav({ share, canShare: () => true });
    expect(await exportFile("a.csv", "text/csv", "x,y")).toBe("shared");
    expect(share).toHaveBeenCalled();
  });

  // Dismissing the share sheet is a decision, not a failure. Treating it as failure
  // would quietly dump an encrypted wallet backup onto the clipboard of a user who
  // just chose not to export it.
  it("treats a dismissed share sheet as done, not as a reason to copy the backup", async () => {
    const err = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav({ share: vi.fn().mockRejectedValue(err), canShare: () => true, clipboard: { writeText } });
    expect(await exportFile("b.json", "application/json", "{}")).toBe("shared");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when sharing is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav({ clipboard: { writeText } });
    expect(await exportFile("c.csv", "text/csv", "hello")).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  // The whole point: on a shell with neither share nor clipboard, it must still do
  // SOMETHING rather than return quietly having done nothing.
  it("always reports a route, never silently does nothing", async () => {
    const outcome = await exportFile("d.csv", "text/csv", "z");
    expect(["shared", "copied", "downloaded"]).toContain(outcome);
  });

  it("never claims a file was saved when it was only copied", () => {
    expect(exportMessage("copied", "w.json")).toMatch(/clipboard/i);
    expect(exportMessage("copied", "w.json")).not.toMatch(/downloads/i);
    expect(exportMessage("downloaded", "w.json")).toMatch(/downloads/i);
    expect(exportMessage("shared", "w.json")).toMatch(/save or send/i);
  });
});
