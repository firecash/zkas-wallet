import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { api } from "../src/api";

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
      timeoutMs: 10_000,
      // No remote service chosen, so Rust talks to the embedded engine. A base
      // here would mean the call was being proxied somewhere else.
      base: null,
    });
    fetchMock.mockRestore();
  });

  it("preserves walletd HTTP errors instead of misreporting a dead engine", async () => {
    invoke.mockResolvedValue({ status: 401, body: JSON.stringify({ error: "missing or invalid bearer token" }) });
    await expect(api.status()).rejects.toThrow("missing or invalid bearer token");
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
