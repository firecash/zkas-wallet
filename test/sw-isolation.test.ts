import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// public/sw.js serves the app cross-origin isolated (COOP/COEP) only after the page said the
// wallet runs in this browser, so the engine can load its multi-threaded build without any
// server header. Run the real worker against fake caches and network.
function load() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    open: async (n: string) => {
      if (!stores.has(n)) stores.set(n, new Map());
      const m = stores.get(n)!;
      return {
        match: async (k: string | Request) => m.get(typeof k === "string" ? k : new URL(k.url).pathname)?.clone(),
        put: async (k: string | Request, r: Response) => void m.set(typeof k === "string" ? k : new URL(k.url).pathname, r),
        delete: async (k: string) => m.delete(k),
        addAll: async () => undefined,
      };
    },
    match: async (k: string | Request) => {
      for (const m of stores.values()) {
        const r = m.get(typeof k === "string" ? k : new URL(k.url).pathname);
        if (r) return r.clone();
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
  };
  const self = { addEventListener: (t: string, f: (e: unknown) => void) => (handlers[t] = f), location: { origin: "https://w.test" }, skipWaiting: () => undefined, clients: { claim: () => undefined } };
  const fetch = async () => new Response("<html>", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'" } });
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, caches, fetch, Response, Headers, URL, Promise });
  const nav = async (path = "/") => {
    let out: Promise<Response> | undefined;
    handlers.fetch({ request: { method: "GET", url: `https://w.test${path}`, mode: path === "/" ? "navigate" : "no-cors" }, respondWith: (p: Promise<Response>) => (out = p) });
    return out ? await out : undefined;
  };
  const flag = async (on: boolean) => {
    let done: Promise<unknown> | undefined;
    let ack: unknown;
    handlers.message({ data: { type: "coi", on }, ports: [{ postMessage: (m: unknown) => (ack = m) }], waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    return ack;
  };
  return { nav, flag, handlers, caches, stores };
}

describe("service worker cross-origin isolation", () => {
  it("adds nothing until the page asks", async () => {
    const w = load();
    const r = (await w.nav())!;
    expect(r.headers.get("cross-origin-embedder-policy")).toBeNull();
    expect(r.headers.get("cross-origin-opener-policy")).toBeNull();
  });

  it("isolates pages and assets once asked, keeping every other header", async () => {
    const w = load();
    expect(await w.flag(true)).toEqual({ ok: true });
    const r = (await w.nav())!;
    expect(r.headers.get("cross-origin-embedder-policy")).toBe("credentialless");
    expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(await r.text()).toBe("<html>");
    const a = (await w.nav("/assets/worker-x.js"))!;
    expect(a.headers.get("cross-origin-embedder-policy")).toBe("credentialless");
  });

  it("turns off again, and the choice survives a new release's cache purge", async () => {
    const w = load();
    await w.flag(true);
    let done: Promise<unknown> | undefined;
    w.handlers.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect((await w.nav())!.headers.get("cross-origin-embedder-policy")).toBe("credentialless");
    await w.flag(false);
    expect((await w.nav())!.headers.get("cross-origin-embedder-policy")).toBeNull();
  });

  it("never touches the wallet service, chain or gateway requests", async () => {
    const w = load();
    await w.flag(true);
    expect(await w.nav("/chain-gateway/tip")).toBeUndefined();
    expect(await w.nav("/api/status")).toBeUndefined();
  });
});
