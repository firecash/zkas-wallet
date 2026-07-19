import { beforeEach, describe, expect, it } from "vitest";
import { ACCENTS, applyStoredTheme, currentAccent, setAccent } from "../src/theme";

describe("accent theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("defaults to teal — the ZKas identity — and stores nothing for it", () => {
    expect(currentAccent()).toBe("teal");
    setAccent("teal");
    expect(localStorage.getItem("accent")).toBeNull();
    // Teal defers to the stylesheet, so no inline override is written — this is what
    // keeps the light theme's contrast-tuned teal from being clobbered.
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe("");
  });

  it("a chosen accent persists and drives the CSS variables", () => {
    setAccent("violet");
    expect(currentAccent()).toBe("violet");
    expect(localStorage.getItem("accent")).toBe("violet");
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.violet.base);
    expect(document.documentElement.style.getPropertyValue("--ember-ink")).toBe(ACCENTS.violet.ink);
    // The soft tint is derived from the base, not stored separately.
    expect(document.documentElement.style.getPropertyValue("--ember-soft")).toContain("rgba(");
  });

  it("switching back to teal clears the inline overrides", () => {
    setAccent("amber");
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.amber.base);
    setAccent("teal");
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe("");
  });

  it("applyStoredTheme restores a persisted accent on load", () => {
    localStorage.setItem("accent", "rose");
    applyStoredTheme();
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.rose.base);
  });

  it("ignores a garbage stored accent", () => {
    localStorage.setItem("accent", "chartreuse");
    expect(currentAccent()).toBe("teal");
  });
});
