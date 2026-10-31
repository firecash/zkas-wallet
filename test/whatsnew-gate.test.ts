import { describe, it, expect, beforeEach, vi } from "vitest";

// The upgrade notice is for people who UPGRADED: an existing wallet sees it once; a fresh
// install meets the same choices in first-run and must never get it after making a wallet.
vi.mock("../src/embedded", () => ({ embeddedAvailable: () => true, embeddedFastSync: () => true }));
import { shouldShowWhatsNew } from "../src/WhatsNew";

describe("upgrade notice gate", () => {
  beforeEach(() => localStorage.clear());

  it("shows once to an existing wallet", () => {
    expect(shouldShowWhatsNew(true)).toBe(true);
    expect(shouldShowWhatsNew(true)).toBe(true); // still unseen until dismissed
    localStorage.setItem("whatsnew_seen_v1_0_52_rc22_fastsync", "1");
    expect(shouldShowWhatsNew(true)).toBe(false);
  });

  it("never shows to a fresh install, even after its first wallet exists", () => {
    expect(shouldShowWhatsNew(false)).toBe(false);
    expect(shouldShowWhatsNew(true)).toBe(false);
  });

  it("is not blocked by having dismissed the previous notice", () => {
    localStorage.setItem("whatsnew_seen_v1_0_39_onphone", "1");
    expect(shouldShowWhatsNew(true)).toBe(true);
  });
});
