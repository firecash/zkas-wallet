import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The gate decided "is this an onion?" by taking the host to be everything before the first
 * slash. That ignores `#` and `?`, so "https://evil.com#.onion" and "wss://evil.com?a=.onion"
 * both answered YES while the request would go to evil.com.
 *
 * The consequence was the gate failing OPEN: privacyMode() reported "onion", so the wallet
 * believed it was private, and publicEndpoint/socketAllowed sent traffic to a clearnet host —
 * handing it the real IP of someone who had explicitly turned Tor on. walletd_base is set by
 * PAIRING as well as Settings, so no typing was required to get a hostile value in.
 */
const TOR_KEY = "wallet_embedded_tor";
const BASE_KEY = "walletd_base";

async function privacy() {
  const m = await import("../src/lib/privacy");
  return m;
}

describe("the onion gate parses the real host", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("accepts genuine onions, on any scheme", async () => {
    const { socketAllowed } = await privacy();
    localStorage.setItem(TOR_KEY, "1");
    expect(socketAllowed("wss://relay7xyz.onion/ws")).toBe(true);
    expect(socketAllowed("https://abc123.onion/chain")).toBe(true);
    // A bare host with no scheme is still recognised.
    expect(socketAllowed("abc123.onion")).toBe(true);
  });

  it("a fragment cannot smuggle a clearnet host past it", async () => {
    const { socketAllowed } = await privacy();
    localStorage.setItem(TOR_KEY, "1");
    for (const url of [
      "wss://evil.com#.onion",
      "https://evil.com#.onion",
      "https://evil.com#x.onion",
      "https://user@evil.com#.onion",
    ]) {
      expect(socketAllowed(url), url).toBe(false);
    }
  });

  it("a query string cannot either", async () => {
    const { socketAllowed } = await privacy();
    localStorage.setItem(TOR_KEY, "1");
    expect(socketAllowed("wss://evil.com?a=.onion")).toBe(false);
    expect(socketAllowed("https://evil.com?.onion")).toBe(false);
  });

  it("such a base does not make the wallet believe it is on an onion", async () => {
    const { privacyMode, onionBase, publicEndpoint } = await privacy();
    localStorage.setItem(TOR_KEY, "1");
    localStorage.setItem(BASE_KEY, "https://evil.com#.onion");
    expect(onionBase()).toBeNull();
    // Tor is on and there is no real onion, so the honest answer is "do not fetch".
    expect(privacyMode()).toBe("tor-only");
    expect(publicEndpoint("/chain", "https://api.zkas.info/chain")).toBeNull();
  });

  it("a real onion base still serves public endpoints from it", async () => {
    const { privacyMode, publicEndpoint } = await privacy();
    localStorage.setItem(BASE_KEY, "https://abc123.onion/daemon");
    expect(privacyMode()).toBe("onion");
    expect(publicEndpoint("/chain", "https://api.zkas.info/chain")).toBe("https://abc123.onion/chain");
  });

  it("plain clearnet is unaffected when nothing was asked for", async () => {
    const { clearnetAllowed, socketAllowed } = await privacy();
    expect(clearnetAllowed()).toBe(true);
    expect(socketAllowed("wss://relay.example.com/ws")).toBe(true);
  });
});
