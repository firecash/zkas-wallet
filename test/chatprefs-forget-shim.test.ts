import { vi } from "vitest";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * lib/storage-shim swaps a BLOCKED localStorage for an in-memory Storage, and that substitute
 * is an object literal — so `Object.keys(localStorage)` returns its METHOD NAMES, not the
 * stored keys. forgetChat enumerated that way, so with site data blocked every per-room read
 * cursor survived "leave chat", which is precisely what the function promises to undo.
 *
 * Eight other enumerations in this codebase already use length/key(i), which the shim
 * implements deliberately. This test drives forgetChat against a shim-shaped store.
 */
function memoryStorage(): Storage {
  const mem = new Map<string, string>();
  return {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => void mem.delete(k),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
  } as Storage;
}

describe("leaving chat clears read cursors even on the in-memory shim", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Object.keys on a shim-shaped store really does hide the keys", () => {
    const shim = memoryStorage();
    shim.setItem("chat_seen_room1", "123");
    // This is the fact the bug rested on.
    expect(Object.keys(shim)).not.toContain("chat_seen_room1");
    expect(shim.length).toBe(1);
    expect(shim.key(0)).toBe("chat_seen_room1");
  });

  it("forgetChat removes every per-room cursor", async () => {
    const shim = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
    const prefs = await import("../src/lib/chatprefs");
    prefs.setMyChatPubkey("npub1example");
    for (const room of ["alpha", "beta", "gamma"]) prefs.markSeen(room, 1_700_000_000);
    // Something was actually stored, or the test proves nothing.
    expect(shim.length).toBeGreaterThan(1);
    prefs.forgetChat();
    const left: string[] = [];
    for (let i = 0; i < shim.length; i++) {
      const k = shim.key(i);
      if (k) left.push(k);
    }
    expect(left.filter((k) => k.startsWith("zkas_chat_lastseen_v1"))).toEqual([]);
    expect(left).toEqual([]);
  });
});
