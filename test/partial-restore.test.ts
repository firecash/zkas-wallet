import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en/app-wallet.json";

/**
 * Restoring a multi-account phrase recreates one wallet per account. Each account's failure
 * was swallowed — "best-effort: a missing account can still be added by hand, in order" —
 * which is true and also silent: a five-account restore could produce four wallets and say
 * nothing, leaving the fifth account's funds invisible until the user happened to add that
 * account by hand, in the right order, without having been told it was missing.
 *
 * `api.watch` is the step that fails. It allows 180s, and a cold load on the hosted daemon is
 * p99 167.8s, so a timeout here is ordinary rather than exotic.
 *
 * Everywhere else this app reports partial success instead of hiding it: PartialSendError for
 * a payment that went out in pieces, "showing the most recent N of TOTAL" for a truncated
 * history.
 */
describe("a restore that misses accounts says so", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("returns the accounts it could not bring back", () => {
    expect(app).toMatch(/async function recreatePhraseAccounts\([^)]*\): Promise<number\[\]>/);
    expect(app).toContain("const failed: number[] = []");
    expect(app).toContain("return failed;");
  });

  it("records BOTH failure paths, not just the throwing one", () => {
    // A seed that cannot be persisted takes an early `continue` and never throws, so counting
    // only exceptions would miss it — and that path already unregisters the half-made wallet.
    const i = app.indexOf("if (!(await persistDeviceSeed(secret, token)))");
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i, i + 220)).toContain("failed.push(account)");
    const c = app.indexOf("} catch {\n      // Still best-effort");
    expect(c).toBeGreaterThan(0);
    expect(app.slice(c, c + 320)).toContain("failed.push(account)");
  });

  it("keeps going after one account fails", () => {
    // Reporting must not become abandoning: the other accounts still have to be created.
    // Whitespace-agnostic: the push is followed by a `continue`, not a `return` or a throw.
    expect(app).toMatch(/failed\.push\(account\);\s*\n\s*continue;/);
    expect(app).not.toMatch(/failed\.push\(account\);\s*\n\s*(return|throw)/);
  });

  it("surfaces it at both call sites", () => {
    expect((app.match(/if \(missed\.length\)/g) ?? []).length).toBe(2);
    expect(app).toContain("onboard.accountsNotRestored");
  });

  it("names the accounts and says the funds are not lost", () => {
    const m = en.onboard.accountsNotRestored;
    expect(m).toContain("{{accounts}}");
    expect(m).toMatch(/not lost/i);
    // And how to get them back, in the order that matters.
    expect(m).toMatch(/in order/i);
  });
});
