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
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* blocked, or full: the caller must not depend on this having worked */
  }
}

export function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
