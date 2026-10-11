/**
 * Golden derivation vectors for the WASM signer.
 *
 * The signer links shielded-core's orchard fork, and the signer crate's own
 * Cargo.toml warns that a version skew there puts "a different version of the
 * address-derivation and spend-authorisation code in the wallet than the one the
 * network runs" — `SpendingKey` here and there becoming unrelated types. The
 * security-fork rebuild had to move that pin from 1.0.1 to 2.2.0, and nothing in
 * the tree would have noticed if derivation had shifted under it.
 *
 * It would not fail loudly. Every address the wallet shows would still be a valid
 * address — just not the one holding the user's coins, with the old address
 * unreachable from the new build.
 *
 * These values were produced by the signer built from zkas-rusty 01ac1865 and
 * confirmed identical to the pre-bump signer (orchard 1.0.1) for the same inputs.
 * If a future bump changes any of them, that is a migration, not a dependency
 * update.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const SEED_0 = "00".repeat(32);
const SEED_C = "cd".repeat(32);
const SEED_F = "ff".repeat(32);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let s: any;

beforeAll(async () => {
  s = await import("../src/signer/firecash_signer.js");
  const { WASM_B64 } = await import("../src/signer/wasm-base64.js");
  await s.default({ module_or_path: Buffer.from(WASM_B64, "base64") });
});

describe("signer derivation is fixed", () => {
  it("derives the same mainnet addresses from a seed", () => {
    expect(s.address_from_seed(SEED_0, "mainnet")).toBe(
      "zkas:p8xrvcqetysnk6cvmwt2whqhcwnx32tlp44gch8pvjj3365m4xjsaf63j87cvxc07y8x9vqla2vf9df");
    expect(s.address_from_seed(SEED_C, "mainnet")).toBe(
      "zkas:p8kpjunj8r2wdeg6hc29v7duy89gz9zz44u08m9v2qhqqhucl0g9a0cfgc88eedf8n89fdquhl37njx");
    expect(s.address_from_seed(SEED_F, "mainnet")).toBe(
      "zkas:p9qfmu6xkvrwtry4r3vx93gcafhm20mv79h625p6f8uzd87kzetqft9mtfxf0m3qsxvv8dq29yv075j");
  });

  it("derives the same viewing keys", () => {
    // The FVK is what the daemon scans with: a change here silently orphans
    // every wallet the daemon already watches.
    expect(s.fvk_hex(SEED_0)).toBe(
      "8777e215101df45aa468bb10b2f93ffe08a2f79ebff095aaeb7473c771349621bbca152cfbf9811819cc624434d1237577c13805cc3ded444e755a6b78facd168ca7fbba26470fea0b10d30db27366ec65040c72a09ad8425888ef26f1c0793f");
    expect(s.fvk_hex(SEED_C)).toBe(
      "ffd5bef47571d8c1c58dbf7d56ccad6fdd93a7a67e02c46a19e64ac960dc621bb4ba56b8a429d798e30e2fbab822be6f6472f0651f3b1991e366c928dceebd0786ef1b82944553ffb2f56835320e2e4c1409d4d1054418b2a1c8c5314b5f703a");
  });

  it("derives the same accounts from a recovery phrase", () => {
    // Account indices are how "Add account" builds every wallet after the first.
    expect(s.account_seed_hex(PHRASE, 0)).toBe("f289db28b1611dc2fa1597667e3d572b3de2332451c8955b907847e16464c267");
    expect(s.account_seed_hex(PHRASE, 1)).toBe("703065c6f206ede08cceeea18705f30a27e281bbb1c57f1f85691feb5fcd2b6e");
    expect(s.account_seed_hex(PHRASE, 7)).toBe("7fff0f7f74275df7c395a8ef90a8ee013f7f095fe3d4c67f6081823769a7034d");
    expect(s.account_address(PHRASE, "mainnet", 0)).toBe(
      "zkas:p9erqch3ueh9geyqqtxazl5yg586huqjapcflkuuakvpw4wlwudq75yc5a95jp83gv7mgqgl4k7hqvh");
    expect(s.account_address(PHRASE, "mainnet", 7)).toBe(
      "zkas:px8p78rw5emyu56m2v0wa8pj76y9kz9kvhgrys5mye80lzu5hmpdr3vl47vx00rcqhdwefsvpwjadjf");
  });

  it("account 0 is not the same wallet as the bare seed", () => {
    // Guards the opposite mistake: a derivation collapsing to one wallet is how
    // every account came to show the first account's address.
    expect(s.account_address(PHRASE, "mainnet", 0)).not.toBe(s.account_address(PHRASE, "mainnet", 1));
    expect(s.account_seed_hex(PHRASE, 0)).not.toBe(s.account_seed_hex(PHRASE, 1));
  });

  it("signs and verifies address control round-trip", () => {
    const sig = s.sign(SEED_C, "mainnet", "zkas address control");
    expect(sig.address).toBe(s.address_from_seed(SEED_C, "mainnet"));
    expect(s.verify(sig.address, "zkas address control", sig.signature_hex)).toBe(true);
    expect(s.verify(sig.address, "a different message", sig.signature_hex)).toBe(false);
  });
});
