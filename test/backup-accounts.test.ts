import { describe, it, expect } from "vitest";
import { makeBackup, readBackup } from "../src/backup";

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("a backup records which accounts existed", () => {
  it("round-trips gaps instead of inventing the accounts between them", async () => {
    // A device holding accounts 0 and 5. The high-water mark alone said "5",
    // and the restore created 1,2,3,4 — accounts that never existed, each
    // registered with the daemon, leaving the funded wallet labelled Wallet 6.
    const doc = await makeBackup(PHRASE, "pw", "mainnet", 100, 5, [5]);
    const out = await readBackup(doc, "pw");
    expect(out.accountList).toEqual([5]);
    expect(out.accounts).toBe(5); // still written, for older readers
  });

  it("falls back to 1..accounts for a file written before the list existed", async () => {
    const doc = await makeBackup(PHRASE, "pw", "mainnet", 100, 3);
    const parsed = JSON.parse(doc);
    delete parsed.accountList; // an older file has only the maximum
    const out = await readBackup(JSON.stringify(parsed), "pw");
    expect(out.accountList).toEqual([1, 2, 3]);
  });

  it("de-duplicates and sorts whatever it is handed", async () => {
    const doc = await makeBackup(PHRASE, "pw", "mainnet", 100, 4, [4, 1, 4, 2]);
    expect((await readBackup(doc, "pw")).accountList).toEqual([1, 2, 4]);
  });

  it("a hex-seed backup carries no accounts at all", async () => {
    const doc = await makeBackup("ab".repeat(32), "pw", "mainnet", 100);
    const out = await readBackup(doc, "pw");
    expect(out.accounts).toBe(0);
    expect(out.accountList).toEqual([]);
  });
});
