import { describe, expect, it } from "vitest";
import { clampUtf8Bytes, hasUnsafeText, safeText, MEMO_MAX_BYTES } from "../src/lib/safetext";

const RLO = "\u202e"; // RIGHT-TO-LEFT OVERRIDE
const ZWSP = "\u200b";

describe("hasUnsafeText answers the same way every time", () => {
  it("does not alternate on repeated calls", () => {
    // `test` on a /g regex starts at lastIndex and advances it, so this returned
    // true, false, true, false for one unchanging string — and the caller it exists to
    // serve is one deciding whether to REFUSE a name.
    const spoof = `Alice${RLO}`;
    for (let i = 0; i < 6; i++) expect(hasUnsafeText(spoof), `call ${i + 1}`).toBe(true);
  });

  it("holds for control characters too", () => {
    for (let i = 0; i < 6; i++) expect(hasUnsafeText("Bob\nCarol"), `call ${i + 1}`).toBe(true);
  });

  it("and keeps answering false for ordinary names", () => {
    for (const name of ["Alice", "Zoë", "佐藤", "أحمد", "Ivan Petrov"]) {
      for (let i = 0; i < 3; i++) expect(hasUnsafeText(name), name).toBe(false);
    }
  });

  it("catches every class the module claims to catch", () => {
    for (const bad of [RLO, ZWSP, "\ufeff", "\u2066", "\u061c", "\u0000", "\u007f"]) {
      expect(hasUnsafeText(`name${bad}`), JSON.stringify(bad)).toBe(true);
    }
  });

  it("safeText was never affected and still strips them", () => {
    // `replace` with /g restarts from zero each call, so this half was always correct.
    const spoof = `Alice${RLO}${ZWSP}`;
    for (let i = 0; i < 3; i++) expect(safeText(spoof)).toBe("Alice");
  });

  it("the memo clamp still counts BYTES and cuts on code points", () => {
    const cyr = "д".repeat(400);
    const clamped = clampUtf8Bytes(cyr, MEMO_MAX_BYTES);
    expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(MEMO_MAX_BYTES);
    // 512 bytes / 2 bytes per character.
    expect([...clamped].length).toBe(256);
    // A surrogate pair is never cut in half.
    const emoji = "😀".repeat(200);
    const cut = clampUtf8Bytes(emoji, MEMO_MAX_BYTES);
    expect(cut.includes("\ufffd")).toBe(false);
    expect([...cut].length).toBe(128);
  });
});
