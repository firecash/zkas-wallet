// An engine running on THIS device is opening the wallet, not missing it.
//
// The poll rides out ~10 "no wallet" answers before believing them and arming
// the auto-repair. The code's own note on `has_wallet` says a daemon restart
// unloads every wallet "for minutes" — on a phone that routinely outlasts ten
// one-second polls, so reopening the app armed a repair against a wallet that
// was never lost.
//
// `/watch` defends itself (same key + checkpoint RESUMES), so it is usually
// survivable. It is not survivable with no checkpoint yet: the engine writes one
// every 60 s, so an app closed inside its first minute of syncing has none and
// the re-registration restarts the scan from the birthday.
//
// This pins the DECISION, not the React wiring: the grace belongs to an engine
// we started ourselves, and must not loosen the hosted case — a hosted daemon
// that really has lost a wallet must still be repaired promptly.

import { describe, expect, it } from "vitest";

const MISSING_TOLERANCE = 10;
const LOCAL_ENGINE_MISSING_GRACE_MS = 150_000;

/** The predicate as the poll computes it. */
function isTransient(opts: {
  missingPolls: number;
  missingForMs: number;
  embeddedChosen: boolean;
  desktopEmbedded: boolean;
}): boolean {
  const ownEngine = opts.embeddedChosen || opts.desktopEmbedded;
  const stillOpeningLocally = ownEngine && opts.missingForMs < LOCAL_ENGINE_MISSING_GRACE_MS;
  return opts.missingPolls <= MISSING_TOLERANCE || stillOpeningLocally;
}

const hosted = { embeddedChosen: false, desktopEmbedded: false };
const phone = { embeddedChosen: true, desktopEmbedded: false };
const desktop = { embeddedChosen: false, desktopEmbedded: true };

describe("a hosted daemon that forgot a wallet is repaired promptly", () => {
  it("rides out a short gap, then believes it", () => {
    expect(isTransient({ ...hosted, missingPolls: 5, missingForMs: 5_000 })).toBe(true);
    expect(isTransient({ ...hosted, missingPolls: 11, missingForMs: 11_000 })).toBe(false);
  });

  it("is NOT given the engine grace, however long it has been missing", () => {
    expect(isTransient({ ...hosted, missingPolls: 60, missingForMs: 60_000 })).toBe(false);
  });
});

describe("an engine we started on this device is given time to open", () => {
  it("phone mode rides out far more than ten polls", () => {
    // The case that reset people's wallets: app reopened, engine still loading.
    expect(isTransient({ ...phone, missingPolls: 40, missingForMs: 40_000 })).toBe(true);
    expect(isTransient({ ...phone, missingPolls: 120, missingForMs: 120_000 })).toBe(true);
  });

  it("the desktop embedded engine gets the same grace", () => {
    expect(isTransient({ ...desktop, missingPolls: 40, missingForMs: 40_000 })).toBe(true);
  });

  it("the grace is bounded — a genuinely lost local wallet is still repaired", () => {
    expect(isTransient({ ...phone, missingPolls: 200, missingForMs: LOCAL_ENGINE_MISSING_GRACE_MS + 1 })).toBe(false);
  });

  it("is TIME-based, not poll-based, because the poll throttles when hidden", () => {
    // Few polls but a long wall-clock gap: a backgrounded phone. Still opening.
    expect(isTransient({ ...phone, missingPolls: 11, missingForMs: 30_000 })).toBe(true);
    // Many polls inside the window: still opening.
    expect(isTransient({ ...phone, missingPolls: 140, missingForMs: 140_000 })).toBe(true);
  });
});
