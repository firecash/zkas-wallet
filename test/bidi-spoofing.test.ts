import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { MEMO_MAX_BYTES, clampUtf8Bytes, hasUnsafeText, safeText } from "../src/lib/safetext";
import { addContact, displayName, loadContacts, updateContact } from "../src/contacts";
import { parsePaymentUri } from "../src/lib/utils";
import { parseProfile } from "../src/chatclient";

/**
 * Strings a stranger controls are rendered BESIDE an address — and `displayName()` puts a
 * contact's name exactly where the address would otherwise be. Unicode's bidi controls are
 * overrides, not decoration: U+202E reverses the visual order of everything after it, so a
 * name ending in one can reorder the address shown next to it. That is filename-spoofing
 * aimed at the one string a wallet tells its user to check.
 *
 * Three doors let such a string in: a contact name or note, a chat profile from the relay,
 * and the `label`/`memo` on a payment URI off a QR or a link.
 */
const RLO = "‮";          // right-to-left override
const LRO = "‭";
const ZWSP = "​";         // zero-width space — invisible, so two names can look equal
const BOM = "﻿";
const A = "zkas:pxs3h3gk6ra8nvagka0lup93z6wffa5uhlhm2aj0slln24657z5ml8esvtty2dyfz0254dgxkga67l9";

describe("safeText", () => {
  it("removes bidi overrides and isolates", () => {
    for (const c of [RLO, LRO, "‪", "‫", "‬", "⁦", "⁧", "⁨", "⁩", "‎", "‏"]) {
      expect(safeText(`Alice${c}Bob`)).toBe("AliceBob");
    }
  });

  it("removes zero-width characters, so two names cannot look identical and differ", () => {
    expect(safeText(`Al${ZWSP}ice`)).toBe("Alice");
    expect(safeText(`${BOM}Alice`)).toBe("Alice");
    expect(safeText("Alice")).toBe(safeText(`Ali${ZWSP}ce`));
  });

  it("turns control characters into spaces rather than dropping the gap", () => {
    expect(safeText("Alice\nBob")).toBe("Alice Bob");
    expect(safeText("Alice\u0000Bob")).toBe("Alice Bob");
  });

  it("leaves ordinary text — including real right-to-left script — alone", () => {
    // The point is to remove OVERRIDES, not to mangle languages that are written RTL.
    expect(safeText("أحمد")).toBe("أحمد");
    expect(safeText("Zoë Müller")).toBe("Zoë Müller");
    expect(safeText("  spaced   out  ")).toBe("spaced out");
    expect(safeText("小林")).toBe("小林");
  });

  it("reports whether a string carried anything unsafe", () => {
    expect(hasUnsafeText(`x${RLO}`)).toBe(true);
    expect(hasUnsafeText("plain")).toBe(false);
  });
});

describe("the three doors a hostile display string comes through", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
  });

  it("a contact name cannot reorder the address beside it", () => {
    const c = addContact(`Alice${RLO}`, A);
    expect(c.name).toBe("Alice");
    expect(loadContacts()[0].name).toBe("Alice");
    // displayName is what renders in place of an address.
    expect(displayName(A, "fallback")).toBe("Alice");
    expect(hasUnsafeText(displayName(A, "fallback"))).toBe(false);
  });

  it("nor can a rename sneak one back in", () => {
    const c = addContact("Bob", A);
    updateContact(c.id, { name: `Bob${RLO}${ZWSP}` });
    expect(loadContacts()[0].name).toBe("Bob");
  });

  it("a chat profile from the relay is cleaned", () => {
    const p = parseProfile(JSON.stringify({ name: `Mallory${RLO}`, about: `hi${ZWSP}there` }));
    expect(p.name).toBe("Mallory");
    expect(p.about).toBe("hithere");
  });

  it("a payment URI's label and memo are cleaned", () => {
    const r = parsePaymentUri(`${A}?amount=1&label=${encodeURIComponent("Shop" + RLO)}&memo=${encodeURIComponent("ref" + ZWSP + "42")}`);
    expect(r.label).toBe("Shop");
    expect(r.memo).toBe("ref42");
    // And the amount still parses, so cleaning did not disturb the rest.
    expect(r.amount).toBe("1");
  });
});

describe("the memo field is 512 BYTES, not 512 characters", () => {
  /**
   * walletd answers `memo too long (max 512 bytes)` with a 400, and the inputs capped at
   * 400 CHARACTERS — which is only the same thing in ASCII. So a memo written in most of
   * the languages this wallet ships in was rejected after the user had typed it and tapped
   * send: 400 Cyrillic or Arabic characters is 800 bytes, 400 CJK is 1200, 400 emoji 1600.
   */
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it("keeps a memo within the protocol's byte budget in every script", () => {
    // 600 characters, so the input exceeds 512 bytes in EVERY script including ASCII —
    // at 400 ASCII characters there is nothing to clamp, which is the whole point of the
    // old limit being wrong only for everybody else.
    for (const [label, ch] of [["ascii", "a"], ["cyrillic", "д"], ["arabic", "ش"], ["cjk", "字"], ["emoji", "😀"]]) {
      const clamped = clampUtf8Bytes(ch.repeat(600), MEMO_MAX_BYTES);
      expect(bytes(clamped), `${label} exceeded the field`).toBeLessThanOrEqual(MEMO_MAX_BYTES);
      // And it kept as much as actually fits rather than over-trimming to be safe: one more
      // character of this script would not have fitted. (4 = the widest UTF-8 character.)
      expect(bytes(clamped), `${label} was over-trimmed`).toBeGreaterThan(MEMO_MAX_BYTES - 4);
    }
  });

  it("lets an ASCII memo use the whole field, which 400 characters did not", () => {
    // The old cap was not merely wrong for multi-byte scripts, it was short for ASCII too.
    expect(clampUtf8Bytes("a".repeat(512), MEMO_MAX_BYTES).length).toBe(512);
  });

  it("never splits a character in half", () => {
    // Truncating by byte index would leave a lone surrogate or a partial sequence, which
    // renders as a replacement glyph — a memo ending in garbage looks like corruption.
    const clamped = clampUtf8Bytes("😀".repeat(400), MEMO_MAX_BYTES);
    expect(clamped).not.toContain("�");
    expect([...clamped].every((c) => c === "😀")).toBe(true);
    expect(bytes(clamped)).toBe(512);        // 128 × 4
  });

  it("leaves a short memo untouched", () => {
    expect(clampUtf8Bytes("rent for April", MEMO_MAX_BYTES)).toBe("rent for April");
    expect(clampUtf8Bytes("", MEMO_MAX_BYTES)).toBe("");
  });

  it("agrees with the limit walletd actually enforces", () => {
    // If the daemon's cap ever moves, this is the one place the client needs to follow.
    expect(MEMO_MAX_BYTES).toBe(512);
  });
});

describe("both memo inputs are wired to the byte clamp", () => {
  // The unit tests above prove clampUtf8Bytes is correct; they say nothing about whether
  // the inputs call it. These pin the wiring, which is the part that was broken.
  const app = readFileSync("src/App.tsx", "utf8");

  it("no memo input caps by character count any more", () => {
    expect(app).not.toContain("setMemo(e.target.value.slice(0, 400))");
    expect(app).not.toContain("maxLength={400}");
  });

  it("both the send memo and the payment-request memo clamp by bytes", () => {
    const uses = app.match(/setMemo\(clampUtf8Bytes\(e\.target\.value, MEMO_MAX_BYTES\)\)/g) ?? [];
    expect(uses.length, "send memo and payment-request memo").toBe(2);
  });
});
