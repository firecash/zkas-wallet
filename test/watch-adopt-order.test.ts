import { beforeEach, describe, expect, it, vi } from "vitest";

const { watch } = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("../src/api", () => ({ api: { watch }, getBase: () => "https://d.example" }));

/**
 * Adopting a view-only wallet has to store the key BEFORE telling the daemon about it.
 *
 * App.tsx states the rule for a spending seed: "Store the key BEFORE registering the wallet,
 * and only proceed once it is verifiably on the device: the reverse order can register a
 * wallet whose key never landed." `setWatchKey` writes raw and throws on purpose, so a full
 * or blocked store must abort the adopt — and in the old order that throw arrived AFTER
 * `api.watch` had registered the FVK and started scanning it, leaving a device holding a
 * token and no key. securestore describes exactly what the owner then sees: "the app treats
 * what is left as an ordinary wallet with no key — asking for a recovery phrase that never
 * existed for it".
 */
const FVK = "ab".repeat(96);

describe("adopting a view key stores it before registering it", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
    watch.mockReset();
  });

  it("does not register with the daemon when the key cannot be stored", async () => {
    const { adoptViewKey } = await import("../src/lib/watchadopt");
    watch.mockResolvedValue({ address: "zkas:test" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((k: string) => {
      if (String(k).startsWith("watch_fvk_")) throw new DOMException("QuotaExceededError");
    });

    await expect(adoptViewKey(FVK, 0)).rejects.toBeTruthy();
    // THE POINT: nothing was scanned on anyone's behalf.
    expect(watch).not.toHaveBeenCalled();
  });

  it("rejects a malformed key before making any network call", async () => {
    const { adoptViewKey } = await import("../src/lib/watchadopt");
    await expect(adoptViewKey("not-a-view-key", 0)).rejects.toBeTruthy();
    expect(watch).not.toHaveBeenCalled();
  });

  it("stores the key and registers it on the happy path", async () => {
    const { adoptViewKey } = await import("../src/lib/watchadopt");
    watch.mockResolvedValue({ address: "zkas:test" });

    await expect(adoptViewKey(FVK, 7)).resolves.toBe("zkas:test");

    expect(watch).toHaveBeenCalledWith(FVK.toLowerCase(), 7);
    const { watchKey, isWatchOnly } = await import("../src/lib/watchonly");
    expect(watchKey()).toBe(FVK.toLowerCase());
    expect(isWatchOnly()).toBe(true);
  });
});
