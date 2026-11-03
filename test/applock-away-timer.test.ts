import { afterEach, describe, expect, it, vi } from "vitest";
import { enableLock, installAutoLock, isUnlocked, lock, setLockAfterSetting } from "../src/applock";
import { setMasterMnemonic } from "../src/accounts";

// While the app is away past "Lock after", it locks then (the seed leaves memory), not only
// when the user comes back.
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("auto-lock while away", () => {
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
    lock();
    localStorage.clear();
  });

  it("locks once the time passes in the background, and not before", async () => {
    localStorage.clear();
    setMasterMnemonic(PHRASE);
    await enableLock("pw", "passphrase");
    expect(isUnlocked()).toBe(true);
    setLockAfterSetting(30);
    vi.useFakeTimers();
    let locked = 0;
    installAutoLock(() => locked++);
    setHidden(true);
    vi.advanceTimersByTime(20_000);
    expect(isUnlocked()).toBe(true);
    vi.advanceTimersByTime(11_000);
    expect(isUnlocked()).toBe(false);
    expect(locked).toBe(1);
  });

  it("a return before the time cancels it", async () => {
    localStorage.clear();
    setMasterMnemonic(PHRASE);
    await enableLock("pw", "passphrase");
    setLockAfterSetting(30);
    vi.useFakeTimers();
    let locked = 0;
    installAutoLock(() => locked++);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    setHidden(false);
    // Hidden at 0, back at 10 s: an uncancelled away timer would lock at 30.25 s. The open-app
    // idle lock (30 s without a touch, counted from the return) is not due until 40 s.
    vi.advanceTimersByTime(25_000);
    expect(isUnlocked()).toBe(true);
    expect(locked).toBe(0);
  });
});
