import { describe, it, expect } from "vitest";
import "../src/i18n";
import { walletStatus, LOADING_REASONS } from "../src/status";

// "Opening..." used to look identical whatever held a wallet back. walletd now says why
// (`loading_reason`), and the status line says it in plain words.
const base = { online: true, synced: false, scannedBlocks: 0, chainLen: 8_000_000, loading: true };

describe("why a wallet is still opening", () => {
  it("names the reason while opening", () => {
    const v = walletStatus({ ...base, loadingReason: "node_history_short" } as never);
    expect(v.phase).toBe("opening");
    expect(v.detail).toMatch(/history/i);
  });

  it("keeps the reason while catching up from a last-known position", () => {
    const v = walletStatus({ ...base, scannedBlocks: 7_000_000, loadingReason: "node_behind" } as never);
    expect(v.detail).toMatch(/caught up|catch/i);
  });

  it("ignores an unknown code and a reason without loading", () => {
    const plain = walletStatus({ ...base } as never).detail;
    expect(walletStatus({ ...base, loadingReason: "made_up" } as never).detail).toBe(plain);
    expect(walletStatus({ ...base, loading: false, loadingReason: "node_slow" } as never).detail).not.toMatch(/slowly/);
  });

  it("every code has a sentence", () => {
    for (const r of LOADING_REASONS) {
      expect(walletStatus({ ...base, loadingReason: r } as never).detail).not.toMatch(/status\\.loadingReason/);
    }
  });
});
