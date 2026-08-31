import { beforeEach, describe, expect, it } from "vitest";
import { enableLock, unlock, lock, disableLock, isUnlocked } from "../src/applock";
import { masterMnemonic, setMasterMnemonic } from "../src/accounts";

// OB-ZKW-01 regression: the device master recovery phrase (derives every account)
// must be sealed under App Lock exactly like a per-wallet seed — never left in the
// clear at `device_mnemonic` while the app is locked.
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("app lock seals the master mnemonic", () => {
  beforeEach(() => {
    localStorage.clear();
    lock();
  });

  it("removes the plaintext phrase when the lock is enabled, and hides it while locked", async () => {
    setMasterMnemonic(PHRASE);
    expect(localStorage.getItem("device_mnemonic")).toBe(PHRASE); // no lock yet

    await enableLock("correct horse", "passphrase");
    expect(localStorage.getItem("device_mnemonic")).toBeNull(); // plaintext gone
    expect(masterMnemonic()).toBe(PHRASE); // still usable this session

    lock();
    expect(masterMnemonic()).toBe(""); // sealed, nothing readable while locked

    expect(await unlock("wrong")).toBe(false);
    expect(masterMnemonic()).toBe(""); // a wrong attempt reveals nothing

    expect(await unlock("correct horse")).toBe(true);
    expect(masterMnemonic()).toBe(PHRASE); // correct secret restores it
  });

  it("migrates a pre-existing plaintext phrase to sealed on first unlock", async () => {
    // Simulate the old world: a lock exists, but the phrase was written plaintext
    // before sealing covered it.
    await enableLock("s3cret", "passphrase");
    localStorage.setItem("device_mnemonic", PHRASE);
    lock();

    expect(await unlock("s3cret")).toBe(true);
    expect(localStorage.getItem("device_mnemonic")).toBeNull(); // migrated + removed
    expect(masterMnemonic()).toBe(PHRASE);
  });

  it("restores the plaintext phrase when the lock is disabled", async () => {
    setMasterMnemonic(PHRASE);
    await enableLock("pw", "passphrase");
    expect(localStorage.getItem("device_mnemonic")).toBeNull();
    expect(await disableLock("pw")).toBe(true);
    expect(localStorage.getItem("device_mnemonic")).toBe(PHRASE);
    expect(isUnlocked()).toBe(true);
  });
});

describe("OB-ZKW-02: plaintext fallbacks heal on unlock", () => {
  beforeEach(() => { localStorage.clear(); lock(); });
  it("re-seals a seed_unsealed_ fallback and removes the cleartext", async () => {
    await enableLock("pw", "passphrase");
    // simulate a seal that raced an auto-lock: plaintext seed + flag left behind
    localStorage.setItem("device_seed_deadbeef", "a".repeat(64));
    localStorage.setItem("seed_unsealed_deadbeef", "1");
    lock();
    expect(await unlock("pw")).toBe(true);
    expect(localStorage.getItem("device_seed_deadbeef")).toBeNull();
    expect(localStorage.getItem("seed_unsealed_deadbeef")).toBeNull();
    // and after a full lock+unlock cycle it is served from the sealed record
    lock();
    expect(await unlock("pw")).toBe(true);
  });
});
