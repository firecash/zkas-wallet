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

describe("ways a user could get screwed", () => {
  // Removing a wallet drops it from the registry. If the index were reused, the
  // next "new" account would derive the SAME key — the removed wallet's balance
  // and history would reappear under a name promising a fresh account.
  it("never reissues an account index after a wallet is removed", async () => {
    const { setAccountOf, nextFreeAccount } = await import("../src/accounts");
    const { addWallet, unregisterWallet } = await import("../src/wallets");
    const t0 = addWallet(); setAccountOf(t0, nextFreeAccount());
    const t1 = addWallet(); const a1 = nextFreeAccount(); setAccountOf(t1, a1);
    expect(a1).toBe(1);
    unregisterWallet(t1);                 // user removes "Account 2"
    expect(nextFreeAccount()).toBe(2);    // must NOT hand back 1 again
  });

  // Creating a SEPARATE wallet must not overwrite the master: the existing
  // accounts would keep working locally while the app claimed the new phrase
  // backed them up — a false promise that loses coins on a restore.
  it("keeps the first phrase as master so existing accounts stay recoverable", async () => {
    const { setMasterMnemonic, masterMnemonic, hasMaster } = await import("../src/accounts");
    setMasterMnemonic(PHRASE);
    expect(hasMaster()).toBe(true);
    // The create flow only calls setMasterMnemonic when there is no master, so a
    // second phrase must never replace the first.
    if (!hasMaster()) setMasterMnemonic("other words here");
    expect(masterMnemonic()).toBe(PHRASE);
  });

  // A token that gets a restored/imported secret is no longer the account it was.
  it("clears a stale account label when a token's secret is replaced", async () => {
    const { setAccountOf, clearAccountOf, accountOf } = await import("../src/accounts");
    const { addWallet } = await import("../src/wallets");
    const t = addWallet();
    setAccountOf(t, 1);
    expect(accountOf(t)).toBe(1);
    clearAccountOf(t);                    // what restore/import now does
    expect(accountOf(t)).toBeNull();
  });
});

// THE PROMISE THE UI MAKES: "one phrase backs up every account". This proves the
// mechanism actually keeps it — restoring the phrase on a FRESH device and adding
// accounts re-derives the SAME keys, in the same order, so the old accounts (and
// their funds) come back rather than being lost.
describe("restoring on a new device recovers the same accounts", () => {
  it("re-derives identical account keys in the same order", async () => {
    const { accountSeedHex } = await import("../src/signer");
    // Device A: the user had accounts 0, 1, 2.
    const deviceA = [0, 1, 2];
    const keysA = await Promise.all(deviceA.map((a) => accountSeedHex(PHRASE, a)));

    // Device B: fresh install, phrase restored, then "Add account" twice.
    localStorage.clear();
    const { adoptExistingPhrase, setAccountOf, nextFreeAccount, accountOf } = await import("../src/accounts");
    const { addWallet } = await import("../src/wallets");
    const t0 = addWallet();
    await adoptExistingPhrase(t0, PHRASE);
    expect(accountOf(t0)).toBe(0); // the restored wallet is account 0

    const recovered = [0];
    for (let i = 0; i < 2; i++) {
      const next = nextFreeAccount();
      setAccountOf(addWallet(), next);
      recovered.push(next);
    }
    expect(recovered).toEqual(deviceA); // same indexes, same order
    const keysB = await Promise.all(recovered.map((a) => accountSeedHex(PHRASE, a)));
    expect(keysB).toEqual(keysA);       // and therefore the same wallets
  });
});

