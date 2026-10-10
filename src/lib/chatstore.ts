/// Chat history kept on this device, so opening a room does not re-download it.
///
/// Before this, every launch pulled the last seven days of every room the user
/// visited — 200 notes and 500 reactions per room — and re-fetched up to 500
/// gift wraps, each needing its own decrypt attempt before we could tell
/// whether it was even for us. Switching rooms threw the lot away and did it
/// again. The relay was being used as the only copy of data the device had
/// already seen.
///
/// IndexedDB rather than localStorage. Chat is the one part of this app whose
/// data has no natural bound: localStorage is synchronous (so every write
/// blocks the frame), capped at a few megabytes shared with the wallet's own
/// records, and throws when full. A room with a year of history belongs in a
/// store built for it.
///
/// WHAT THIS MEANS FOR PRIVACY. Messages now sit on the device until something
/// removes them, the same as transaction history, contacts and memos already
/// do. `forgetAllChat` is wired into "leave chat" and into wallet removal, and
/// DMs are scoped per chat identity so two wallets on one phone can never read
/// each other's conversations.
const DB_NAME = "zkas-chat";
const DB_VERSION = 1;
const NOTES = "notes";
const DMS = "dms";
const META = "meta";

/// Per room. A phone does not need a year of a busy room to open it, and the
/// prune keeps the newest, which is what anyone scrolling back starts from.
const MAX_NOTES_PER_ROOM = 600;
/// Per conversation. DMs are the ones a user most expects to still be there.
const MAX_DMS_PER_PEER = 1000;

export type StoredNote = {
  id: string;
  room: string;
  created_at: number;
  /** The whole signed event, so a cached note renders exactly like a live one. */
  event: unknown;
};

export type StoredDm = {
  id: string;
  /** Chat identity this belongs to — never mixed between wallets. */
  me: string;
  peer: string;
  sender: string;
  content: string;
  created_at: number;
  mine?: boolean;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(NOTES)) {
          const s = db.createObjectStore(NOTES, { keyPath: "id" });
          // Newest-first reads per room, which is the only way this is read.
          s.createIndex("room_time", ["room", "created_at"]);
        }
        if (!db.objectStoreNames.contains(DMS)) {
          const s = db.createObjectStore(DMS, { keyPath: "id" });
          s.createIndex("me_peer_time", ["me", "peer", "created_at"]);
          s.createIndex("me_time", ["me", "created_at"]);
        }
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      // A blocked or unavailable database is not a reason to break chat: every
      // caller treats null as "no cache" and falls back to the relay.
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const t = db.transaction(store, mode);
          const req = run(t.objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          t.onerror = () => resolve(null);
          t.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// --- rooms ----------------------------------------------------------------

/** The newest `limit` notes of a room, oldest-first, ready to render. */
export async function loadRoom(room: string, limit = 200): Promise<unknown[]> {
  const db = await open();
  if (!db) return [];
  return new Promise((resolve) => {
    const out: StoredNote[] = [];
    try {
      const idx = db.transaction(NOTES, "readonly").objectStore(NOTES).index("room_time");
      // Walk DOWN from the newest and stop at `limit`, rather than reading the
      // room and sorting: a long-lived room would otherwise load entirely just
      // to show a screenful.
      const range = IDBKeyRange.bound([room, -Infinity], [room, Infinity]);
      const cur = idx.openCursor(range, "prev");
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || out.length >= limit) {
          resolve(out.reverse().map((n) => n.event));
          return;
        }
        out.push(c.value as StoredNote);
        c.continue();
      };
      cur.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Remember notes, and keep the room from growing without bound. */
export async function saveNotes(room: string, events: { id: string; created_at: number }[]): Promise<void> {
  const db = await open();
  if (!db || !events.length) return;
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(NOTES, "readwrite");
      const s = t.objectStore(NOTES);
      for (const ev of events) {
        if (!ev?.id || typeof ev.created_at !== "number") continue;
        s.put({ id: ev.id, room, created_at: ev.created_at, event: ev } satisfies StoredNote);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
      t.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  await pruneRoom(room);
}

async function pruneRoom(room: string): Promise<void> {
  const db = await open();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(NOTES, "readwrite");
      const idx = t.objectStore(NOTES).index("room_time");
      const range = IDBKeyRange.bound([room, -Infinity], [room, Infinity]);
      let seen = 0;
      const cur = idx.openCursor(range, "prev");
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        seen += 1;
        // Everything past the cap is older than everything kept, because the
        // walk is newest-first.
        if (seen > MAX_NOTES_PER_ROOM) c.delete();
        c.continue();
      };
      cur.onerror = () => resolve();
      t.oncomplete = () => resolve();
    } catch {
      resolve();
    }
  });
}

// --- private messages -----------------------------------------------------

/** Every conversation this identity holds, oldest-first within each. */
export async function loadDms(me: string): Promise<Map<string, StoredDm[]>> {
  const db = await open();
  const threads = new Map<string, StoredDm[]>();
  if (!db || !me) return threads;
  return new Promise((resolve) => {
    try {
      const idx = db.transaction(DMS, "readonly").objectStore(DMS).index("me_time");
      const range = IDBKeyRange.bound([me, -Infinity], [me, Infinity]);
      const cur = idx.openCursor(range, "next");
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve(threads);
        const row = c.value as StoredDm;
        const list = threads.get(row.peer) ?? [];
        list.push(row);
        threads.set(row.peer, list);
        c.continue();
      };
      cur.onerror = () => resolve(threads);
    } catch {
      resolve(threads);
    }
  });
}

export async function saveDm(row: StoredDm): Promise<void> {
  const db = await open();
  if (!db || !row?.id || !row.me) return;
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(DMS, "readwrite");
      t.objectStore(DMS).put(row);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
      t.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// --- cursors --------------------------------------------------------------

/**
 * The newest `created_at` held for a key, minus an overlap.
 *
 * The overlap is the whole reason this is a function and not a stored number.
 * A relay can deliver an event whose `created_at` is a little older than one
 * already received — clock skew between authors, or simple out-of-order
 * delivery — and asking for `since = exactly what we hold` would skip it for
 * ever. Re-fetching a few minutes of overlap is cheap; a hole in the history is
 * permanent.
 */
const CURSOR_OVERLAP_SEC = 300;

export async function cursor(key: string): Promise<number> {
  const row = await tx<{ key: string; at: number }>(META, "readonly", (s) => s.get(key) as IDBRequest<{ key: string; at: number }>);
  const at = row?.at ?? 0;
  return at > 0 ? Math.max(0, at - CURSOR_OVERLAP_SEC) : 0;
}

export async function setCursor(key: string, at: number): Promise<void> {
  if (!(at > 0)) return;
  const row = await tx<{ key: string; at: number }>(META, "readonly", (s) => s.get(key) as IDBRequest<{ key: string; at: number }>);
  if (row && row.at >= at) return; // never moves backwards
  await tx(META, "readwrite", (s) => s.put({ key, at }) as IDBRequest<IDBValidKey>);
}

// --- forgetting -----------------------------------------------------------

/**
 * Remove everything. Wired into "leave chat" and into wallet removal, because
 * history that outlives the wallet it belonged to is not something the user
 * asked to keep.
 */
export async function forgetAllChat(): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction([NOTES, DMS, META], "readwrite");
      t.objectStore(NOTES).clear();
      t.objectStore(DMS).clear();
      t.objectStore(META).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
      t.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Drop one identity's private messages, leaving public rooms alone. */
export async function forgetDmsFor(me: string): Promise<void> {
  const db = await open();
  if (!db || !me) return;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(DMS, "readwrite");
      const idx = t.objectStore(DMS).index("me_time");
      const cur = idx.openCursor(IDBKeyRange.bound([me, -Infinity], [me, Infinity]));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        c.delete();
        c.continue();
      };
      cur.onerror = () => resolve();
      t.oncomplete = () => resolve();
    } catch {
      resolve();
    }
  });
}

export const __test = { MAX_NOTES_PER_ROOM, MAX_DMS_PER_PEER, CURSOR_OVERLAP_SEC };
