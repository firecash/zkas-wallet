import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `installMirror` wraps setItem and removeItem. For WRITES the author reasoned the order out
 * explicitly: "The other order meant that when localStorage refused a write — iOS enforces a
 * quota, and a blocked store throws outright — the exception propagated and mirrorPut was
 * never reached." So writes mirror FIRST.
 *
 * Removes had the vulnerable order. `origRemove` can throw for exactly the same reason (a
 * blocked store throws on every access, not just writes), and `removeLocal` wraps the call in
 * a `catch` that swallows it. So the app believed the key was gone while the Keychain still
 * held it, and `mirrorRestore` — which restores any Keychain key missing from localStorage —
 * handed it straight back at the next launch.
 *
 * For "Remove wallet" that resurrects a removed wallet. For the lock screen's "erase this
 * device" it leaves the seed of a wallet somebody erased under duress sitting in the Keychain.
 * Same shape as the native background-sync preferences surviving that erase.
 */
const src = readFileSync("src/securestore.ts", "utf8");

describe("deleting a mirrored key always drops the mirrored copy", () => {
  it("drops in a finally, so a refusing store cannot skip it", () => {
    const i = src.indexOf("localStorage.removeItem = ");
    expect(i).toBeGreaterThan(0);
    const body = src.slice(i, i + 1400);
    expect(body).toContain("try {");
    expect(body).toContain("origRemove(key);");
    expect(body).toContain("} finally {");
    // The drop must be inside the finally, i.e. after it.
    expect(body.indexOf("} finally {")).toBeLessThan(body.indexOf("mirrorDrop(key)"));
  });

  it("still lets the removal throw, so loud callers stay loud", () => {
    const i = src.indexOf("localStorage.removeItem = ");
    const body = src.slice(i, i + 1400);
    // A catch would swallow it; only finally preserves the throw.
    expect(body).not.toMatch(/catch\s*(\(|\{)/);
  });

  it("writes still mirror BEFORE storing, which was already right", () => {
    const i = src.indexOf("localStorage.setItem = ");
    const body = src.slice(i, i + 1400);
    expect(body.indexOf("mirrorPut(key, value)")).toBeLessThan(body.indexOf("origSet(key, value)"));
  });

  it("restore still prefers what is already local", () => {
    // Otherwise a stale Keychain copy would overwrite a newer local value.
    const i = src.indexOf("export async function mirrorRestore");
    expect(src.slice(i, i + 700)).toContain('if (localStorage.getItem(key) !== null) continue;');
  });

  it("the seed, the lock record and the unseal flags are all mirrored", () => {
    // The lock record matters most: with the lock on, the seed is sealed inside it and the
    // cleartext copy is deleted, so mirroring the seed alone captured nothing.
    for (const k of ['key.startsWith("device_seed_")', 'key === "app_lock_v2"',
                     'key.startsWith("seed_unsealed_")', 'key === "device_mnemonic"']) {
      expect(src).toContain(k);
    }
  });
});
