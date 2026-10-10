/// Make `localStorage` safe to touch, before anything touches it.
///
/// A browser that blocks site data throws from the ACCESSOR — `window.localStorage`
/// itself raises `SecurityError`, not `getItem` returning null. Safari and
/// Firefox do this with "block all cookies"; Chrome does it for third-party
/// data in an embedded context.
///
/// Most of this codebase wraps its reads, but "most" is not a guarantee across
/// a few hundred call sites, and a single unguarded one took the whole wallet
/// down: "Something went wrong — SecurityError", with a Reload button that
/// returned to the same screen. No balance, no Send, no Receive, no way out.
/// Guarding every call site individually is a rule that has to hold for ever;
/// this holds once.
///
/// Swapping in an in-memory store turns "storage is blocked" into "storage is
/// ephemeral": the wallet behaves like a fresh device for that session, which
/// is honest and usable. Nothing is silently lost that was not already going to
/// be — the browser was never going to persist it.
///
/// Imported for its side effect, FIRST, before any module that reads storage.
function install(): void {
  try {
    // Touching both halves: a browser can allow the getter and refuse writes.
    const probe = "__zkas_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return; // real storage works; leave it alone
  } catch {
    /* fall through and substitute */
  }
  const mem = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => void mem.delete(k),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
  };
  try {
    Object.defineProperty(window, "localStorage", { value: shim, configurable: true, writable: false });
  } catch {
    /* cannot even redefine it: the guarded readers in lib/safestore still hold */
  }
}

install();
