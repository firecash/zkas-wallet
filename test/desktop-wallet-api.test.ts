import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { api, WalletdUnauthorizedError } from "../src/api";

describe("desktop embedded wallet transport", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invoke.mockReset();
  });

  afterEach(() => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("uses the Rust-owned current port instead of a cached WebView URL", async () => {
    localStorage.setItem("walletd_base", "http://127.0.0.1:59363");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    invoke.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ has_wallet: false, network: "mainnet" }),
    });

    await expect(api.status()).resolves.toMatchObject({ has_wallet: false, network: "mainnet" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("wallet_api_request", {
      method: "GET",
      path: "/api/status",
      body: null,
      walletToken: "0123456789abcdef0123456789abcdef",
      // 4s because this case is a LOCAL engine (loopback base), which holds its one
      // wallet in memory and answers from it. The hosted daemon gets the 10s default
      // instead: it loads a wallet from its checkpoint first, measured at a ~11-13s
      // median, so a 4s bound there called a working service unreachable.
      timeoutMs: 4_000,
      // No remote service chosen, so Rust talks to the embedded engine. A base
      // here would mean the call was being proxied somewhere else.
      base: null,
    });
    fetchMock.mockRestore();
  });

  it("preserves walletd HTTP errors instead of misreporting a dead engine", async () => {
    invoke.mockResolvedValue({ status: 401, body: JSON.stringify({ error: "missing or invalid bearer token" }) });
    // Pins BOTH halves, because each on its own was once wrong here.
    //
    // The daemon's own words have to survive (this test's original point: a 401 was being
    // reported as a dead engine) AND the failure has to be recognisable as an auth
    // failure rather than a transport one. When the error was a bare Error carrying the
    // daemon's string, the status poll counted it like a dead socket and announced
    // "Can't reach the wallet service" for a daemon that was answering every request and
    // only refusing the token.
    const err = await api.status().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WalletdUnauthorizedError);
    expect((err as WalletdUnauthorizedError).detail).toBe("missing or invalid bearer token");
    // And the text the user reads is not the raw bearer-token jargon.
    expect((err as Error).message).not.toContain("bearer");
  });

  it("imports through Rust instead of WebView CORS", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    invoke.mockResolvedValue({ status: 200, body: JSON.stringify({ address: "zkas:test" }) });
    await expect(api.watch("00".repeat(96), 123)).resolves.toEqual({ address: "zkas:test" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("wallet_api_request", expect.objectContaining({
      method: "POST",
      path: "/api/wallet/watch",
    }));
    fetchMock.mockRestore();
  });
});

describe("backgrounding writes a checkpoint on every shell", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "0123456789abcdef0123456789abcdef");
    localStorage.setItem("walletd_base", "http://127.0.0.1:59363");
    invoke.mockReset();
  });

  it("goes through Rust on desktop rather than the WebView", async () => {
    // A raw keepalive fetch was used for all shells. On desktop that request leaves the
    // `tauri://localhost` origin and aims at whatever port localStorage happens to hold,
    // while Rust owns the real one and can have restarted the engine on another — so it
    // was CORS-exposed and possibly aimed at nothing, and the best-effort catch hid both.
    // The checkpoint the hide was added to write was never written on desktop.
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const fetchMock = vi.spyOn(globalThis, "fetch");
    invoke.mockResolvedValue({ status: 200, body: "{}" });

    const { checkpointNow } = await import("../src/api");
    await checkpointNow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("wallet_api_request", expect.objectContaining({
      method: "POST",
      path: "/api/checkpoint",
    }));
    fetchMock.mockRestore();
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("uses a keepalive fetch on web and mobile, where the page is going away", async () => {
    // keepalive is the point here: on Android the process can be frozen or killed right
    // after this, and a cancelled request means the scan is redone from the last
    // periodic checkpoint — which users saw as progress returning to zero.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const { checkpointNow } = await import("../src/api");
    await checkpointNow();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:59363/api/checkpoint",
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
    fetchMock.mockRestore();
  });
});
