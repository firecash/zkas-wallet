import { describe, it, expect, beforeEach, vi } from "vitest";

// The upgrade notice is for people who UPGRADED from a version older than the one it describes
// (NOTICE_SINCE) — to whichever later version, however many releases they skipped. Version-
// based, not a per-release key: a fresh install never gets it, and each device sees it once.
// Written against NOTICE_SINCE (rc28 now) so the same rules hold for whichever notice is current.
let phone = true;
vi.mock("../src/embedded", () => ({ embeddedAvailable: () => phone, embeddedFastSync: () => true }));
import { shouldShowWhatsNew, markWhatsNewSeen, NOTICE_SINCE } from "../src/WhatsNew";

const LAST = "app_last_seen_version";
const NOW = NOTICE_SINCE; // "1.0.52-rc28"
const OLDER = ["1.0.39", "1.0.52-rc12", "1.0.52-rc22", "1.0.52-rc25", "1.0.52-rc27"];
const NEWER = ["1.0.52", "1.0.60", "1.1.0-rc1"];

describe("upgrade notice gate", () => {
  beforeEach(() => {
    localStorage.clear();
    phone = true;
  });

  it("is the rc28 notice", () => {
    expect(NOTICE_SINCE).toBe("1.0.52-rc28");
  });

  it("shows to an existing wallet that last ran an older version, whichever newer version it now runs", () => {
    for (const now of [NOW, ...NEWER]) {
      for (const last of OLDER) {
        localStorage.clear();
        localStorage.setItem(LAST, last);
        expect(shouldShowWhatsNew(true, now), `${last} -> ${now}`).toBe(true);
      }
    }
  });

  it("shows on the web and the desktop too, not only in the Android app", () => {
    phone = false;
    localStorage.setItem(LAST, "1.0.52-rc27");
    expect(shouldShowWhatsNew(true, NOW)).toBe(true);
  });

  it("shows when no version was ever recorded (the app predates recording, or the web never recorded one)", () => {
    expect(shouldShowWhatsNew(true, NOW)).toBe(true);
  });

  it("is shown once: after OK it records the version and stays away", () => {
    expect(shouldShowWhatsNew(true, NOW)).toBe(true);
    expect(shouldShowWhatsNew(true, NOW)).toBe(true); // still owed until dealt with
    markWhatsNewSeen(NOW);
    expect(shouldShowWhatsNew(true, NOW)).toBe(false);
    expect(shouldShowWhatsNew(true, "1.0.53")).toBe(false);
  });

  it("does not show to a device that already ran the notice's version or later", () => {
    for (const last of [NOTICE_SINCE, ...NEWER]) {
      localStorage.clear();
      localStorage.setItem(LAST, last);
      expect(shouldShowWhatsNew(true, NOW), last).toBe(false);
    }
  });

  it("reads a dismissal of the earlier, key-based card as having seen rc22 — so this notice is still owed", () => {
    localStorage.setItem("whatsnew_seen_v1_0_52_rc22_fastsync", "1");
    expect(shouldShowWhatsNew(true, NOW)).toBe(true);
    markWhatsNewSeen(NOW);
    expect(shouldShowWhatsNew(true, NOW)).toBe(false);
  });

  it("never shows to a fresh install, even after its first wallet exists", () => {
    expect(shouldShowWhatsNew(false, NOW)).toBe(false);
    expect(localStorage.getItem(LAST)).toBe(NOW);
    expect(shouldShowWhatsNew(true, NOW)).toBe(false);
  });

  it("is not owed by a build older than the notice, nor by a dev build", () => {
    expect(shouldShowWhatsNew(true, "1.0.52-rc27")).toBe(false);
    localStorage.clear();
    expect(shouldShowWhatsNew(true, "dev")).toBe(false);
  });
});
