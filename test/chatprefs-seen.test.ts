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

  it("ignores a timestamp far in the future instead of clamping to the ceiling", () => {
    // Clamping advanced the cursor to the ceiling, which marked every message
    // arriving before that ceiling as already read — the room then opened at the
    // bottom with real unread messages silently behind the user.
    markSeen("global", now() - 50);
    const before = lastSeen("global");
    markSeen("global", Math.floor(new Date("2100-01-01").getTime() / 1000));
    expect(lastSeen("global")).toBe(before);
  });

  it("a message arriving after a hostile one is still unread", () => {
    markSeen("global", Math.floor(new Date("2100-01-01").getTime() / 1000));
    // A genuine message from one minute ago must still count as newer than the
    // cursor, i.e. unread.
    expect(lastSeen("global")).toBeLessThan(now() - 59);
  });

  it("never moves the cursor backwards", () => {
    markSeen("global", now() - 10);
    const high = lastSeen("global");
    markSeen("global", now() - 500);
    expect(lastSeen("global")).toBe(high);
  });
});
