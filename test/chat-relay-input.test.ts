import { describe, expect, it } from "vitest";
import { saneEvent, parseProfile } from "../src/chatclient";

/**
 * Everything arriving on the chat socket is a stranger's JSON — the relay operator's, or
 * whoever reached the relay. The EVENT frame was cast straight to ChatEvent with nothing
 * checked, and the consumers trusted the shape: `ev.tags.find(...)` throws when `tags` is
 * absent or not an array, and the cast sat inside `ws.onmessage` with no try around it, so
 * one malformed event threw out of the socket handler.
 *
 * parseProfile was already written against this ("it is a stranger's JSON"); these cover
 * the envelope around it.
 */
const ok = {
  id: "e1", pubkey: "pk1", created_at: 1_700_000_000, kind: 1,
  tags: [["t", "general"]], content: "hello", sig: "s",
};

describe("saneEvent", () => {
  it("passes a well-formed event through", () => {
    expect(saneEvent(ok)).toMatchObject({ id: "e1", pubkey: "pk1", kind: 1, content: "hello" });
  });

  it("always yields an array for tags, whatever arrived", () => {
    // The field every consumer calls .find() on.
    for (const tags of [undefined, null, "general", 7, {}, [["t", "ok"], "bad", [1, 2], ["t", "fine"]]]) {
      const ev = saneEvent({ ...ok, tags });
      expect(Array.isArray(ev?.tags), `tags=${JSON.stringify(tags)}`).toBe(true);
      // Malformed ROWS are dropped without losing the message or the good rows.
      for (const row of ev!.tags) expect(Array.isArray(row) && row.every((v) => typeof v === "string")).toBe(true);
    }
    expect(saneEvent({ ...ok, tags: [["t", "ok"], "bad", [1, 2], ["t", "fine"]] })!.tags).toEqual([
      ["t", "ok"],
      ["t", "fine"],
    ]);
  });

  it("refuses an event with no readable identity or author", () => {
    // Not coerced: inventing these would put a stranger's message on screen attributed to
    // nobody.
    for (const bad of [
      { ...ok, id: "" }, { ...ok, id: 7 }, { ...ok, pubkey: "" }, { ...ok, pubkey: null },
      { ...ok, kind: "note" }, { ...ok, kind: NaN }, { ...ok, content: 7 }, { ...ok, content: null },
      null, undefined, "EVENT", 42, [],
    ]) {
      expect(saneEvent(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("tolerates a missing or broken created_at instead of dropping the message", () => {
    // It only drives ordering; sorting to the epoch is better than losing a real message,
    // but a non-numeric value must not poison a comparison.
    for (const t of [undefined, null, "yesterday", NaN]) {
      const ev = saneEvent({ ...ok, created_at: t });
      expect(Number.isFinite(ev?.created_at), String(t)).toBe(true);
    }
  });

  it("does not require a signature to be present", () => {
    // The relay checks signatures; a missing one must not crash the client.
    expect(saneEvent({ ...ok, sig: undefined })?.sig).toBe("");
  });
});

describe("parseProfile stays defensive", () => {
  it("truncates a name and flattens an about field", () => {
    const p = parseProfile(JSON.stringify({ name: "x".repeat(100), about: "a\n\n\nb" }));
    expect(p.name!.length).toBeLessThanOrEqual(32);
    expect(p.about).toBe("a b");
  });

  it("ignores a non-object, non-JSON or hostile payload", () => {
    for (const junk of ["", "null", "[]", "7", "{", '{"name":{"$":1}}']) {
      expect(() => parseProfile(junk)).not.toThrow();
    }
    expect(parseProfile('{"name":{"a":1}}').name).toBeUndefined();
  });

  it("only accepts an advertised address that at least looks like one", () => {
    expect(parseProfile('{"zkas":"not-an-address"}').zkas).toBeUndefined();
    expect(parseProfile('{"zkas":"zkas:abc"}').zkas).toBe("zkas:abc");
    // NOTE: this is a prefix check, not looksLikeAddress — a stranger can still advertise
    // a malformed address here. Sending is gated separately: "Review send" stays disabled
    // unless looksLikeAddress passes, so the worst case is a bad string on display.
  });
});
