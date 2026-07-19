// A broadcast payment's confirmation count is fetched from the public chain API.
// On the desktop (Tauri) shell the page origin is tauri://localhost, which serves
// no /chain route — so the same-origin path silently failed and every send was
// stuck reading "0-conf" forever. chainBase must reach the public host from any
// native shell, not only from Capacitor mobile.

import { afterEach, describe, expect, it, vi } from "vitest";

const REAL_ORIGIN = "https://wallet.zkas.info";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (globalThis as Record<string, unknown>).Capacitor;
});

async function chainUrlFor(txid: string): Promise<string> {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ confirmations: 7 }) }));
  vi.stubGlobal("fetch", fetchMock);
  const { chainTx } = await import("../src/api");
  await chainTx(txid);
  return fetchMock.mock.calls[0][0] as string;
}

describe("chainBase — where the confirmation lookup is sent", () => {
  it("uses the public host inside the Tauri desktop shell", async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const url = await chainUrlFor("abc");
    expect(url).toBe(`${REAL_ORIGIN}/chain/transactions/abc`);
  });

  it("uses the public host inside the Capacitor mobile shell", async () => {
    (globalThis as Record<string, unknown>).Capacitor = { isNativePlatform: () => true };
    const url = await chainUrlFor("abc");
    expect(url).toBe(`${REAL_ORIGIN}/chain/transactions/abc`);
  });

  it("stays same-origin on the hosted web page", async () => {
    // jsdom's default origin; the hosted page proxies /chain, so same-origin is right.
    const url = await chainUrlFor("abc");
    expect(url).toContain("/chain/transactions/abc");
    expect(url.startsWith("http://localhost")).toBe(true);
  });
});
