import { describe, it, expect, vi } from "vitest";
import { runSync, type EngineLike, type SyncDeps, type Segment } from "../src/webengine/sync";

// The browser sync loop's decisions, with a fake engine and fake network: mirror failover (R2
// refusing a browser origin until its CORS rule exists), a corrupted segment, a reorg near the
// tip, and the node check. The real engine and services are exercised by the CDN smoke test.

const seg = (index: number, from: number, to: number): Segment => ({
  index,
  file: `seg-${index}.zks`,
  sha256: `sha${index}`,
  bytes: 3,
  blocks: 1,
  from: { block: `b${from}`, daa: from, size: from, leaf: "l", ommers: [] },
  to: { block: `b${to}`, daa: to, size: to, leaf: "l", ommers: [] },
});
const MANIFEST = { segments: [seg(1, 0, 100), seg(2, 100, 200)] };

class FakeEngine implements EngineLike {
  constructor(public cursor: number, public pagesLeft = 2, public reorgOnce = false) {}
  low() { return `b${this.cursor}`; }
  scanned() { return BigInt(this.cursor); }
  ingest_segment(_b: Uint8Array, index: bigint, from: string, to: string) {
    if (JSON.parse(to).daa !== MANIFEST.segments.find((x) => BigInt(x.index) === index)!.to.daa) throw new Error("wrong segment end");
    const s = MANIFEST.segments.find((x) => BigInt(x.index) === index)!;
    if (from !== this.low() && this.cursor !== s.from.daa) throw new Error("this segment does not continue the wallet's cursor");
    this.cursor = s.to.daa;
    return JSON.stringify({ ingested: 1 });
  }
  ingest_page() {
    if (this.reorgOnce) { this.reorgOnce = false; throw new Error("reorged: the cursor is no longer on the selected chain"); }
    if (this.pagesLeft > 0) { this.pagesLeft--; this.cursor += 10; }
    return JSON.stringify({ ingested: 1, at_margin: this.pagesLeft === 0 });
  }
  tip_frontier() { return JSON.stringify({ block: this.low(), size: this.cursor, leaf: "l", ommers: [] }); }
  checkpoint() { return new Uint8Array([this.cursor]); }
  status() { return JSON.stringify({ balance_sompi: "5", notes: 1 }); }
}

function deps(over: Partial<SyncDeps> & { treeSize?: (cursor: number) => number; failR2?: boolean; badSegment?: boolean } = {}) {
  const calls: string[] = [];
  let store: Uint8Array | null = null;
  let eng: FakeEngine | null = null;
  const statuses: string[] = [];
  let synced = 0;
  const d: SyncDeps = {
    fetch: (async (u: string) => {
      calls.push(u);
      if (over.failR2 && u.startsWith("https://r2")) throw new TypeError("Failed to fetch (CORS)");
      if (u.endsWith("/manifest-v2.json")) return new Response(JSON.stringify(MANIFEST));
      if (u.endsWith("/tip")) return new Response(JSON.stringify({ virtual_daa_score: 999 }));
      if (u.includes("/tree?block=")) {
        const c = Number(u.split("block=b")[1]);
        return new Response(JSON.stringify({ block: `b${c}`, size: over.treeSize ? over.treeSize(c) : c, leaf: "l", ommers: [] }));
      }
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch,
    verifyManifest: (j) => j,
    segmentMatches: () => !over.badSegment,
    create: () => (eng = new FakeEngine(0)),
    restore: (b) => (eng = new FakeEngine(b[0], 1)),
    load: async () => store,
    save: async (b) => { store = b; return true; },
    files: ["https://r2", "https://zkas"],
    gateway: "https://gw",
    birthday: 5,
    onStatus: (s) => { statuses.push(s.phase); if (s.phase === "synced") synced++; },
    shouldStop: () => synced >= 1,
    sleep: async () => {},
    ...over,
  };
  return { d, calls, statuses, get eng() { return eng; }, get store() { return store; } };
}

describe("browser sync loop", () => {
  it("syncs files then the gateway, checks the tree, and saves", async () => {
    const t = deps();
    await runSync(t.d);
    expect(t.eng!.cursor).toBe(220);
    expect(t.statuses).toContain("files");
    expect(t.statuses.at(-1)).toBe("synced");
    expect(t.calls.some((u) => u.includes("/tree?block=b220"))).toBe(true);
    expect(t.store![0]).toBe(220);
  });

  it("following the tip once synced never reports not-synced for a page at the margin", async () => {
    // Each new block page reported "tip" (not synced, not spend-ready) before "synced": the
    // status flickered and Send greyed out every few seconds.
    let rounds = 0;
    const t = deps({ shouldStop: () => rounds >= 3, onStatus: (st) => { t.statuses.push(st.phase); if (st.phase === "synced") rounds++; } });
    await runSync(t.d);
    const first = t.statuses.indexOf("synced");
    expect(first).toBeGreaterThan(0);
    expect(t.statuses.slice(0, first)).toContain("tip");
    expect(t.statuses.slice(first)).not.toContain("tip");
    expect(t.statuses.filter((x) => x === "synced").length).toBe(3);
  });

  it("downloads the next gateway page while this one is ingested", async () => {
    // Pages used to be fetched and ingested in turn, the network idle during each ingest.
    const order: string[] = [];
    const t = deps({ create: () => new FakeEngine(0, 4) });
    const fetch0 = t.d.fetch;
    let lastAfter = "";
    t.d.fetch = (async (u: string) => {
      if (u.includes("/blocks?after=")) {
        lastAfter = u.split("after=")[1].split("&")[0];
        order.push(`fetch ${lastAfter}`);
      }
      return fetch0(u);
    }) as typeof fetch;
    // The fake page "ends" where the fake engine will stop after ingesting it (+10 blocks).
    t.d.pageCursor = () => JSON.stringify({ last: `b${Number(lastAfter.slice(1)) + 10}`, count: 1000, reorged: false });
    const eng = { ingest: FakeEngine.prototype.ingest_page };
    FakeEngine.prototype.ingest_page = function (this: FakeEngine) {
      order.push(`ingest ${this.low()}`);
      return eng.ingest.call(this);
    };
    try {
      await runSync(t.d);
    } finally {
      FakeEngine.prototype.ingest_page = eng.ingest;
    }
    // The page after b200 was asked for before b200's page was ingested, and so on.
    expect(order.indexOf("fetch b210")).toBeLessThan(order.indexOf("ingest b200"));
    expect(order.indexOf("fetch b220")).toBeLessThan(order.indexOf("ingest b210"));
    // Every cursor fetched once: the read-ahead page was used, not fetched again.
    const fetches = order.filter((x) => x.startsWith("fetch"));
    expect(new Set(fetches).size).toBe(fetches.length);
  });

  it("never uses a read-ahead page when the engine stopped short of its end", async () => {
    const t = deps({ create: () => new FakeEngine(0, 3) });
    const asked: string[] = [];
    const fetch0 = t.d.fetch;
    t.d.fetch = (async (u: string) => {
      if (u.includes("/blocks?after=")) asked.push(u.split("after=")[1].split("&")[0]);
      return fetch0(u);
    }) as typeof fetch;
    // Claims every page ends 500 blocks on: the engine (+10 per page) never stops there.
    t.d.pageCursor = () => JSON.stringify({ last: "b999999", count: 1000, reorged: false });
    await runSync(t.d);
    // Each ingest resumed from the engine's real cursor (b200, b210, b220), never from b999999.
    expect(asked.filter((a) => a !== "b999999")).toEqual(expect.arrayContaining(["b200", "b210", "b220"]));
    expect(t.statuses.at(-1)).toBe("synced");
  });

  it("says synced as soon as the tree is checked, not after the save, tip, anchor and mempool", async () => {
    // Every save takes a moment. Before, "synced" came only after the tip save had finished (one
    // step after another); now it goes out while that save is still running.
    const t = deps();
    const events: string[] = [];
    t.d.onStatus = (st) => {
      t.statuses.push(st.phase);
      events.push(st.phase);
    };
    t.d.save = async () => {
      events.push("save-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("save-done");
      return true;
    };
    let synced = 0;
    const orig = t.d.onStatus;
    t.d.onStatus = (st) => {
      orig(st);
      if (st.phase === "synced") synced++;
    };
    t.d.shouldStop = () => synced >= 2;
    await runSync(t.d);
    const first = events.indexOf("synced");
    // This fixture saves twice while catching up (two segments, then the files' end). The tip
    // save used to finish before "synced" too (three); now it starts right after it.
    expect(events.slice(0, first).filter((e) => e === "save-done").length).toBe(2);
    expect(events[first + 1]).toBe("save-start");
  });

  it("reports a chain file's download progress while nothing can be ingested yet", async () => {
    const t = deps();
    const seen: (number | undefined)[] = [];
    const fetch0 = t.d.fetch;
    t.d.fetch = (async (u: string) => {
      if (u.includes("seg-1.zks")) {
        // Arrives in three parts over ~2 s.
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            for (const part of [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]) {
              await new Promise((r) => setTimeout(r, 700));
              c.enqueue(part);
            }
            c.close();
          },
        });
        return new Response(body);
      }
      return fetch0(u);
    }) as typeof fetch;
    const on = t.d.onStatus;
    t.d.onStatus = (st) => {
      on(st);
      if (st.downloadTotal) seen.push(st.downloadDone);
    };
    await runSync(t.d);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.some((x) => (x ?? 0) > 0)).toBe(true);
    expect(t.eng!.cursor).toBe(220);
  });

  it("asks for the anchor and the mempool at the same time", async () => {
    // Through a proxy each request is a round trip; one after the other cost ~1 s a round.
    const t = deps();
    const fetch0 = t.d.fetch;
    let inFlight = 0;
    let overlap = 0;
    t.d.fetch = (async (u: string) => {
      if (u.endsWith("/tip")) return new Response(JSON.stringify({ virtual_daa_score: 50_000 }));
      if (u.includes("/tree?below=") || u.endsWith("/mempool")) {
        inFlight++;
        overlap = Math.max(overlap, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return new Response(u.endsWith("/mempool") ? "[]" : JSON.stringify({ block: "b1", size: 1, leaf: "l", ommers: [] }));
      }
      return fetch0(u);
    }) as typeof fetch;
    await runSync(t.d);
    expect(overlap).toBe(2);
  });

  it("saves during a long gateway catch-up, not only at the tip", async () => {
    // 5 gateway pages at 20 s each: a reload part-way must resume near there, not at the files' end.
    const t = deps({ create: () => new FakeEngine(0, 5) });
    const saved: number[] = [];
    const save0 = t.d.save;
    t.d.save = async (b) => { saved.push(b[0]); return save0(b); };
    let now = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (now += 20_000));
    try {
      await runSync(t.d);
    } finally {
      spy.mockRestore();
    }
    const mid = saved.filter((c) => c > 200 && c < 250);
    expect(mid.length).toBeGreaterThanOrEqual(3);
    expect(saved.at(-1)).toBe(250);
  });

  it("falls back from a mirror the browser cannot read, and asks it only once", async () => {
    const t = deps({ failR2: true });
    await runSync(t.d);
    expect(t.eng!.cursor).toBe(220);
    expect(t.calls.filter((u) => u.startsWith("https://r2")).length).toBe(1);
    expect(t.calls.filter((u) => u.startsWith("https://zkas/seg-")).length).toBe(2);
  });

  it("refuses a segment that does not match the manifest", async () => {
    const t = deps({ badSegment: true });
    await expect(runSync(t.d)).rejects.toThrow(/does not match the manifest|no chain-file mirror/);
  });

  it("refuses to keep a tree that differs from the node", async () => {
    const t = deps({ treeSize: (c) => c + 1 });
    await expect(runSync(t.d)).rejects.toThrow(/tree differs/);
    expect(t.statuses.at(-1)).toBe("error");
  });

  it("a reloaded page reports the saved position before any network request", async () => {
    const t = deps();
    const order: string[] = [];
    const fetch0 = t.d.fetch;
    t.d.fetch = (async (u: string) => {
      order.push("fetch");
      return fetch0(u as never);
    }) as typeof fetch;
    t.d.load = async () => new Uint8Array([150]);
    const onStatus0 = t.d.onStatus;
    t.d.onStatus = (st) => {
      order.push(`status:${st.scanned}`);
      onStatus0(st);
    };
    await runSync(t.d);
    expect(order[0]).toBe("status:150");
  });

  it("goes back to the last checkpoint on a reorg and carries on", async () => {
    const t = deps();
    t.d.create = () => {
      const e = new FakeEngine(0, 2, true);
      // reachable from the outer helper for the assertions below
      (t as unknown as { _e: FakeEngine })._e = e;
      return e;
    };
    await runSync(t.d);
    expect(t.statuses.at(-1)).toBe("synced");
  });
});
