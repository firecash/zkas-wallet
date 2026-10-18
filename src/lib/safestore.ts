/// localStorage that cannot take the app down.
///
/// The accessor itself throws when a browser blocks site data — Safari and
/// Firefox with "block all cookies", Chrome blocking third-party data in an
/// embedded context. Not `getItem` returning null: the property access throws
/// `SecurityError`.
///
/// Most of this codebase already knows that and wraps its reads. `wallet_token`
/// did not, in six separate places, and that one key was enough: a browser with
/// site data blocked showed "Something went wrong — SecurityError: Access is
/// denied for this document", with a Reload button that returned to the same
/// screen. No balance, no Send, no Receive, no way out.
///
/// A wallet that cannot remember anything is still worth more than one that
/// will not start: without storage it behaves like a fresh device, which is
/// honest and usable, rather than a crash screen.
/// What storage refused to keep, held for THIS PAGE's lifetime.
///
/// Without it "behaves like a fresh device" above was true of every CALL rather than every
/// session, and that is not the same thing. `getToken` mints a random wallet token when it
/// reads none, and it runs on every request: with storage blocked, nothing remembered the
/// minted value, so each request carried a DIFFERENT token and the daemon answered each one
/// with a different empty wallet. A balance could not even stay still between polls.
///
/// Deliberately not sessionStorage, which is itself blocked in the same browsers this
/// exists for. Lost on reload, which is the honest consequence of storage being refused.
const session = new Map<string, string>();

export function readLocal(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    // A key absent from a WORKING store may still be held here: writeLocal fell back for
    // it earlier in this session.
    if (v !== null) return v;
  } catch {
    /* accessor threw — fall through to what this session holds */
  }
  return session.get(key) ?? null;
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    // It stuck, so nothing needs holding; drop any earlier fallback for this key so the
    // two cannot disagree.
    session.delete(key);
    return;
  } catch {
    /* blocked, or full — keep it for this session instead of losing it outright */
  }
  session.set(key, value);
}

export function removeLocal(key: string): void {
  // Both copies, always. Clearing only the stored one would let a deleted key come back
  // from the fallback on the next read.
  session.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
