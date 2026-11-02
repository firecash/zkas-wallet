import { describe, it, expect } from "vitest";
import { runSync, type EngineLike, type SyncDeps, ANCHOR_CACHE_MS } from "../src/webengine/sync";

// A reload used to make five round trips in a row (tip, manifest, page, tree check, anchor)
// before "synced"; through the wallet.zkas.info proxy each costs 1.5-7 s (measured).
class Eng implements EngineLike {
  anchors: string[] = [];
  constructor(public cursor: number) {}
  low() { return `b${this.cursor}`; }
  scanned() { return BigInt(this.cursor); }
  ingest_segment(): string { throw new Error("no segments expected"); }
  ingest_page() { return JSON.stringify({ ingested: 1, at_margin: true }); }
  tip_frontier() { return JSON.stringify({ block: this.low(), size: this.cursor, leaf: "l", ommers: [] }); }
  checkpoint() { return new Uint8Array([this.cursor % 256]); }
  status() { return JSON.stringify({ balance_sompi: "7", notes: 1 }); }
  set_anchor(j: string) { this.anchors.push(j); }
}

function deps(opts: { treeMs?: number; badTree?: boolean; anchorAgeMs?: number } = {}) {
  const eng = new Eng(1_000_000);
  const log: string[] = [];
  let synced = 0;
  const d: SyncDeps = {
    fetch: (async (u: string) => {
      const path = u.replace("https://gw", "").replace("https://m", "");
      log.push(`ask ${path.split("?")[0]}`);
      if (u.endsWith("/tip")) {
        await new Promise((r) => setTimeout(r, 30));
        log.push("tip-done");
        return new Response(JSON.stringify({ virtual_daa_score: 1_000_500 }));
      }
      if (u.includes("/tree?block=")) {
        await new Promise((r) => setTimeout(r, opts.treeMs ?? 0));
        log.push("tree-done");
        return new Response(JSON.stringify({ block: eng.low(), size: opts.badTree ? 1 : eng.cursor, leaf: "l", ommers: [] }));
      }
      if (u.includes("/tree?below=")) return new Response(JSON.stringify({ block: "a1", daa: 999_000, size: 1, leaf: "l", ommers: [] }));
      if (u.includes("/blocks?after=")) return new Response(new Uint8Array([1]));
      if (u.endsWith("/mempool")) return new Response("[]");
      return new Response("{}");
    }) as typeof fetch,
    verifyManifest: (j) => j,
    segmentMatches: () => true,
    create: () => eng,
    restore: () => eng,
    load: async () => new Uint8Array([1]),
    save: async () => true,
    files: ["https://m"],
    gateway: "https://gw",
    birthday: 0,
    onStatus: (s) => {
      log.push(`status ${s.phase}`);
      if (s.phase === "synced") synced++;
    },
    shouldStop: () => synced >= 2,
    sleep: async () => {},
    loadAnchor: async () => (opts.anchorAgeMs === undefined ? null : JSON.stringify({ anchor: { block: "cached" }, at: Date.now() - opts.anchorAgeMs })),
    saveAnchor: async () => true,
  };
  return { d, eng, log };
}

describe("resuming a wallet a short way behind", () => {
  it("asks for the next page and the tip at once, and never for the manifest", async () => {
    const t = deps();
    await runSync(t.d);
    expect(t.log.indexOf("ask /blocks")).toBeLessThan(t.log.indexOf("tip-done"));
    expect(t.log.some((x) => x.includes("manifest"))).toBe(false);
  });

  it("is shown synced while its tree check runs", async () => {
    const t = deps({ treeMs: 50 });
    await runSync(t.d);
    expect(t.log.indexOf("status synced")).toBeLessThan(t.log.indexOf("tree-done"));
  });

  it("a tree that differs still stops it", async () => {
    const t = deps({ treeMs: 20, badTree: true });
    await expect(runSync(t.d)).rejects.toThrow(/tree differs/);
    expect(t.log).toContain("status error");
  });

  it("uses a recent cached anchor at once, and not a stale one", async () => {
    const fresh = deps({ anchorAgeMs: 60_000 });
    await runSync(fresh.d);
    expect(fresh.eng.anchors[0]).toBe(JSON.stringify({ block: "cached" }));
    const stale = deps({ anchorAgeMs: ANCHOR_CACHE_MS + 1 });
    await runSync(stale.d);
    expect(stale.eng.anchors[0]).not.toBe(JSON.stringify({ block: "cached" }));
  });
});
