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

export interface Contact {
  /// Stable id so a rename cannot orphan history references.
  id: string;
  name: string;
  address: string;
  note?: string;
  createdUnix: number;
}

function key(): string {
  return `contacts_${localStorage.getItem("wallet_token") || "default"}`;
}

export function loadContacts(): Contact[] {
  try {
    const raw = localStorage.getItem(key());
    if (!raw) return [];
    const list = JSON.parse(raw) as Contact[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list: Contact[]): void {
  localStorage.setItem(key(), JSON.stringify(list));
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
  const list = loadContacts();
  const existing = list.find((c) => norm(c.address) === norm(address));
  if (existing) {
    // Re-saving a known address renames it rather than creating a duplicate that
    // would make "who is this?" ambiguous later.
    existing.name = name.trim();
    if (note !== undefined) existing.note = note.trim() || undefined;
    save(list);
    return existing;
  }
  const c: Contact = {
    id: crypto.randomUUID(),
    name: name.trim(),
    address: address.trim(),
    note: note?.trim() || undefined,
    createdUnix: Math.floor(Date.now() / 1000),
  };
  list.push(c);
  save(list);
  return c;
}

export function updateContact(id: string, patch: Partial<Pick<Contact, "name" | "address" | "note">>): void {
  const list = loadContacts();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  if (patch.name !== undefined) c.name = patch.name.trim();
  if (patch.address !== undefined) c.address = patch.address.trim();
  if (patch.note !== undefined) c.note = patch.note.trim() || undefined;
  save(list);
}

export function removeContact(id: string): void {
  save(loadContacts().filter((c) => c.id !== id));
}

/** Contacts sorted for display: alphabetical, case-insensitive. */
export function sortedContacts(): Contact[] {
  return loadContacts().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
