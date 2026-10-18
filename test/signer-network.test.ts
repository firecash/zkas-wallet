import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signerCanSign, walletCanSpend } from "../src/status";
import en from "../src/i18n/en/app-send.json";

/**
 * Measured against the real WASM signer on a devnet (not inferred from types): it DERIVES
 * addresses for all four networks, and refuses to SIGN for three of them.
 *
 *   mainnet  zkas:      accepted — proceeds to the bundle
 *   testnet  zkastest:  "unknown network testnet; only mainnet is pinned for on-device verification"
 *   devnet   zkasdev:   same refusal
 *   simnet   zkassim:   same refusal
 *
 * So a wallet pointed at a testnet daemon could create a wallet, derive an address and receive
 * funds, then discover it cannot send only AFTER composing the payment and waiting out the
 * daemon's proving — ending in that sentence, which is addressed to whoever wrote the signer
 * rather than to whoever is trying to pay.
 *
 * The client's own types made it worse: `Network = "mainnet" | "testnet"` advertises testnet,
 * and the two places that derive a network from the daemon's answer disagreed — one mapped
 * anything-not-testnet to "mainnet", the other anything-not-mainnet to "testnet".
 */
describe("sending is gated on a network this device can sign for", () => {
  it("accepts mainnet and nothing else", () => {
    expect(signerCanSign("mainnet")).toBe(true);
    for (const n of ["testnet", "devnet", "simnet", "", "MAINNET", "main"]) {
      expect(signerCanSign(n), n).toBe(false);
    }
  });

  it("treats a missing network as mainnet, which is what the hosted service is", () => {
    // An older daemon that omits the field must not have sending disabled on it.
    expect(signerCanSign(undefined)).toBe(true);
    expect(signerCanSign(null)).toBe(true);
  });

  it("blocks the spend gate regardless of how healthy the wallet looks", () => {
    const healthy = { online: true, synced: true, spendReady: true };
    expect(walletCanSpend({ ...healthy, network: "mainnet" })).toBe(true);
    expect(walletCanSpend({ ...healthy, network: "testnet" })).toBe(false);
    expect(walletCanSpend({ ...healthy, network: "devnet" })).toBe(false);
  });

  it("does not change the existing reasons for refusing", () => {
    expect(walletCanSpend({ online: false, synced: true, spendReady: true, network: "mainnet" })).toBe(false);
    expect(walletCanSpend({ online: true, synced: false, spendReady: false, network: "mainnet" })).toBe(false);
    // spendReady still overrides synced where the daemon offers it.
    expect(walletCanSpend({ online: true, synced: false, spendReady: true, network: "mainnet" })).toBe(true);
  });
});

describe("and the screen says which it is", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("does not call an unsignable network 'catching up'", () => {
    // Waiting never fixes it, so the scanning message would be a lie that never resolves.
    const i = app.indexOf("send.catchingUp");
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i - 220, i + 220)).toContain("signerCanSign(status?.network)");
  });

  it("names the network and says receiving still works", () => {
    expect(en.send.networkNotSignable).toContain("{{network}}");
    expect(en.send.networkNotSignable).toMatch(/receive/i);
    expect(en.send.networkNotSignable).toMatch(/mainnet/i);
  });

  it("passes the network at every spend-gate call site", () => {
    const calls = app.match(/walletCanSpend\(\{[^}]*\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, c).toContain("network:");
  });
});
