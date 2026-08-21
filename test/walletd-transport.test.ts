import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonEndpointCandidates, findReachableDaemon, normalizeDaemonInput, walletdTransportError } from "../src/api";

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
    expect(daemonEndpointCandidates("192.168.1.20")).toEqual([
      "http://192.168.1.20:8501",
      "https://192.168.1.20:8501",
    ]);
    expect(daemonEndpointCandidates("https://192.168.1.20:8501")).toEqual(["https://192.168.1.20:8501"]);
  });

  it("allows plain HTTP from an installed mobile app", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    expect(normalizeDaemonInput("192.168.1.20:9000")).toBe("http://192.168.1.20:9000");
    expect(walletdTransportError("http://192.168.1.20:9000")).toBeNull();
  });

  it("accepts .onion services over http on every platform (Tor encrypts them)", () => {
    const onion = "abcdefghij234567.onion";
    // Onion is http, never forced to HTTPS, even from a plain browser.
    expect(normalizeDaemonInput(onion)).toBe(`http://${onion}`);
    expect(normalizeDaemonInput(`${onion}:8501`)).toBe(`http://${onion}:8501`);
    // Browser (no installed-app flags set): still allowed, because .onion is encrypted.
    expect(walletdTransportError(`http://${onion}`)).toBeNull();
    expect(walletdTransportError(`http://${onion}:8501`)).toBeNull();
    // Bare onion tries the virtual port 80 and the walletd default; an explicit port wins.
    expect(daemonEndpointCandidates(onion)).toEqual([`http://${onion}`, `http://${onion}:8501`]);
    expect(daemonEndpointCandidates(`${onion}:9000`)).toEqual([`http://${onion}:9000`]);
  });

  it("uses the transport that actually answers", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(findReachableDaemon("192.168.1.20", "lan-token", 100)).resolves.toBe("https://192.168.1.20:8501");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://192.168.1.20:8501/health", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://192.168.1.20:8501/health", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://192.168.1.20:8501/api/status", expect.any(Object));
    fetchMock.mockRestore();
  });

  // The failure a user hits after typing the right address and the wrong token.
  // It must name the token, not the network: the previous message was a bare
  // transport error, so the address and the firewall were blamed instead.
  it("separates a rejected token from an unreachable service", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("missing or invalid bearer token", { status: 401 }));
    await expect(findReachableDaemon("192.168.1.20", "wrong-token", 100)).rejects.toThrow(/rejected the access token/i);
    // The other transport is NOT tried: the service answered, so retrying HTTPS
    // would only replace a precise diagnosis with a vague one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it("reports every transport it tried when nothing answers", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(findReachableDaemon("192.168.1.20", "lan-token", 100)).rejects.toThrow(
      /http:\/\/192\.168\.1\.20:8501.*https:\/\/192\.168\.1\.20:8501/s,
    );
    fetchMock.mockRestore();
  });
});
