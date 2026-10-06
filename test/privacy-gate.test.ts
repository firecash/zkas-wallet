// The network privacy gate.
//
// The bug this exists to prevent: every public-API call site used to decide for
// itself whether the wallet was "on Tor" by asking whether the walletd base URL
// looked like an onion. In phone mode that is false — the engine runs locally and
// Tor is a SOCKS proxy handed to the engine, not a URL — so the chain API, the
// explorer, the services directory, the price feed and the chat relay all
// concluded "not on Tor" and went out over clearnet from the user's real IP while
// the wallet's own switch said Tor was on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOR_KEY = "wallet_embedded_tor";
const BASE_KEY = "walletd_base";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  // Unstub FIRST: one test replaces localStorage with a throwing stub, and
  // clearing before restoring it would fail here instead of there.
  vi.unstubAllGlobals();
  localStorage.clear();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (globalThis as Record<string, unknown>).Capacitor;
});

async function privacy() {
  return import("../src/lib/privacy");
}

describe("the keys privacy.ts reads are the keys the app writes", () => {
  // privacy.ts imports nothing (api.ts imports it, and embedded.ts imports
  // api.ts, so importing either back would close a cycle). It therefore reads
  // both keys from storage by name — which is only safe if these assertions
  // hold, so they are the point of this block, not a formality.
  it("agrees with embedded.ts on the Tor flag", async () => {
    const { setEmbeddedTor, embeddedTor } = await import("../src/embedded");
    setEmbeddedTor(true);
    expect(localStorage.getItem(TOR_KEY)).toBe("1");
    expect((await privacy()).torEnabled()).toBe(true);
    setEmbeddedTor(false);
    expect(embeddedTor()).toBe(false);
    expect((await privacy()).torEnabled()).toBe(false);
  });

  it("agrees with api.ts on the walletd base", async () => {
    const { setBase, getBase } = await import("../src/api");
    setBase("http://abcdefghij234567.onion/daemon");
    expect(localStorage.getItem(BASE_KEY)).toContain(".onion");
    expect(getBase()).toContain(".onion");
    expect((await privacy()).onionBase()).toBe("http://abcdefghij234567.onion");
  });
});

describe("privacyMode", () => {
  it("is open with nothing configured", async () => {
    const p = await privacy();
    expect(p.privacyMode()).toBe("open");
    expect(p.clearnetAllowed()).toBe(true);
  });

  it("is onion when the wallet points at an onion", async () => {
    localStorage.setItem(BASE_KEY, "http://abcdefghij234567.onion/daemon");
    const p = await privacy();
    expect(p.privacyMode()).toBe("onion");
    expect(p.clearnetAllowed()).toBe(false);
    expect(p.publicEndpoint("/chain", "https://wallet.zkas.info/chain")).toBe(
      "http://abcdefghij234567.onion/chain",
    );
  });

  it("is tor-only in phone mode with Tor on — the case every call site got wrong", async () => {
    // No onion anywhere: the engine is local and Tor is its SOCKS proxy.
    localStorage.setItem(TOR_KEY, "1");
    const p = await privacy();
    expect(p.onionBase()).toBeNull();
    expect(p.privacyMode()).toBe("tor-only");
    expect(p.clearnetAllowed()).toBe(false);
    // The fallback is never returned: no private route means no request.
    expect(p.publicEndpoint("/chain", "https://wallet.zkas.info/chain")).toBeNull();
  });

  it("treats an unreadable storage as Tor off rather than guessing", async () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("private mode");
      },
      setItem() {},
      removeItem() {},
      clear() {},
    });
    const p = await privacy();
    expect(p.privacyMode()).toBe("open");
  });
});

describe("socketAllowed — the chat relay", () => {
  it("allows any relay when nothing is hidden", async () => {
    expect((await privacy()).socketAllowed("wss://zkas.info/chat-relay")).toBe(true);
  });

  it("refuses a clearnet relay with Tor on", async () => {
    localStorage.setItem(TOR_KEY, "1");
    expect((await privacy()).socketAllowed("wss://zkas.info/chat-relay")).toBe(false);
  });

  it("allows an onion relay with Tor on", async () => {
    localStorage.setItem(TOR_KEY, "1");
    expect((await privacy()).socketAllowed("ws://abcdefghij234567.onion/chat-relay")).toBe(true);
  });
});

describe("the gate is actually wired into the call sites", () => {
  it("chainTx makes no request at all in phone mode with Tor on", async () => {
    localStorage.setItem(TOR_KEY, "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { chainTx } = await import("../src/api");
    await expect(chainTx("abc")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the price feed makes no request in phone mode with Tor on", async () => {
    localStorage.setItem(TOR_KEY, "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { refreshPrice } = await import("../src/price");
    await refreshPrice();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the services directory refuses rather than fetching clearnet", async () => {
    localStorage.setItem(TOR_KEY, "1");
    const fetcher = vi.fn();
    const { refreshServicesDirectory } = await import("../src/services-directory");
    await expect(refreshServicesDirectory(fetcher as unknown as typeof fetch, null)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("the chat client opens no socket and reports why", async () => {
    localStorage.setItem(TOR_KEY, "1");
    const ctor = vi.fn();
    vi.stubGlobal("WebSocket", ctor);
    const { ChatClient, relayReachable } = await import("../src/chatclient");
    expect(relayReachable()).toBe(false);
    const states: string[] = [];
    new ChatClient("zkas-global", () => {}, (s) => states.push(s)).connect();
    expect(ctor).not.toHaveBeenCalled();
    expect(states).toEqual(["blocked"]);
  });

  it("the unread badge opens no socket either", async () => {
    localStorage.setItem(TOR_KEY, "1");
    const ctor = vi.fn();
    vi.stubGlobal("WebSocket", ctor);
    const { countSince } = await import("../src/chatclient");
    await expect(countSince("zkas-global", 0, "me")).resolves.toBe(0);
    expect(ctor).not.toHaveBeenCalled();
  });

  it("still reaches clearnet normally when Tor is off", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ confirmations: 3 }) }));
    vi.stubGlobal("fetch", fetchMock);
    const { chainTx } = await import("../src/api");
    await chainTx("abc");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/chain/transactions/abc");
  });
});
