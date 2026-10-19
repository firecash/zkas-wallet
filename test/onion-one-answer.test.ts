import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOnionAddress, normalizeDaemonInput } from "../src/api";
import { isOnionHost } from "../src/lib/privacy";

/**
 * "Is this an onion?" had THREE implementations. api/explorer.ts and lib/privacy.ts parsed
 * with `new URL().hostname`; api.ts took the host to be everything before the first slash,
 * which makes `#` and `?` part of it.
 *
 * In api.ts that answer picks a SCHEME — plain http is correct for a real onion, because Tor
 * encrypts the transport — so a crafted bare host answered "onion" and `normalizeDaemonInput`
 * returned `http://evil.com#.onion`. That is a cleartext downgrade carrying the wallet token
 * and the full viewing key, which is exactly what the comment beside it says was fixed:
 * "typing a hostname pointed the wallet at plain HTTP across the internet, carrying the wallet
 * token and the full viewing key in the clear".
 */
describe("one answer about what an onion is", () => {
  it("a crafted host is not an onion", () => {
    for (const bad of [
      "evil.com#.onion",
      "evil.com?x=.onion",
      "evil.com#a.onion",
      "https://evil.com#.onion",
      "http://evil.com?.onion",
    ]) {
      expect(isOnionAddress(bad), bad).toBe(false);
      expect(isOnionHost(bad), bad).toBe(false);
    }
  });

  it("and such a host is never given plain http", () => {
    for (const bad of ["evil.com#.onion", "evil.com?x=.onion", "evil.com#a.onion"]) {
      const url = normalizeDaemonInput(bad);
      expect(url.startsWith("http://"), `${bad} -> ${url}`).toBe(false);
      expect(url.startsWith("https://"), `${bad} -> ${url}`).toBe(true);
    }
  });

  it("real onions still work, and still get http", () => {
    for (const good of ["abc123.onion", "abc123.onion:8080", "http://abc123.onion/daemon"]) {
      expect(isOnionAddress(good), good).toBe(true);
    }
    // A bare onion gets http:// on purpose — Tor encrypts the transport.
    expect(normalizeDaemonInput("abc123.onion")).toBe("http://abc123.onion");
    // An explicit scheme is respected exactly.
    expect(normalizeDaemonInput("http://abc123.onion:8501")).toBe("http://abc123.onion:8501");
  });

  it("an ordinary public host still gets https", () => {
    expect(normalizeDaemonInput("wallet.example.com")).toBe("https://wallet.example.com");
  });

  it("there is only ONE implementation left", () => {
    // Two files held a correct copy and one held a broken copy; the broken one is why this
    // test exists. Any new hand-rolled host split for this question must fail here.
    const privacy = readFileSync("src/lib/privacy.ts", "utf8");
    expect(privacy).toContain("new URL(absolute).hostname.endsWith(\".onion\")");
    for (const f of ["src/api.ts", "src/api/explorer.ts"]) {
      const src = readFileSync(f, "utf8");
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code, `${f} must not re-derive a host`).not.toMatch(/split\("\/"\)\[0\][\s\S]{0,60}endsWith\("\.onion"\)/);
      expect(code, `${f} must use the shared helper`).toContain("isOnionHost");
    }
  });
});
