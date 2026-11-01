import { describe, it, expect, beforeEach, vi } from "vitest";

// The upgrade notice is for people who UPGRADED from a version older than the one it describes
// (NOTICE_SINCE) — to whichever later version, however many releases they skipped. Version-
// based, not a per-release key: a fresh install never gets it, and each device sees it once.
vi.mock("../src/embedded", () => ({ embeddedAvailable: () => true, embeddedFastSync: () => true }));
import { shouldShowWhatsNew, markWhatsNewSeen, NOTICE_SINCE } from "../src/WhatsNew";

const LAST = "app_last_seen_version";

describe("upgrade notice gate", () => {
  beforeEach(() => localStorage.clear());

  it("shows to an existing wallet that last ran an older version, whichever newer version it now runs", () => {
    for (const now of ["1.0.52-rc25", "1.0.52-rc26", "1.0.52", "1.0.60", "1.1.0-rc1"]) {
      for (const last of ["1.0.39", "1.0.52-rc12", "1.0.52-rc21", "1.0.52-rc24"]) {
        localStorage.clear();
        localStorage.setItem(LAST, last);
        expect(shouldShowWhatsNew(true, now), `${last} -> ${now}`).toBe(true);
      }
    }
  });

  it("shows when no version was ever recorded (the app predates recording)", () => {
    expect(shouldShowWhatsNew(true, "1.0.52-rc25")).toBe(true);
  });

  it("is shown once: after OK it records the version and stays away", () => {
    expect(shouldShowWhatsNew(true, "1.0.52-rc25")).toBe(true);
    expect(shouldShowWhatsNew(true, "1.0.52-rc25")).toBe(true); // still owed until dealt with
    markWhatsNewSeen("1.0.52-rc25");
    expect(shouldShowWhatsNew(true, "1.0.52-rc25")).toBe(false);
    expect(shouldShowWhatsNew(true, "1.0.53")).toBe(false);
  });

  it("does not show to a device that already ran the notice's version or later", () => {
    for (const last of [NOTICE_SINCE, "1.0.52-rc26", "1.0.52", "1.0.70"]) {
      localStorage.clear();
      localStorage.setItem(LAST, last);
      expect(shouldShowWhatsNew(true, "1.0.52-rc25"), last).toBe(false);
    }
  });

  it("reads a dismissal of the earlier, key-based card as having seen rc22 — so the rc25 notice is still owed", () => {
    localStorage.setItem("whatsnew_seen_v1_0_52_rc22_fastsync", "1");
    expect(shouldShowWhatsNew(true, "1.0.52-rc25")).toBe(true);
    markWhatsNewSeen("1.0.52-rc25");
    expect(shouldShowWhatsNew(true, "1.0.52-rc25")).toBe(false);
  });

  it("never shows to a fresh install, even after its first wallet exists", () => {
    expect(shouldShowWhatsNew(false, "1.0.52-rc25")).toBe(false);
    expect(localStorage.getItem(LAST)).toBe("1.0.52-rc25");
    expect(shouldShowWhatsNew(true, "1.0.52-rc25")).toBe(false);
  });

  it("is not owed by a build older than the notice, nor by a dev build", () => {
    expect(shouldShowWhatsNew(true, "1.0.52-rc24")).toBe(false);
    localStorage.clear();
    expect(shouldShowWhatsNew(true, "dev")).toBe(false);
  });
});
