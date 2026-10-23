import { beforeEach, describe, expect, it } from "vitest";
import { getToken, setToken } from "../src/api";

/**
 * Pairing hands the phone the COMPUTER'S wallet token so both show the same wallet.
 * `setToken` is the only way that token is adopted, and it used to require hex and
 * lowercase everything — while the desktop shell mints a 32-character mixed-case
 * ALPHANUMERIC token and `pairing.ts` accepts exactly that.
 *
 * The failure was silent and looked like data loss rather than a bug: the token was
 * dropped with a bare `return`, the phone kept its own, and the daemon answered for THAT
 * token — a real, authenticated, empty wallet. Nothing errored; the user just saw a wallet
 * with no funds in it.
 */
describe("adopting a paired wallet token", () => {
  beforeEach(() => {
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* no storage in this environment; setToken/getToken handle that themselves */
    }
  });

  it("adopts the desktop shell's mixed-case alphanumeric token byte-for-byte", () => {
    const desktop = "AbcdEfghIjklMnopQrstUvwxYzabCdef"; // 32 ASCII alphanumerics, as minted
    setToken(desktop);
    // Case matters: lowercasing selects a DIFFERENT wallet file on the daemon.
    expect(getToken()).toBe(desktop);
  });

  it("still canonicalises a hex token to lowercase, as storage already holds it", () => {
    setToken("AABBCCDDEEFF00112233445566778899");
    expect(getToken()).toBe("aabbccddeeff00112233445566778899");
  });

  it("refuses what is not a token rather than storing junk", () => {
    setToken("AbcdEfghIjklMnopQrstUvwxYzabCdef");
    for (const junk of ["short", "has space in it", "with-a-dash-in-it-0123456789abcd", "", "   "]) {
      setToken(junk);
      // Unchanged: a refusal must not clear a token that is already working.
      expect(getToken()).toBe("AbcdEfghIjklMnopQrstUvwxYzabCdef");
    }
  });
});
