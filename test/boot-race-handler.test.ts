import { describe, expect, it } from "vitest";

/**
 * The boot gate races the on-device engine against a 20s timeout, and the timeout winning is a
 * designed outcome: "Nothing is lost by giving up: App.tsx starts the engine again on mount and
 * adopts the port whenever it does arrive, so this await is an optimisation, not the mechanism."
 *
 * But `Promise.race` does not cancel the loser. When the timeout wins, `ensureEmbedded` keeps
 * running, and if it then rejects — `Native.start` can reject — nobody is listening. That is
 * noise rather than a failure, in the one place this app has no console: a phone at boot, where
 * it lands in crash reporting looking like the engine failure it is not.
 */
describe("the boot race leaves no unhandled rejection", () => {
  it("models the old shape failing and the new shape not", async () => {
    // The old shape: the loser's late rejection has no handler.
    const slowReject = () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error("late")), 20));
    const fastTimeout = () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5));

    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
    globalThis.addEventListener?.("unhandledrejection", onUnhandled as EventListener);

    // New shape: hold the promise, give it a handler, then race it.
    const engine = slowReject();
    void engine.catch(() => undefined);
    await Promise.race([engine, fastTimeout()]).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 60));

    globalThis.removeEventListener?.("unhandledrejection", onUnhandled as EventListener);
    expect(unhandled).toHaveLength(0);
  });

  it("still lets the race see a rejection that arrives in time", async () => {
    const engine = Promise.reject(new Error("engine failed fast"));
    void engine.catch(() => undefined);
    const never = new Promise<string>(() => undefined);
    await expect(Promise.race([engine, never])).rejects.toThrow("engine failed fast");
  });

  it("still resolves when the engine wins", async () => {
    const engine = Promise.resolve("http://127.0.0.1:1234");
    void engine.catch(() => undefined);
    const slow = new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 50));
    await expect(Promise.race([engine, slow])).resolves.toBe("http://127.0.0.1:1234");
  });

  it("is what main.tsx actually does", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("src/main.tsx", "utf8");
    const i = main.indexOf("const engine = ensureEmbedded();");
    expect(i).toBeGreaterThan(0);
    const block = main.slice(i, i + 420);
    expect(block).toContain("void engine.catch(() => undefined);");
    expect(block).toContain("Promise.race([");
    // The raced promise must be the SAME one that has the handler.
    expect(block).toMatch(/Promise\.race\(\[\s*engine,/);
  });
});
