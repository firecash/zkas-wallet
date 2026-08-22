import { describe, expect, it } from "vitest";
import { makeBackup, readBackup } from "../src/backup";

// A backup that cannot be read back is worse than no backup: the user believes
// they are safe. Both secret shapes must survive encrypt -> decrypt intact.
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const HEX = "07".repeat(32);

describe("encrypted backup round-trip", () => {
  it("restores a 12-word recovery phrase exactly", async () => {
    const doc = await makeBackup(PHRASE, "correct horse battery", "mainnet", 1234);
    const out = await readBackup(doc, "correct horse battery");
    expect(out.seedHex).toBe(PHRASE);
    expect(out.birthday).toBe(1234);
  });

  it("restores a legacy 64-hex seed exactly", async () => {
    const doc = await makeBackup(HEX, "correct horse battery", "mainnet", 99);
    const out = await readBackup(doc, "correct horse battery");
    expect(out.seedHex).toBe(HEX);
    expect(out.birthday).toBe(99);
  });

  it("refuses the wrong passphrase rather than returning garbage", async () => {
    const doc = await makeBackup(PHRASE, "right-passphrase", "mainnet", 0);
    await expect(readBackup(doc, "wrong-passphrase")).rejects.toThrow(/passphrase/i);
  });

  it("rejects a file that is not a ZKas backup", async () => {
    await expect(readBackup('{"hello":"world"}', "x")).rejects.toThrow(/not a ZKas wallet backup/i);
  });

  // The birthday is what stops a restore rescanning from genesis.
  it("carries the birthday so a restore does not rescan the whole chain", async () => {
    const doc = await makeBackup(PHRASE, "pass-phrase-1", "mainnet", 987654);
    expect((await readBackup(doc, "pass-phrase-1")).birthday).toBe(987654);
  });
});
