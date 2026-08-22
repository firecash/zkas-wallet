import { describe, expect, it, beforeEach, vi } from "vitest";

// isValidMnemonic goes through the WASM signer; stub it so this suite stays a fast
// unit test of the ACCOUNT logic, which is what actually broke.
vi.mock("../src/signer", () => ({
  accountSeedHex: async (_m: string, a: number) => String(a).padStart(64, "0"),
  accountAddress: async (_m: string, _n: string, a: number) => `zkas:acct${a}`,
  isValidMnemonic: async (s: string) => s.trim().split(/\s+/).length === 12,
}));

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";

beforeEach(() => localStorage.clear());

describe("accounts: one phrase, many wallets", () => {
  it("hands out a fresh index per wallet and never reuses one", async () => {
    const { setAccountOf, nextFreeAccount, accountOf } = await import("../src/accounts");
    const { addWallet } = await import("../src/wallets");
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) {
      const a = nextFreeAccount();
      expect(seen.has(a)).toBe(false);
      seen.add(a);
      const t = addWallet();
      setAccountOf(t, a);
      expect(accountOf(t)).toBe(a);
    }
    expect([...seen]).toEqual([0, 1, 2, 3]);
  });

  // THE BUG THAT MADE THE FEATURE INVISIBLE: a device that already had a phrase
  // wallet never got a master, so "add wallet" silently fell back to creating an
  // orphan wallet with its own separate words.
  it("adopts an existing phrase wallet as the master, enabling accounts", async () => {
    const { adoptExistingPhrase, hasMaster, accountOf, nextFreeAccount } = await import("../src/accounts");
    const { addWallet } = await import("../src/wallets");
    const token = addWallet();
    expect(hasMaster()).toBe(false);
    await adoptExistingPhrase(token, PHRASE);
    expect(hasMaster()).toBe(true);
    expect(accountOf(token)).toBe(0);      // the existing wallet IS account 0
    expect(nextFreeAccount()).toBe(1);      // so the next wallet is account 1
  });

  it("never adopts a legacy hex seed — a raw key has no phrase", async () => {
    const { adoptExistingPhrase, hasMaster, accountOf } = await import("../src/accounts");
    const { addWallet } = await import("../src/wallets");
    const token = addWallet();
    await adoptExistingPhrase(token, "07".repeat(32));
    expect(hasMaster()).toBe(false);
    expect(accountOf(token)).toBeNull();   // stays an independent legacy wallet
  });

  it("adoption is idempotent and does not steal an existing master", async () => {
    const { adoptExistingPhrase, masterMnemonic, setMasterMnemonic } = await import("../src/accounts");
    const { addWallet } = await import("../src/wallets");
    setMasterMnemonic(PHRASE);
    const other = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    await adoptExistingPhrase(addWallet(), other);
    expect(masterMnemonic()).toBe(PHRASE);
  });
});

describe("secret input gates", () => {
  // The Import button was `disabled` unless the input was EXACTLY 64 characters,
  // so a 12-word phrase could never be submitted at all.
  it("accepts a phrase wherever a secret is entered", async () => {
    const { isSecretShaped } = await import("../src/lib/deviceseed");
    expect(isSecretShaped(PHRASE)).toBe(true);
    expect(isSecretShaped("07".repeat(32))).toBe(true);
    expect(PHRASE.trim().length).not.toBe(64); // the old gate would have refused it
  });
});
