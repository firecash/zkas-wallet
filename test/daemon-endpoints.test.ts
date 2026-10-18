import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every daemon path the client calls, and whether the deployed daemon serves it.
 *
 * This project has lost endpoints twice without noticing: a walletd swap removed
 * /api/wallet/pending-receipts and the watcher awaited it bare, crediting nothing for four
 * and a half hours; and a zkas-api rebuild silently 404'd three /info routes because the
 * handlers were not in the source tree it built from. Both were invisible until something
 * downstream behaved oddly.
 *
 * So the list is written down. Adding a client call to a path that is not here fails this
 * test, which forces a decision about its deployment status rather than letting a feature
 * ship against a 404 and degrade quietly.
 *
 * Verified against https://wallet.zkas.info/daemon on 2026-10-18 by GET: a POST-only route
 * answers 405, a missing one answers 404 (confirmed with a known-good control,
 * /api/wallet/prepare -> 405, and a known-missing one -> 404).
 */
const LIVE = [
  "/health",
  "/api/status",
  "/api/checkpoint",
  "/api/verify",
  "/api/proof/verify",
  "/api/wallet/balance",
  "/api/wallet/consolidate",
  "/api/wallet/prepare",
  "/api/wallet/submit",
  "/api/wallet/send",
  "/api/wallet/send_many",
  "/api/wallet/sign",
  "/api/wallet/settings",
  "/api/wallet/rescan",
  "/api/wallet/warm",
  "/api/wallet/watch",
  "/api/wallet/history",
  "/api/wallet/proof",
];

/**
 * Called by the client, NOT served by the deployed daemon. Each one needs its caller to
 * degrade gracefully, because in production it is a 404.
 */
const NOT_DEPLOYED = [
  // Carries a finished scan between daemons so moving a synced wallet into the on-device
  // engine costs kilobytes instead of a rescan from birthday. captureScanReceipt is
  // best-effort by design and its comment anticipates exactly this ("an older daemon has
  // no such endpoint"), so the only cost is the rescan it was built to avoid — but the
  // feature is inert against the hosted service until the route is deployed.
  "/api/wallet/scan-receipt",
];

describe("daemon endpoints the client depends on", () => {
  const api = readFileSync("src/api.ts", "utf8");
  const called = [...new Set([...api.matchAll(/"(\/(?:api|health)[a-z0-9/_-]*)"/gi)].map((m) => m[1]))];

  it("found the call sites", () => {
    expect(called.length).toBeGreaterThan(10);
  });

  it("every path the client calls has a recorded deployment status", () => {
    const known = new Set([...LIVE, ...NOT_DEPLOYED]);
    const unlisted = called.filter((p) => !known.has(p));
    expect(
      unlisted,
      `these paths are called but not listed — confirm whether the daemon serves them ` +
        `(GET it: 405 means the route exists, 404 means it does not) and add them to LIVE ` +
        `or NOT_DEPLOYED with a note on how the caller degrades`,
    ).toEqual([]);
  });

  it("keeps the two lists disjoint", () => {
    expect(LIVE.filter((p) => NOT_DEPLOYED.includes(p))).toEqual([]);
  });
});

describe("the unguarded balance endpoint stays unreachable", () => {
  const api = readFileSync("src/api.ts", "utf8");

  it("exposes no balance() wrapper", () => {
    // `/api/wallet/balance` lacks the `tip > 0` guard `/api/status` has, so a wallet
    // mid-scan reports synced:true from it — a funded wallet telling its owner it is up to
    // date having seen a fraction of the chain. The wrapper had no callers and existed only
    // as a loaded gun for the next person who needed a balance.
    expect(api).not.toMatch(/^\s*balance:\s*\(\)\s*=>/m);
    expect(api).not.toContain('"/api/wallet/balance"');
  });

  it("and the UI takes every balance from the guarded status call", () => {
    // status() carries the figure and applies the guard, so nothing is lost by removing it.
    expect(api).toContain('req<Status>("GET", "/api/status"');
  });
});
