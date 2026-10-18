import { beforeEach, describe, expect, it, vi } from "vitest";
import { addContact, findContact, displayName, loadContacts, removeContact, sortedContacts, updateContact } from "../src/contacts";

/**
 * The address book had no tests, and on a shielded chain it is the only thing that can say
 * who an address belongs to — the chain itself reveals nothing. A wrong entry here is a
 * payment to the wrong person.
 */
const A = "zkas:pxs3h3gk6ra8nvagka0lup93z6wffa5uhlhm2aj0slln24657z5ml8esvtty2dyfz0254dgxkga67l9";
const B = "zkas:p8kpjunj8r2wdeg6hc29v7duy89gz9zz44u08m9v2qhqqhucl0g9a0cfgc88eedf8n89fdquhl37njx";

describe("contacts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
  });

  it("finds a contact by address and prints its name", () => {
    addContact("Bob", A);
    expect(findContact(A)?.name).toBe("Bob");
    expect(displayName(A, "fallback")).toBe("Bob");
    expect(displayName(B, "fallback")).toBe("fallback");
  });

  it("renames rather than duplicating when the same address is saved twice", () => {
    addContact("Bob", A);
    addContact("Robert", A);
    expect(loadContacts()).toHaveLength(1);
    expect(findContact(A)?.name).toBe("Robert");
    // A duplicate would make "who is this?" ambiguous for every later payment.
  });

  it("keeps contacts separate per wallet token", () => {
    addContact("Bob", A);
    localStorage.setItem("wallet_token", "ffffffffffffffffffffffffffffffff");
    expect(loadContacts()).toHaveLength(0);
    // And the first wallet's book is untouched when we come back.
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
    expect(findContact(A)?.name).toBe("Bob");
  });

  it("does not confuse two contacts that share a name", () => {
    // Deduplication is by ADDRESS, so two people called Bob are two entries — the lookup
    // must still answer per address rather than by name.
    addContact("Bob", A);
    addContact("Bob", B);
    expect(loadContacts()).toHaveLength(2);
    expect(findContact(A)?.address).toBe(A);
    expect(findContact(B)?.address).toBe(B);
  });

  it("survives a corrupt or hostile stored book", () => {
    for (const junk of ['{"not":"an array"}', "[", "null", '"a string"', "[1,2,3]"]) {
      localStorage.setItem("contacts_0123456789abcdef0123456789abcdef", junk);
      expect(() => loadContacts()).not.toThrow();
      expect(Array.isArray(loadContacts())).toBe(true);
    }
  });

  it("saves and reads through safestore, so a blocked store does not lose the entry", () => {
    // save() is called from click handlers; a raw setItem threw out of them. Reading the
    // same way matters just as much — safestore holds what a blocked store refused, and a
    // raw read would not see it, so the contact would vanish the instant it was saved.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => addContact("Bob", A)).not.toThrow();
    expect(findContact(A)?.name).toBe("Bob");
  });

  it("removes and renames without disturbing the rest", () => {
    addContact("Bob", A);
    const c = addContact("Ann", B);
    updateContact(c.id, { name: "Anna" });
    expect(findContact(B)?.name).toBe("Anna");
    removeContact(c.id);
    expect(findContact(B)).toBeNull();
    expect(findContact(A)?.name).toBe("Bob");
  });

  it("sorts case-insensitively for display", () => {
    addContact("zoe", A);
    addContact("Ann", B);
    expect(sortedContacts().map((c) => c.name)).toEqual(["Ann", "zoe"]);
  });
});
