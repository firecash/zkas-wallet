import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, setBase } from "../src/api";
import { browserModeChosen, setBrowserModeChosen } from "../src/webengine";

// "Run in this browser" must never contact a wallet service: no registration, no viewing key,
// no payment preparation. Status is answered by the in-page engine; every other wallet-service
// call is refused before any request leaves the page.
describe("browser mode", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("answers status from the in-page engine and makes no network request", async () => {
    setBrowserModeChosen(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const s = await api.status();
    expect(s.has_wallet).toBe(true);
    expect(s.spend_ready).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never registers a viewing key with a service (or makes any other call)", async () => {
    setBrowserModeChosen(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(api.watch("ab".repeat(96), 1)).rejects.toThrow();
    await expect(api.send("zkas:x", 1)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is left when the user chooses a wallet service", () => {
    setBrowserModeChosen(true);
    setBase("https://wallet.zkas.info/daemon");
    expect(browserModeChosen()).toBe(false);
  });

  it("is off by default", () => {
    expect(browserModeChosen()).toBe(false);
  });
});
