import { describe, it, expect, beforeEach } from "vitest";
import { shouldAutoLock, lockAfterSetting, setLockAfterSetting, DEFAULT_LOCK_AFTER_S, MAX_LOCK_AFTER_S } from "../src/applock";

const s = (n: number) => n * 1000;

describe("App lock: Lock after", () => {
  beforeEach(() => localStorage.clear());

  it("by default locks only after 90 s away, never while the app is open and in use", () => {
    expect(lockAfterSetting()).toBeNull();
    expect(shouldAutoLock(null, s(DEFAULT_LOCK_AFTER_S - 1), null)).toBe(false);
    expect(shouldAutoLock(null, s(DEFAULT_LOCK_AFTER_S), null)).toBe(true);
    expect(shouldAutoLock(null, null, s(3600))).toBe(false); // an hour untouched while open: no lock by default
  });

  it("a chosen time locks after that long away or that long untouched while open", () => {
    expect(shouldAutoLock(30, s(29), null)).toBe(false);
    expect(shouldAutoLock(30, s(30), null)).toBe(true);
    expect(shouldAutoLock(30, null, s(29))).toBe(false);
    expect(shouldAutoLock(30, null, s(30))).toBe(true);
  });

  it("returning before the time is up does not lock, whatever the setting", () => {
    for (const setting of [null, 1, 30, 600]) expect(shouldAutoLock(setting, 0, null), String(setting)).toBe(false);
  });

  it("0 locks on leaving the app, never while it is open", () => {
    expect(shouldAutoLock(0, null, s(3600))).toBe(false); // open and untouched for an hour: still unlocked
    expect(shouldAutoLock(0, null, 0)).toBe(false); // open right now: never locks under the user's hands
    expect(shouldAutoLock(0, 1, null)).toBe(true); // away even briefly: locked
  });

  it("stores whole seconds within 0..a day, and empty returns to the default", () => {
    setLockAfterSetting(45.7);
    expect(lockAfterSetting()).toBe(45);
    setLockAfterSetting(MAX_LOCK_AFTER_S + 100);
    expect(lockAfterSetting()).toBe(MAX_LOCK_AFTER_S);
    setLockAfterSetting(-5);
    expect(lockAfterSetting()).toBe(0);
    setLockAfterSetting(null);
    expect(lockAfterSetting()).toBeNull();
    localStorage.setItem("app_lock_after_s", "nonsense");
    expect(lockAfterSetting()).toBeNull();
  });
});
