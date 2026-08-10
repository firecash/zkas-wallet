import { describe, expect, it } from "vitest";
import { formatPairingUri, isPairingUri, parsePairingUri } from "../src/pairing";

const ACCESS = "a".repeat(64);
const WALLET = "b".repeat(32);

describe("pairing a device with a wallet service", () => {
  it("carries all three things a connection needs", () => {
    const p = parsePairingUri(`zkas+http://192.168.15.227:8501#token=${ACCESS}&wallet=${WALLET}&net=mainnet`);
    expect(p).toEqual({
      url: "http://192.168.15.227:8501",
      accessToken: ACCESS,
      walletToken: WALLET,
      network: "mainnet",
    });
  });

  it("round-trips", () => {
    const p = { url: "https://wallet.example.com", accessToken: ACCESS, walletToken: WALLET, network: "mainnet" };
    expect(parsePairingUri(formatPairingUri(p))).toEqual(p);
  });

  it("keeps https distinct from http", () => {
    expect(parsePairingUri(`zkas+https://host.example:8501#token=${ACCESS}`)?.url).toBe("https://host.example:8501");
    expect(parsePairingUri(`zkas+http://host.example:8501#token=${ACCESS}`)?.url).toBe("http://host.example:8501");
  });

  // A malformed secret must not be quietly dropped: connecting with no wallet token
  // reaches a real, authenticated, EMPTY wallet on the far end, which reads as data
  // loss rather than as a typo.
  it("refuses a malformed pairing string rather than half-using it", () => {
    expect(parsePairingUri(`zkas+http://host:8501#token=not-hex!&wallet=${WALLET}`)).toBeNull();
    expect(parsePairingUri(`zkas+http://host:8501#token=${ACCESS}&wallet=zzz`)).toBeNull();
    expect(parsePairingUri("zkas+http://#token=" + ACCESS)).toBeNull();
  });

  it("leaves an ordinary address alone", () => {
    expect(isPairingUri("192.168.15.227:8501")).toBe(false);
    expect(parsePairingUri("192.168.15.227:8501")).toBeNull();
    expect(parsePairingUri("https://wallet.zkas.info")).toBeNull();
  });

  // A service with no gate is legitimate (loopback), and a pairing string for it
  // should still carry the wallet selector.
  it("accepts a pairing string with no access token", () => {
    const p = parsePairingUri(`zkas+http://127.0.0.1:8501#wallet=${WALLET}&net=mainnet`);
    expect(p?.accessToken).toBe("");
    expect(p?.walletToken).toBe(WALLET);
  });
});
