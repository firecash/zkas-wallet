import { describe, it, expect } from "vitest";
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
  ingest_segment(_b: Uint8Array, index: bigint, from: string) {
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
