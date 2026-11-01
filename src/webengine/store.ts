// Browser wallet checkpoints in IndexedDB — one per wallet, keyed by a hash of its viewing key
// (never the key itself), so the page resumes where it stopped instead of rescanning.
//
// IndexedDB, not localStorage: a checkpoint is megabytes of binary (localStorage holds ~5 MB
// of strings per origin) and IndexedDB stores Uint8Array as-is. Every call is wrapped so a
// browser that refuses storage (private window, storage blocked) degrades to "no checkpoint":
// the wallet then scans from its birthday again, which is slow but correct.

const DB_NAME = "zkas-web-engine";
const STORE = "checkpoints";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = run(t.objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

/** The saved checkpoint for wallet `id`, or null when there is none or storage is unavailable. */
export async function loadCheckpoint(id: string): Promise<Uint8Array | null> {
  try {
    const v = await tx<unknown>("readonly", (s) => s.get(id));
    return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
  } catch {
    return null;
  }
}

/** Save wallet `id`'s checkpoint. False when storage refused it (quota, private window). */
export async function saveCheckpoint(id: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await tx("readwrite", (s) => s.put(bytes, id));
    return true;
  } catch {
    return false;
  }
}

export async function deleteCheckpoint(id: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* nothing to delete */
  }
}

/** A stable, non-reversible id for a wallet: SHA-256 of its viewing key, first 16 bytes. */
export async function walletIdFor(fvkHex: string): Promise<string> {
  const bytes = new Uint8Array(fvkHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
