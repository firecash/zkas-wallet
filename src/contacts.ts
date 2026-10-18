
// The address book.
//
// On a shielded chain every address is ~79 characters of bech32 noise, and the
// chain itself reveals nothing — so unless the wallet remembers who an address
// belongs to, nobody can. That makes a local address book more load-bearing here
// than on a transparent chain: it is the ONLY place a payment can acquire a
// human name.
//
// Kept per wallet token and never sent anywhere: contacts are a map of who you
// pay, which is exactly the metadata this project exists to keep private. They
// live beside the wallet's other device state and leave with it.

import { readLocal, writeLocal } from "./lib/safestore";
import { safeText } from "./lib/safetext";
export interface Contact {
  /// Stable id so a rename cannot orphan history references.
  id: string;
  name: string;
  address: string;
  note?: string;
  createdUnix: number;
}

function key(): string {
  return `contacts_${readLocal("wallet_token") || "default"}`;
}

export function loadContacts(): Contact[] {
  try {
    const raw = readLocal(key());
    if (!raw) return [];
    const list = JSON.parse(raw) as Contact[];
    if (!Array.isArray(list)) return [];
    const gone = new Set(tombstones());
    return gone.size ? list.filter((c) => !gone.has(c.id)) : list;
  } catch {
    return [];
  }
}

/**
 * Apply a change to the stored book, reading it at the moment of WRITING.
 *
 * Same reason as localtx's `mutate`: every writer here was read -> change -> write the WHOLE
 * list, and two tabs share this storage, so one tab's new or renamed contact was erased by
 * the other's next write. Lower stakes than a send record — an address book entry, not
 * money — but on a shielded chain this book is the only thing that says who an address
 * belongs to, so losing an entry loses that permanently.
 *
 * Re-reading inside the writer closes it to the gap between these two statements, which no
 * other tab can interleave because each is synchronous.
 */
/// Contacts the user has DELETED, so a stale write from another tab cannot bring one back.
///
/// `mutate` closes the lost-update window for additions and renames, but not for removal:
/// that is the one change another tab can undo by writing a list it read first, and the
/// result is a contact reappearing after the user deleted it. The registry solved the same
/// problem the same way for wallets.
///
/// Keyed by contact ID rather than address, which is what makes this simpler than the
/// wallet version: re-adding the same ADDRESS mints a fresh id, so a deliberate re-add is
/// never filtered and nothing has to clear a tombstone. Capped, because this exists to beat
/// an in-flight write from another tab rather than to remember every deletion.
const GONE_KEY_PREFIX = "contacts_removed_";
const GONE_MAX = 50;

function goneKey(): string {
  return `${GONE_KEY_PREFIX}${readLocal("wallet_token") || "default"}`;
}

function tombstones(): string[] {
  try {
    const raw = readLocal(goneKey());
    const v = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function mutate(fn: (list: Contact[]) => Contact[]): Contact[] {
  const next = fn(loadContacts());
  save(next);
  return next;
}

function save(list: Contact[]): void {
  // Through safestore, read and write BOTH: this is called from click handlers ("Save as
  // contact", rename, delete), and a raw setItem throws out of them on a full or blocked
  // store — the same failure the wallet registry had. Reading the same way matters just as
  // much: safestore holds what a blocked store refused, and a raw read here would not see
  // it, so a contact would vanish the instant it was saved.
  writeLocal(key(), JSON.stringify(list));
  // Let every mounted view refresh without prop-drilling a store through the app.
  window.dispatchEvent(new CustomEvent("contacts-changed"));
}

/** Normalised form for comparison — addresses are case-insensitive bech32. */
function norm(address: string): string {
  return address.trim().toLowerCase();
}

/** The contact for an address, if we know it. */
export function findContact(address: string | null | undefined): Contact | null {
  if (!address) return null;
  const n = norm(address);
  return loadContacts().find((c) => norm(c.address) === n) ?? null;
}

/** A contact's name, or a shortened address — what the UI should print. */
export function displayName(address: string | null | undefined, fallback: string): string {
  return findContact(address)?.name ?? fallback;
}

export function addContact(name: string, address: string, note?: string): Contact {
  let result: Contact | null = null;
  mutate((list) => {
    const existing = list.find((c) => norm(c.address) === norm(address));
    if (existing) {
      // Re-saving a known address renames it rather than creating a duplicate that
      // would make "who is this?" ambiguous later.
      existing.name = safeText(name);
      if (note !== undefined) existing.note = safeText(note) || undefined;
      result = existing;
      return list;
    }
    const c: Contact = {
      id: crypto.randomUUID(),
      // safeText, not trim: a name is rendered BESIDE an address, and displayName() puts
      // it where the address would otherwise be, so a bidi override in it can reorder that
      // address on screen. See lib/safetext.
      name: safeText(name),
      address: address.trim(),
      note: note ? safeText(note) || undefined : undefined,
      createdUnix: Math.floor(Date.now() / 1000),
    };
    result = c;
    return [...list, c];
  });
  // Non-null by construction: every branch above assigns it.
  return result as unknown as Contact;
}

export function updateContact(id: string, patch: Partial<Pick<Contact, "name" | "address" | "note">>): void {
  mutate((list) => {
    const c = list.find((x) => x.id === id);
    if (!c) return list;
    if (patch.name !== undefined) c.name = safeText(patch.name);
    if (patch.address !== undefined) c.address = patch.address.trim();
    if (patch.note !== undefined) c.note = safeText(patch.note) || undefined;
    return list;
  });
}

export function removeContact(id: string): void {
  // Tombstone FIRST, so a write landing between these two statements cannot resurrect it.
  const gone = tombstones().filter((t) => t !== id);
  gone.push(id);
  writeLocal(goneKey(), JSON.stringify(gone.slice(-GONE_MAX)));
  mutate((list) => list.filter((c) => c.id !== id));
}

/** Contacts sorted for display: alphabetical, case-insensitive. */
export function sortedContacts(): Contact[] {
  return loadContacts().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
