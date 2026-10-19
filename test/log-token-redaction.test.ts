import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scrubWalletTokens } from "../src/embedded";

/**
 * walletd names the wallet token on a great many lines:
 *     log::info!("wallet '{token}': removed orphaned partial checkpoint …")
 *     log::warn!("wallet {token}: load did not complete …")
 * The embedded engine IS walletd, and the desktop runs it as a service, so those lines reach:
 *   - the mobile "Show logs" card, which has a COPY button
 *   - the desktop service-log dialog, which has COPY and DOWNLOAD
 * Each exists so the text can be sent to somebody for help, and a wallet token is the
 * credential for that wallet's FVK view: balances, payments, memos.
 *
 * Redaction is by the tokens THIS DEVICE HOLDS, not by shape — a token is 16-128 lowercase
 * hex, and so is a block hash, which is the part of a log worth sending.
 */
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH = "d15a799d1a9e4b0c2f3e4d5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8";

describe("a shared log cannot carry the wallet credential", () => {
  it("redacts the token but keeps a stub that still correlates lines", () => {
    const out = scrubWalletTokens(`wallet '${TOKEN}': opened\nwallet ${TOKEN}: scanned 10`, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect((out.match(/a1b2c3…\[redacted\]/g) ?? []).length).toBe(2);
  });

  it("leaves block hashes alone", () => {
    // Scrubbing anything hex-shaped would strip these, and then the log is not worth sending.
    const out = scrubWalletTokens(`block ${HASH} accepted`, [TOKEN]);
    expect(out).toContain(HASH);
  });

  it("handles several wallets on one device, and ignores junk entries", () => {
    const b = "ffffffffffffffffffffffffffffffff";
    const out = scrubWalletTokens(`${TOKEN} and ${b}`, [TOKEN, b, "short", ""]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(b);
  });

  it("is applied at the boundary the mobile view and its Copy button share", () => {
    const emb = readFileSync("src/embedded.ts", "utf8");
    const i = emb.indexOf("export async function engineLogs");
    expect(emb.slice(i, i + 900)).toContain("scrubWalletTokens(");
    // The card renders and copies the same string, so one call covers both.
    const app = readFileSync("src/App.tsx", "utf8");
    const card = app.indexOf("function DebugLogsCard");
    expect(app.slice(card, card + 1400)).toContain("await engineLogs()");
  });

  it("is applied where desktop Copy and Download meet", () => {
    const sl = readFileSync("src/components/ServiceLogs.tsx", "utf8");
    const i = sl.indexOf("function output(");
    expect(sl.slice(i, i + 420)).toContain("scrubWalletTokens(");
    // Both paths must go through output(), or one of them bypasses the redaction.
    expect(sl).toContain("writeText(output(visible))");
    expect(sl).toContain("new Blob([output(visible)]");
  });
});
