import { beforeEach, describe, expect, it } from "vitest";
import { safeText, hasUnsafeText } from "../src/lib/safetext";
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
