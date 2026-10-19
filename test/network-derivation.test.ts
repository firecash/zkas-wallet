import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { networkOf } from "../src/lib/utils";

/**
 * Two sites derived "which network to tell the signer" independently, and they disagreed:
 * payments took not-testnet to mean mainnet, message signing took not-mainnet to mean testnet.
 * On mainnet and testnet they agreed; on devnet or simnet they did not, so a message would be
 * signed under the TESTNET domain while the wallet was on another chain.
 *
 * The right default is mainnet, and the reason is in the helper: the on-device signer only
 * signs mainnet (verified against the real WASM — testnet, devnet and simnet are refused), so
 * an odd or missing network string must fail toward the chain everything actually runs on.
 */
describe("one mapping from daemon network to signer network", () => {
  const net = (n: string | null | undefined) => networkOf(n == null ? null : ({ network: n } as never));

  it("passes mainnet and testnet through", () => {
    expect(net("mainnet")).toBe("mainnet");
    expect(net("testnet")).toBe("testnet");
  });

  it("defaults everything else to mainnet, including devnet and simnet", () => {
    for (const n of ["devnet", "simnet", "", "MAINNET", "weird"]) {
      expect(net(n), n).toBe("mainnet");
    }
    expect(net(null)).toBe("mainnet");
    expect(net(undefined)).toBe("mainnet");
  });
});

describe("and nothing derives it a second way", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("App.tsx holds no local copy of networkOf", () => {
    expect(app).not.toMatch(/^function networkOf\(/m);
  });

  it("the message-signing path uses the shared helper", () => {
    const i = app.indexOf("const net: Network = ");
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i, i + 80)).toContain("networkOf(status)");
  });

  it("the opposite mapping is gone from the code, not just commented", () => {
    // The comment explaining the fix quotes the old expression on purpose, so check for it
    // being ASSIGNED rather than merely present.
    expect(app).not.toMatch(/const net: Network = status\?\.network === "mainnet"/);
  });
});
