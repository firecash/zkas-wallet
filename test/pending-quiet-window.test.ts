import { describe, expect, it } from "vitest";
import { PENDING_WINDOW_MS, SETTLING_WINDOW_MS, quietUntil } from "../src/arrivals";

/**
 * The native background worker checks balance deltas against its own baseline and cannot read
 * the app's send list, so the app hands it a deadline to stay quiet until.
 *
 * That deadline was sized for the SUCCESS path only — the change note maturing past the
 * anchor, ~10.5 minutes, covered by a 20-minute window. A send that never lands has a much
 * longer horizon: walletd reclaims the spend after `PENDING_SPEND_EXPIRY_DAA = 3_600`
 * (~1 hour at one block per second) and that reclaim is a balance INCREASE. With a
 * twenty-minute hold it arrived long after the worker went live, so the user's own FAILED
 * payment was announced to them as money received — while the app was closed, which is
 * exactly when the worker is the only thing watching.
 */
const MIN = 60_000;
const now = 10_000_000_000;

describe("a pending send stays quiet past the daemon's reclaim", () => {
  it("covers the full hour walletd may hold the spend", () => {
    const sent = now - 55 * MIN; // past the old 20-minute window, before the ~60-minute reclaim
    const q = quietUntil([{ pending: true, ts: sent } as never], now);
    expect(q).toBeGreaterThan(now + 5 * MIN);
    // The reclaim lands around sent + 60 min; the hold must still be in force then.
    expect(q).toBeGreaterThan(sent + 60 * MIN);
  });

  it("is anchored on the send, so it survives the app being closed", () => {
    // Anchoring only on `now` would freeze the deadline at whenever the app last ran — which
    // for a background worker is the whole point of the window.
    const sent = now - 50 * MIN;
    expect(quietUntil([{ pending: true, ts: sent } as never], now)).toBeGreaterThanOrEqual(sent + PENDING_WINDOW_MS);
  });

  it("still keeps a rolling hold on a send pending even longer than that", () => {
    const ancient = now - 10 * 60 * MIN;
    const q = quietUntil([{ pending: true, ts: ancient } as never], now);
    // Not silent forever on the send's own clock, but never live mid-resolution either.
    expect(q).toBeGreaterThanOrEqual(now + SETTLING_WINDOW_MS);
  });

  it("leaves the settled path exactly as it was", () => {
    // 20 minutes is the measured cost of the change note maturing; this fix must not move it.
    const sent = now - 5 * MIN;
    expect(quietUntil([{ pending: false, ts: sent } as never], now)).toBe(sent + SETTLING_WINDOW_MS);
  });

  it("clears the hold when nothing is settling", () => {
    expect(quietUntil([], now)).toBe(0);
    expect(quietUntil([{ pending: false, ts: now - 90 * MIN } as never], now)).toBe(0);
  });

  it("takes the furthest deadline when several sends are in flight", () => {
    const old = { pending: false, ts: now - 2 * MIN } as never;
    const fresh = { pending: true, ts: now - MIN } as never;
    expect(quietUntil([old, fresh], now)).toBeGreaterThan(now + 60 * MIN);
  });
});
