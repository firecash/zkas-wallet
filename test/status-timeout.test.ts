/**
 * The status poll must not call a slow daemon a missing one.
 *
 * `api.status` carried a 4-second timeout for a few releases. It was meant to speed up
 * recovery after a network change, where the poll serialised behind sockets that would
 * never answer. The cost showed up against the hosted daemon, which serves thousands of
 * wallets, keeps only a few resident, and loads one from its checkpoint before it can
 * answer: measured on the live daemon, the median load is ~11-13s, 78% exceed 4s and 52%
 * exceed 10s.
 *
 * Five consecutive failures put the "can't reach the wallet service" screen up, so the
 * tighter timeout took the chance of that from roughly 7% to roughly 30% — the wallet
 * declared a working daemon offline about four times as often. Reported as the newest
 * build showing offline where older builds worked.
 *
 * Two properties are pinned here:
 *   1. the status poll gets no shorter deadline than any other request, and
 *   2. a timeout is distinguishable from a refusal WITHOUT reading the message, which is
 *      translated into 24 languages and cannot carry logic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src/api.ts"), "utf8");

describe("the status poll's deadline", () => {
  it("gives a HOSTED daemon the full default, and only shortens for a local engine", () => {
    const line = SRC.split("\n").find((l) => /^\s*status:\s*\(\)\s*=>\s*req</.test(l));
    expect(line, "api.status should exist").toBeTruthy();
    // The two daemons are not comparable: a local engine answers from memory, the hosted
    // one loads a wallet from its checkpoint first. So the deadline must be CONDITIONAL —
    // an unconditional short bound is the regression, and an unconditional long one makes
    // a dead local engine take 10s to notice.
    expect(line, "the deadline must depend on which daemon answers").toMatch(/localEngine\(\)\s*\?/);
    // The hosted branch must be the default, not a number.
    expect(line, "the non-local branch must fall through to req's default").toMatch(/:\s*undefined/);
  });

  it("keeps req's default at 10s, which is what 'no custom timeout' relies on", () => {
    expect(SRC).toMatch(/async function req<T>\([^)]*timeoutMs = 10_000/);
  });
});

describe("a busy daemon is not a missing one", () => {
  it("marks a timeout structurally, not just in the message", () => {
    // Localised text cannot carry logic: these messages exist in 24 languages.
    expect(SRC).toMatch(/timedOut:\s*true/);
    expect(SRC).toMatch(/unreachable:\s*true/);
  });

  it("the poll raises its threshold for timeouts but not for refusals", () => {
    const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
    const flip = app.split("\n").find((l) => l.includes("const flipAt ="));
    expect(flip, "the flip threshold should exist").toBeTruthy();
    // A timeout means something answered the socket, so it must be more patient than the
    // refusal case — and a refusal must stay prompt, or a genuinely dead daemon hides.
    expect(flip).toMatch(/timedOut\s*\?/);
    expect(flip).toMatch(/:\s*5;?\s*$/);
  });
});

describe("a node-link blip is not a network outage", () => {
  const APP = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("holds node_connected:false before acting on it", () => {
    // walletStatus() turns an explicit false into an entire "Can't reach the network"
    // screen. One poll landing while the daemon's RPC link to its node blips — a node
    // restart, an overloaded node, a reconnect — therefore replaced a working wallet
    // with an alarm, while the balance, the address and receiving were all fine. The
    // only thing actually unavailable is broadcasting, which is not what that says.
    expect(APP).toMatch(/nodeDownSince/);
    expect(APP, "must be held, like synced and warming already are").toMatch(
      /nodeDownStable[\s\S]{0,200}>=\s*6000/,
    );
  });

  it("reports the flag as ABSENT while unconfirmed, never as connected", () => {
    // Claiming a connection that has not been confirmed is the opposite error, and
    // walletStatus only acts on an explicit false — so undefined is the honest value.
    expect(APP).toMatch(/node_connected:\s*s\.node_connected === false && !nodeDownStable \? undefined : s\.node_connected/);
  });

  it("the type admits the field can be absent", () => {
    // Daemons that predate the field omit it, and the hold above produces undefined.
    expect(readFileSync(join(process.cwd(), "src/api.ts"), "utf8")).toMatch(/node_connected\?:\s*boolean/);
  });
});
