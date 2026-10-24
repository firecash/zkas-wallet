import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCENTS, DEFAULT_ACCENT, applyStoredTheme, currentAccent, currentTheme, setAccent, setTheme } from "../src/theme";

describe("accent theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("defaults to the identity accent — storing nothing and overriding nothing", () => {
    expect(currentAccent()).toBe(DEFAULT_ACCENT);
    setAccent(DEFAULT_ACCENT);
    expect(localStorage.getItem("accent")).toBeNull();
    // The default defers to the stylesheet, so NOT ONE inline override is written.
    // This is the property that keeps light mode readable: light ships its own
    // darker shade of the identity accent, and the dark-mode shade measures 1.70:1
    // on white. An inline override here would force the bright one onto both themes.
    //
    // Asserted across every property applyAccent can set, not just --ember: the
    // override that broke this also wrote --ember-ink, which --ember alone would miss.
    for (const prop of ["--ember", "--ember-hover", "--ember-ink", "--ember-soft", "--ember-rgb", "--glow-1", "--glow-2"]) {
      expect(document.documentElement.style.getPropertyValue(prop)).toBe("");
    }
  });

  it("clears a previous accent's overrides when switching back to the default", () => {
    setAccent("violet");
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.violet.base);
    setAccent(DEFAULT_ACCENT);
    // Switching back must REMOVE them, not overwrite them with the dark-mode shade —
    // otherwise light mode keeps a hardcoded accent for the rest of the session.
    for (const prop of ["--ember", "--ember-ink", "--ember-rgb"]) {
      expect(document.documentElement.style.getPropertyValue(prop)).toBe("");
    }
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

  it("teal is now an ordinary chosen accent, and is PERSISTED like one", () => {
    // Teal used to be the identity, so it stored nothing and cleared its overrides.
    // It is now a choice like any other, and that distinction protects existing
    // users: someone who deliberately picked teal must keep teal once the default
    // moves to green. That only holds if teal is written down and applied.
    setAccent("amber");
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.amber.base);
    setAccent("teal");
    expect(localStorage.getItem("accent")).toBe("teal");
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.teal.base);
    expect(document.documentElement.style.getPropertyValue("--ember-ink")).toBe(ACCENTS.teal.ink);
  });

  it("a stored teal survives a reload, rather than falling back to the new default", () => {
    // Post-rebrand: the marker is set, so this teal was chosen WITH green on screen.
    localStorage.setItem("accent.rebrand.green", "1");
    localStorage.setItem("accent", "teal");
    applyStoredTheme();
    expect(currentAccent()).toBe("teal");
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.teal.base);
  });

  it("applyStoredTheme restores a persisted accent on load", () => {
    localStorage.setItem("accent.rebrand.green", "1");
    localStorage.setItem("accent", "rose");
    applyStoredTheme();
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.rose.base);
  });

  it("the rebrand clears a pre-rebrand accent ONCE, so the new identity is actually seen", () => {
    // Reported as "0 done": the ground changed but every highlight stayed the old
    // colour, because an accent chosen against the previous identity was still stored.
    localStorage.setItem("accent", "ice");
    applyStoredTheme();
    expect(currentAccent()).toBe(DEFAULT_ACCENT);
    expect(localStorage.getItem("accent")).toBeNull();
    expect(localStorage.getItem("accent.rebrand.green")).toBe("1");
  });

  it("but a choice made AFTER the rebrand is kept for good", () => {
    localStorage.setItem("accent.rebrand.green", "1");
    setAccent("ice");
    applyStoredTheme();
    expect(currentAccent()).toBe("ice");
    expect(localStorage.getItem("accent")).toBe("ice");
    // And it must still be APPLIED, not just remembered.
    expect(document.documentElement.style.getPropertyValue("--ember")).toBe(ACCENTS.ice.base);
  });

  it("ignores a garbage stored accent", () => {
    localStorage.setItem("accent", "chartreuse");
    expect(currentAccent()).toBe(DEFAULT_ACCENT);
  });
});

describe("light/dark/system theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to dark and stores nothing for it", () => {
    expect(currentTheme()).toBe("dark");
    setTheme("dark");
    expect(localStorage.getItem("theme")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("light persists and stamps data-theme", () => {
    setTheme("light");
    expect(currentTheme()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("system resolves against the OS and only tracks it when chosen", () => {
    // Pretend the OS prefers light.
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("light"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    setTheme("system");
    expect(currentTheme()).toBe("system");
    expect(localStorage.getItem("theme")).toBe("system");
    // System + OS-light → painted light.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    vi.unstubAllGlobals();
  });
});
