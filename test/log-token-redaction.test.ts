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

/// The source text of one top-level declaration, by brace matching. Used instead of a
/// `slice(i, i + N)` guess so these guards keep testing what they mean when the function they
/// describe gets longer — the failure mode that sent both halves of the last assertion red
/// without anything being wrong with the code.
function sliceDecl(src: string, decl: string): string {
  const start = src.indexOf(decl);
  expect(start, `declaration not found: ${decl}`).toBeGreaterThan(-1);
  // Match from the BODY brace, not the first brace: these are TSX components, and
  // `function DebugLogsCard({ status }: { status: … })` opens and closes two braces in its
  // parameter list before the body starts. Matching from the first one returned a 33-character
  // "function" that contained nothing.
  let parens = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }
  expect(parens, `no parameter list in ${decl}`).toBe(0);
  let depth = 0;
  for (i = src.indexOf("{", i); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${decl}`);
}

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
    // Both halves of this used to assert over a fixed byte window (900 here, 1,400 below).
    // Both windows went stale the moment the function grew — `engineLogs` took on the desktop
    // log bridge, and the card took on a diagnostics table — while redaction itself was never
    // touched. A window is a proxy for the real property anyway, so assert the property: every
    // path out of `engineLogs` that returns log TEXT is scrubbed, and the view has no second
    // reader that could bypass it.
    const emb = readFileSync("src/embedded.ts", "utf8");
    const fn = sliceDecl(emb, "export async function engineLogs");
    expect(fn).toContain("scrubWalletTokens(");
    // `return ""` is the no-engine case and carries nothing to scrub. Anything else that
    // leaves this function is log text and must pass through the scrub on its way out.
    const returns = [...fn.matchAll(/return ([^;]*);/g)].map((m) => m[1].trim());
    expect(returns.length).toBeGreaterThan(1);
    for (const r of returns) {
      if (r === '""') continue;
      expect(r, `unscrubbed return from engineLogs: ${r}`).toContain("scrubWalletTokens(");
    }
    // The card renders and copies the same string, so one call covers both.
    const app = readFileSync("src/App.tsx", "utf8");
    expect(sliceDecl(app, "function DebugLogsCard")).toContain("await engineLogs()");
    // No second reader. `engineLogs()` is where scrubWalletTokens runs, for the mobile plugin
    // and for the desktop log bridge alike, so a direct read here would paste the wallet
    // token — the FVK-view credential — into whatever support channel the text goes to.
    expect(app).not.toContain("desktopServices.logs(");
    expect(app).not.toContain("Native.logs(");
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
