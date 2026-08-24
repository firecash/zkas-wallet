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

const invokeArgs: Record<string, unknown>[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    invoked.push(cmd);
    invokeArgs.push(args);
    return { status: 200, body: "{}" };
  },
}));

beforeEach(() => {
  invoked.length = 0;
  invokeArgs.length = 0;
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
    // Through Rust, which is not subject to CORS — a fetch from the WebView is
    // blocked outright, because tauri://localhost is not in the service's
    // allowlist while Android's https://localhost is. That asymmetry is the
    // entire reason the public service worked on Android and not on desktop.
    expect(invoked).toContain("wallet_api_request");
    expect(invokeArgs[0].base).toBe("https://wallet.zkas.info/daemon");
    expect(fetched).toHaveLength(0);
  });

  it("probes a service over the same transport it will actually use", async () => {
    // Probing with fetch declared the public service unreachable ("Load failed")
    // on CORS alone, while every real call to it would have succeeded.
    const { findReachableDaemon } = await import("../src/api");
    await findReachableDaemon("https://wallet.zkas.info/daemon").catch(() => undefined);
    expect(fetched).toHaveLength(0);
    expect(invoked.filter((c) => c === "wallet_api_request").length).toBeGreaterThan(0);
  });

  it("sends a Tor onion through Rust, which owns the SOCKS proxy", async () => {
    // The WebView has no SOCKS, so a fetch to .onion cannot work — this one has
    // to go through Rust, and it has to carry the onion base with it.
    localStorage.setItem("desktop_remote_base", "http://abc.onion");
    localStorage.setItem("walletd_base", "http://abc.onion");
    const { api } = await import("../src/api");
    await api.status();
    expect(invoked).toContain("wallet_api_request");
    expect(invokeArgs[0].base).toBe("http://abc.onion");
    expect(fetched).toHaveLength(0);
  });

  it("does not hand the embedded-engine path a base", async () => {
    const { api } = await import("../src/api");
    await api.status();
    expect(invokeArgs[0].base).toBeNull();
  });
});
