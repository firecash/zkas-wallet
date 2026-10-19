import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The device master phrase derives EVERY account on the device. `setMasterMnemonic` used to
 * return void and swallow a storage failure, reasoning that "the caller still holds the
 * phrase to show the user" — which is true of the caller and false of the device.
 *
 * After a silent failure `hasMaster()` reads false, so the next wallet created becomes a
 * second "first" master, while the first wallet has already been recorded as account 0 of the
 * phrase that was never stored. One device, two masters, and an account mapping pointing at
 * the missing one.
 *
 * `persistDeviceSeed`, ten lines away in the same creation path, already had the right
 * contract and says why: "Prove it. A wallet whose key did not land is a wallet that can
 * RECEIVE and never spend ... so the caller must be able to refuse to create it."
 */
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("the master phrase is proven stored, not assumed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  it("returns true and stores the phrase when storage works", async () => {
    const { setMasterMnemonic, masterMnemonic, hasMaster } = await import("../src/accounts");
    expect(await setMasterMnemonic(PHRASE)).toBe(true);
    expect(masterMnemonic()).toBe(PHRASE);
    expect(hasMaster()).toBe(true);
  });

  it("returns FALSE when the write is refused, instead of swallowing it", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const { setMasterMnemonic } = await import("../src/accounts");
    expect(await setMasterMnemonic(PHRASE)).toBe(false);
  });

  it("refuses an empty phrase", async () => {
    const { setMasterMnemonic } = await import("../src/accounts");
    expect(await setMasterMnemonic("   ")).toBe(false);
  });

  it("does not claim a token as account 0 of a master that did not persist", async () => {
    // adoptExistingPhrase records the mapping that makes a wallet "an account of" the
    // phrase. Writing it against a phrase that was not stored is the corrupt state.
    const token = "cafe".repeat(8);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const accounts = await import("../src/accounts");
    await accounts.adoptExistingPhrase(token, PHRASE);
    vi.restoreAllMocks();
    expect(accounts.accountOf(token)).toBeNull();
  });

  it("creation refuses to proceed when the master cannot be stored", async () => {
    // The call site mirrors persistDeviceSeed's: throw onboard.errStore rather than build a
    // wallet recorded against a phrase the device does not have.
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("src/App.tsx", "utf8");
    const i = app.indexOf("await setMasterMnemonic(w.mnemonic)");
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i - 80, i + 160)).toContain('onboard.errStore');
  });
});
