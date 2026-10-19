import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normBase } from "../src/wallets";

/**
 * `prewarm` sends one `/api/status` per registered wallet, every 120 s, each carrying that
 * wallet's `X-Wallet-Token` — to `getBase()`, whatever is configured at the time.
 *
 * A token is a credential: it authenticates the FVK view of its wallet (balances, payments,
 * memos) on the daemon that holds it. The registry recorded no daemon, so pointing the app at
 * another one — a self-host, a community node, a URL handed over by "support" — delivered it
 * the tokens of every wallet hosted elsewhere, on a timer.
 *
 * The active wallet is different: sending ITS token to the daemon the user just chose is the
 * point of choosing it. prewarm skips the active wallet anyway.
 */
const prewarm = readFileSync("src/prewarm.ts", "utf8");
const wallets = readFileSync("src/wallets.ts", "utf8");
const app = readFileSync("src/App.tsx", "utf8");

describe("a wallet's token only goes to the daemon that holds it", () => {
  it("normalises daemon URLs so a trailing slash is not a different daemon", () => {
    expect(normBase("https://wallet.zkas.info/")).toBe("https://wallet.zkas.info");
    expect(normBase("https://Wallet.ZKAS.info//")).toBe("https://wallet.zkas.info");
    expect(normBase("  https://x.test  ")).toBe("https://x.test");
    expect(normBase(null)).toBe("");
    expect(normBase(undefined)).toBe("");
  });

  it("prewarm touches only wallets stamped with the current base", () => {
    const i = prewarm.indexOf("const others =");
    const block = prewarm.slice(i, i + 260);
    expect(block).toContain("w.base === here");
    // And an unstamped wallet is skipped rather than guessed at.
    expect(block).toContain("w.base &&");
    expect(prewarm).toContain("const here = normBase(getBase());");
  });

  it("still skips the active wallet, which the app polls anyway", () => {
    const i = prewarm.indexOf("const others =");
    expect(prewarm.slice(i, i + 260)).toContain("w.token !== active");
  });

  it("the status poll is what records the daemon", () => {
    // That is the one moment a wallet is known to be served by the base in front of us.
    expect(app).toContain("ensureRegistered(pollToken, s.address, getBase())");
  });

  it("every registration path records the daemon, not just the main poll", () => {
    // A path that forgot it would leave the wallet unstamped, which fails closed (no
    // credential sent) but silently loses warming for that wallet forever.
    const store = readFileSync("src/store/wallet.ts", "utf8");
    const adopt = readFileSync("src/lib/watchadopt.ts", "utf8");
    expect(store).toContain('ensureRegistered(activeToken() || "", status.address, getBase())');
    expect(adopt).toContain("ensureRegistered(token, address, getBase())");
  });

  it("a wallet that moves daemons is re-stamped, not left pointing at the old one", () => {
    const i = wallets.indexOf("export function ensureRegistered");
    const body = wallets.slice(i, i + 900);
    expect(body).toContain("if (b && found.base !== b)");
    expect(body).toContain("found.base = b;");
    // New entries carry it from the start.
    expect(body).toContain("base: b");
  });
});
