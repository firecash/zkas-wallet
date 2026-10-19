import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Choosing a theme is a click handler, and `setTheme` wrote with a raw `localStorage.setItem`
 * BEFORE calling `apply()`. On a browser with site data blocked that write throws, the
 * exception escapes the handler, and `apply` is never reached — so tapping a theme did nothing
 * at all, not even visually.
 *
 * `switchWallet` records the identical failure in almost the same words: "a raw setItem threw
 * out of the click handler that called this, so on a browser with storage blocked tapping
 * another wallet did nothing at all".
 */
describe("the theme still changes when storage is blocked", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-accent");
  });

  it("does not throw out of the caller", async () => {
    const { setTheme, setAccent } = await import("../src/theme");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => setTheme("light")).not.toThrow();
    expect(() => setAccent("violet" as never)).not.toThrow();
  });

  it("still PAINTS the choice when it cannot be persisted", async () => {
    const { setTheme } = await import("../src/theme");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    setTheme("light");
    // The visual change is the part the user asked for; persistence is a bonus.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("remembers the choice for the session via safestore", async () => {
    const theme = await import("../src/theme");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    theme.setTheme("system");
    // A raw read would miss what safestore held, and the picker would snap back.
    expect(theme.currentTheme()).toBe("system");
  });

  it("round-trips normally when storage works", async () => {
    const theme = await import("../src/theme");
    theme.setTheme("light");
    expect(theme.currentTheme()).toBe("light");
    theme.setTheme("dark");
    expect(theme.currentTheme()).toBe("dark");
  });

  it("uses no raw accessor for these keys", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/theme.ts", "utf8")).not.toMatch(/localStorage\.(get|set|remove)Item/);
  });
});
