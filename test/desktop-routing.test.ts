// Where a desktop wallet call actually GOES.
//
// The desktop shell routes wallet calls through the Tauri command
// `wallet_api_request`, which hardcodes `http://127.0.0.1:{port}` in Rust. That
// is right for the embedded engine and WRONG for a wallet service the user
// deliberately chose: every "connected to Tor / the public service" call was
// answered by the local daemon instead, while the UI showed the remote as
// connected. Nothing caught it because no test asked which transport was used.

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";

const invoked: string[] = [];
const fetched: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    invoked.push(cmd);
    return { status: 200, body: "{}" };
  },
}));

beforeEach(() => {
  invoked.length = 0;
  fetched.length = 0;
  localStorage.clear();
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(String(url));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe("desktop request routing", () => {
  it("uses the embedded engine through Tauri when no remote is chosen", async () => {
    const { api } = await import("../src/api");
    await api.status();
    expect(invoked).toContain("wallet_api_request");
    expect(fetched).toHaveLength(0);
  });

  it("goes to the chosen wallet service, NOT the local engine", async () => {
    localStorage.setItem("desktop_remote_base", "https://wallet.zkas.info/daemon");
    localStorage.setItem("walletd_base", "https://wallet.zkas.info/daemon");
    const { api } = await import("../src/api");
    await api.status();
    // The whole point: this must not be answered by 127.0.0.1.
    expect(invoked).not.toContain("wallet_api_request");
    expect(fetched[0]).toContain("https://wallet.zkas.info/daemon");
  });

  it("routes a Tor onion off the loopback path too", async () => {
    localStorage.setItem("desktop_remote_base", "http://abc.onion");
    localStorage.setItem("walletd_base", "http://abc.onion");
    const { api } = await import("../src/api");
    await api.status().catch(() => undefined);
    expect(invoked).not.toContain("wallet_api_request");
    expect(fetched[0]).toContain("abc.onion");
  });
});
