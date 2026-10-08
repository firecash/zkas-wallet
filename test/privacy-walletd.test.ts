import { describe, it, expect, beforeEach, vi } from "vitest";

// The walletd base is the one egress path that carries key material: `fvk_hex`
// goes to /wallet/watch and /wallet/prepare, and the balance and full history
// come back over it. It was also the only path in the app that never asked the
// privacy gate — every other one does — and that hole was reachable, because
// leaving phone mode did not clear the Tor flag. The app reported "tor-only",
// `defaultBase()` fell back to the hosted CLEARNET daemon, and the viewing key
// went out in the clear from the real IP.
//
// The existing privacy-gate test covers the chain proxy, the price, the services
// directory and both chat sockets. It had no assertion about the wallet service,
// which is why this survived.
describe("the wallet service obeys the privacy gate", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("refuses a clearnet wallet service while Tor is on", async () => {
    localStorage.setItem("wallet_embedded_tor", "1");
    localStorage.setItem("walletd_base", "https://wallet.zkas.info/daemon");
    const { privacyMode } = await import("../src/lib/privacy");
    expect(privacyMode()).toBe("tor-only");
    const { api } = await import("../src/api");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(api.watch("ab".repeat(48), 0)).rejects.toThrow();
    expect(fetchSpy, "no request may leave for a clearnet host in tor-only mode").not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("allows loopback and .onion while Tor is on", async () => {
    localStorage.setItem("wallet_embedded_tor", "1");
    const { isOnionAddress, isPrivateHost } = await import("../src/api");
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.20")).toBe(true);
    expect(isOnionAddress("http://plqu6zzg5fakeonionaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion/daemon")).toBe(true);
  });

  it("leaving phone mode clears the Tor flag, so the mode cannot go stale", async () => {
    localStorage.setItem("wallet_embedded_tor", "1");
    localStorage.setItem("wallet_service_embedded", "1");
    const { setEmbeddedChosen } = await import("../src/embedded");
    setEmbeddedChosen(false);
    expect(localStorage.getItem("wallet_embedded_tor"), "the flag must not survive leaving phone mode").toBeNull();
    const { privacyMode } = await import("../src/lib/privacy");
    expect(privacyMode()).toBe("open");
  });
});
