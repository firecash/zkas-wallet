import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSnapshot, saveSnapshot } from "../src/localtx";
import { readLocal } from "../src/lib/safestore";

/**
 * A browser with site storage BLOCKED — Safari "Block all cookies", Chrome "Don't allow
 * sites to save data". The accessor itself throws `SecurityError`; it does not return
 * null. safestore.ts exists for that, and its header records the cost of missing it:
 * `wallet_token` read raw left such a browser on "Something went wrong — Access is
 * denied", with a Reload button back to the same screen.
 *
 * These pin the two places found still reading it raw after that migration.
 */
function blockStorage() {
  // Both halves throw, which is what a blocked store actually does.
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Access is denied for this document.", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Access is denied for this document.", "SecurityError");
  });
}

describe("site storage blocked entirely", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("readLocal answers null instead of throwing", () => {
    blockStorage();
    expect(() => readLocal("wallet_token")).not.toThrow();
    expect(readLocal("wallet_token")).toBeNull();
  });

  it("the snapshot degrades to absent rather than taking its callers with it", () => {
    // snapKey() read the accessor directly while key() in the same file used readLocal.
    // The callers catch, so this was never a crash — but the last-known-balance net was
    // gone entirely on the browsers most likely to need it, instead of falling back to
    // the default token.
    blockStorage();
    expect(() => saveSnapshot({ balanceFc: 1, spendableFc: 1, maturingFc: 0, noteCount: 1, ts: Date.now() })).not.toThrow();
    expect(() => loadSnapshot()).not.toThrow();
    // This asserted `toBeNull()`, which pinned the behaviour of the raw accessor rather than
    // the property this test is named for. Both sides now go through safestore, so the
    // snapshot SURVIVES the page instead of being absent — strictly better, and still not
    // taking its callers with it. Across a reload it is gone either way, which is all a
    // last-known-balance net ever claimed.
    expect(loadSnapshot()?.balanceFc).toBe(1);
  });

  it("a working store still round-trips the snapshot", () => {
    // The guard must not cost the normal path.
    const snap = { balanceFc: 12.5, spendableFc: 12.5, maturingFc: 0, noteCount: 3, ts: Date.now() };
    saveSnapshot(snap);
    expect(loadSnapshot()).toMatchObject({ balanceFc: 12.5, noteCount: 3 });
  });
});

describe("the wallet stays coherent for a session when storage is blocked", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  it("keeps ONE wallet token across calls instead of minting a new one each time", async () => {
    // getToken runs on every request. With storage blocked it mints a token, and a raw
    // setItem THREW there, so the wallet could not issue a single call. Writing without
    // remembering would have been worse than the throw: every request would carry a
    // different token and the daemon would answer each with a different empty wallet —
    // a balance could not stay still between two polls.
    blockStorage();
    const { getToken } = await import("../src/api");
    const first = getToken();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(getToken()).toBe(first);
    expect(getToken()).toBe(first);
  });

  it("lets a wallet switch take effect for the session", async () => {
    blockStorage();
    const { switchWallet, activeToken } = await import("../src/wallets");
    expect(() => switchWallet("ff".repeat(16))).not.toThrow();
    // A raw setItem threw out of the click handler, so tapping another wallet did nothing
    // — not even the reload that follows it.
    expect(activeToken()).toBe("ff".repeat(16));
  });

  it("does not resurrect a key that was deliberately removed", async () => {
    // The fallback has to be cleared by removeLocal too, or a deleted value comes back on
    // the next read — which for a wallet token would resurrect a wallet the user removed.
    const { readLocal, writeLocal, removeLocal } = await import("../src/lib/safestore");
    blockStorage();
    writeLocal("k", "v");
    expect(readLocal("k")).toBe("v");
    removeLocal("k");
    expect(readLocal("k")).toBeNull();
  });

  it("prefers a WORKING store over a stale session value", async () => {
    const { readLocal, writeLocal } = await import("../src/lib/safestore");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    writeLocal("k2", "fallback");      // held in session
    spy.mockRestore();
    writeLocal("k2", "stored");        // storage works again
    expect(readLocal("k2")).toBe("stored");
    // And the fallback is gone, so the two cannot disagree later.
    localStorage.removeItem("k2");
    expect(readLocal("k2")).toBeNull();
  });
});

describe("reads that happen during RENDER", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  it("the receipt baseline answers null instead of throwing", async () => {
    // App.tsx reads this in a useRef initialiser, which runs during render, so a throw
    // here takes the whole wallet screen down rather than degrading. saveBaseline beside
    // it already wrapped its write; only the read was bare.
    blockStorage();
    const { loadBaseline } = await import("../src/receipts");
    expect(() => loadBaseline()).not.toThrow();
    expect(loadBaseline()).toBeNull();
  });

  it("a baseline still round-trips within the session when storage is blocked", async () => {
    blockStorage();
    const { loadBaseline, saveBaseline } = await import("../src/receipts");
    saveBaseline(12.5);
    // Held by safestore for this page, so arrival detection keeps working instead of
    // treating every poll as the first one it has ever seen.
    expect(loadBaseline()).toBe(12.5);
  });

  it("forgetting a wallet's receipts does not leave them to come back", async () => {
    const { saveBaseline, forgetReceipts, loadBaseline } = await import("../src/receipts");
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
    saveBaseline(9);
    forgetReceipts("0123456789abcdef0123456789abcdef");
    expect(loadBaseline()).toBeNull();
  });
});

describe("the request path itself on a storage-blocked browser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  it("can still work out where to send a request", async () => {
    // getBase is read on EVERY request, and through localEngine() from render paths too.
    // Fixing getToken alone was not enough: this threw just as fatally one line later, so
    // the wallet still could not issue a single call.
    blockStorage();
    const { getBase, getWalletdBearer } = await import("../src/api");
    expect(() => getBase()).not.toThrow();
    expect(getBase()).toMatch(/^https?:\/\//);
    expect(() => getWalletdBearer()).not.toThrow();
  });

  it("keeps a daemon the user chose for the session", async () => {
    blockStorage();
    const { getBase, setBase } = await import("../src/api");
    setBase("https://example.invalid/daemon");
    // Without the session fallback every call would snap back to the default, so the
    // service the user picked would never be the one actually used.
    expect(getBase()).toBe("https://example.invalid/daemon");
  });

  it("builds a header set without throwing", async () => {
    blockStorage();
    const { getToken, getWalletdBearer } = await import("../src/api");
    expect(() => ({ "X-Wallet-Token": getToken(), auth: getWalletdBearer() })).not.toThrow();
  });
});

describe("the app still STARTS when storage is blocked", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  /** A store that throws on the ENUMERATION too, which is what a blocked one does. */
  function blockEverything() {
    blockStorage();
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    });
    Object.defineProperty(Storage.prototype, "length", {
      configurable: true,
      get() { throw new DOMException("Access is denied for this document.", "SecurityError"); },
    });
  }

  it("isLockEnabled does not throw, so main.tsx can mount", async () => {
    // main.tsx reads this in a useState initialiser, which runs during render. It calls
    // legacyRecords(), whose loop touched localStorage.length with only the inner
    // JSON.parse guarded — so on such a browser the exception came before React had
    // mounted anything and the wallet never appeared at all.
    blockEverything();
    const { isLockEnabled } = await import("../src/applock");
    expect(() => isLockEnabled()).not.toThrow();
    expect(isLockEnabled()).toBe(false);
  });

  it("removing a wallet does not die partway through its key sweep", async () => {
    // "Remove wallet" enumerates keys to delete. Dying halfway would leave some of a
    // removed wallet's keys behind, which is worse than not starting the sweep.
    blockEverything();
    const { wipeWalletState } = await import("../src/walletstate");
    expect(() => wipeWalletState("0123456789abcdef0123456789abcdef")).not.toThrow();
  });

  it("asking what this device can sign does not throw either", async () => {
    blockEverything();
    const { deviceCanSign } = await import("../src/lib/deviceseed");
    await expect(deviceCanSign("zkas:p" + "a".repeat(80))).resolves.toBeDefined();
  });
});

describe("no render path reaches an unguarded storage read", () => {
  // The class that produced six bugs: a storage read reached from a useState/useRef
  // initialiser, which runs DURING RENDER, where the accessor throwing takes the component
  // down instead of degrading. The first five were found by reading; the last two
  // (bgSyncEnabled, isBiometricConfigured) only by sweeping TRANSITIVELY, because the
  // initialiser called a function that read storage rather than reading it inline.
  it("has no useState/useRef initialiser that can throw", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((e) => {
        const p = join(d, e);
        if (statSync(p).isDirectory()) return e === "signer" ? [] : walk(p);
        return /\.tsx?$/.test(e) && !p.includes("safestore") ? [p] : [];
      });
    const files = walk("src");
    const srcs = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

    // Functions whose body reads storage with no try around it.
    const risky = new Map<string, string>();
    for (const [f, src] of srcs) {
      for (const m of src.matchAll(/(?:export\s+)?function\s+([A-Za-z_]\w*)\s*\([^)]*\)[^{]*\{/g)) {
        const end = src.indexOf("\n}", m.index! + m[0].length);
        if (end < 0) continue;
        const body = src.slice(m.index! + m[0].length, end);
        if (/localStorage\.(getItem|length|key)\b/.test(body) && !/\btry\s*\{/.test(body)) {
          risky.set(m[1], f);
        }
      }
    }

    const offenders: string[] = [];
    for (const [f, src] of srcs) {
      for (const m of src.matchAll(/use(?:State|Ref)\(([^;]{0,200}?)\)(?:;|,)/gs)) {
        const arg = m[1];
        if (/localStorage\./.test(arg)) offenders.push(`${f}: inline localStorage in an initialiser`);
        for (const [name, where] of risky) {
          if (new RegExp(`\\b${name}\\s*\\(`).test(arg)) offenders.push(`${f}: initialiser calls ${name}() from ${where}`);
        }
      }
    }
    expect(offenders, "wrap the read (or route it through safestore) — a throw here kills the render").toEqual([]);
  });
});
