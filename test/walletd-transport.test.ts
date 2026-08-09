import { afterEach, describe, expect, it } from "vitest";
import { normalizeDaemonInput, walletdTransportError } from "../src/api";

afterEach(() => {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe("walletd transport policy", () => {
  it("defaults a bare browser endpoint to HTTPS", () => {
    // A public HTTPS reverse proxy normally listens on 443. Port 8501 is the
    // plain backend and is filled automatically only by installed LAN clients.
    expect(normalizeDaemonInput("wallet.example.com")).toBe("https://wallet.example.com");
    expect(normalizeDaemonInput("wallet.example.com:9443")).toBe("https://wallet.example.com:9443");
    expect(walletdTransportError("http://wallet.example.com:8501")).toMatch(/web wallet.*HTTPS/i);
    expect(walletdTransportError("https://wallet.example.com:8501")).toBeNull();
  });

  it("allows plain HTTP from the desktop app", () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(normalizeDaemonInput("192.168.1.20")).toBe("http://192.168.1.20:8501");
    expect(normalizeDaemonInput("::1")).toBe("http://[::1]:8501");
    expect(normalizeDaemonInput("[2001:db8::20]:9000")).toBe("http://[2001:db8::20]:9000");
    expect(walletdTransportError("http://192.168.1.20:8501")).toBeNull();
  });

  it("allows plain HTTP from an installed mobile app", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    expect(normalizeDaemonInput("192.168.1.20:9000")).toBe("http://192.168.1.20:9000");
    expect(walletdTransportError("http://192.168.1.20:9000")).toBeNull();
  });
});
