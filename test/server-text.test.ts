import { describe, it, expect } from "vitest";
import "../src/i18n";
import { serverText, failureText } from "../src/lib/failure";

// The wallet service answers in English; the messages people meet are shown translated, and
// anything unrecognised keeps the service's own words.
describe("server messages", () => {
  it("recognises the messages people meet", () => {
    expect(serverText("the wallet service cannot reach its node right now; retry shortly")).toMatch(/cannot reach the network/);
    expect(serverText("this payment was already sent (transaction 0123456789abcdef0123)")).toMatch(/already sent \(transaction 0123456789ab…\)/);
    expect(serverText("this wallet's last note merge was prepared but never sent, so another is not started yet; the next one can run in 7 min. Payments are not affected.")).toMatch(/waits 7 min/);
    expect(serverText("insufficient matured funds: have 1, need 2+ (amount 1 + a 3 fee per tx; funds must be ~10 min old to spend)")).toMatch(/about 10 minutes/);
    expect(serverText("spendable balance 0.001 ZKAS is below the 0.03 ZKAS minimum network fee for a transaction, so ...")).toMatch(/minimum network fee/);
    expect(serverText("recipient is not a shielded Orchard address")).toMatch(/not a valid ZKas shielded address/);
    expect(serverText("wallet has not established a matured anchor yet (scanned DAA 5); wait for initial sync")).toMatch(/Still syncing/);
  });
  it("leaves anything else as the service said it", () => {
    const raw = "failed to prepare payment: something specific";
    expect(serverText(raw)).toBeNull();
    expect(failureText(new Error(raw))).toBe(raw);
    expect(failureText("recipient is not a shielded Orchard address")).toMatch(/not a valid ZKas shielded address/);
  });
});
