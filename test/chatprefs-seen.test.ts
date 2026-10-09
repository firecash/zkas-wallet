import { describe, it, expect, beforeEach } from "vitest";
import { markSeen, lastSeen } from "../src/lib/chatprefs";

// The read cursor is written from an AUTHOR-SUPPLIED created_at. It has to
// tolerate the sender's clock running slightly fast, while still refusing a
// timestamp that would silence the room forever.
describe("chat read cursor", () => {
  beforeEach(() => localStorage.clear());
  const now = () => Math.floor(Date.now() / 1000);

  it("marks a message read when the sender's clock is 30s fast", () => {
    // Clamping to `now` wrote the cursor BEHIND this message, so it stayed
    // unread while being read on screen.
    const sentAt = now() + 30;
    markSeen("global", sentAt);
    expect(lastSeen("global")).toBeGreaterThanOrEqual(sentAt);
  });

  it("still refuses a timestamp far in the future", () => {
    const year2100 = Math.floor(new Date("2100-01-01").getTime() / 1000);
    markSeen("global", year2100);
    expect(lastSeen("global")).toBeLessThan(now() + 3600);
  });

  it("never moves the cursor backwards", () => {
    markSeen("global", now() - 10);
    const high = lastSeen("global");
    markSeen("global", now() - 500);
    expect(lastSeen("global")).toBe(high);
  });
});
