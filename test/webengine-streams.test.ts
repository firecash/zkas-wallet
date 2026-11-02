import { describe, it, expect } from "vitest";
import { runSync, type EngineLike, type SyncDeps, STREAM_MIN_DAA } from "../src/webengine/sync";

// A long gateway stretch is fetched as parallel page streams and ingested strictly in order.
// Fakes: block n has DAA n and hash `h<n>`; a page after h<x> holds blocks x+1 .. x+K (K=100).
const K = 100;
const TIP = 50_000;
const enc = (from: number, n: number) => new Uint8Array(new Uint32Array([from, n]).buffer);
const dec = (p: Uint8Array) => {
  const v = new Uint32Array(p.slice().buffer);
  return { from: v[0], n: v[1] };
};

class Eng implements EngineLike {
  cursor = 0;
  ingested: number[] = [];
  low() { return `h${this.cursor}`; }
  scanned() { return BigInt(this.cursor); }
  ingest_segment(): string { throw new Error("this segment does not continue"); }
  ingest_page(b: Uint8Array) { return this.take(b, Infinity); }
  ingest_page_until(b: Uint8Array, stop: string) { return this.take(b, Number(stop.slice(1))); }
  take(b: Uint8Array, stop: number) {
    const { from, n } = dec(b);
    if (from !== this.cursor + 1) throw new Error(`page does not continue the cursor (${from} after ${this.cursor})`);
    const margin = TIP - 200;
    let last = this.cursor;
    for (let x = from; x < from + n && x <= stop; x++) {
      if (x > margin) return JSON.stringify({ ingested: 0, at_margin: true });
      last = x;
      this.ingested.push(x);
    }
    this.cursor = last;
    return JSON.stringify({ ingested: 1, at_margin: last >= margin });
  }
  tip_frontier() { return JSON.stringify({ block: this.low(), size: this.cursor, leaf: "l", ommers: [] }); }
  checkpoint() { return new Uint8Array([1]); }
  status() { return JSON.stringify({ balance_sompi: "0", notes: 0 }); }
}

function deps(eng: Eng, opts: { wrongBoundary?: boolean } = {}) {
  const asked: string[] = [];
  let inFlight = 0;
  let peak = 0;
  let synced = 0;
  const d: SyncDeps = {
    fetch: (async (u: string) => {
      if (u.endsWith("/tip")) return new Response(JSON.stringify({ virtual_daa_score: TIP }));
      if (u.endsWith("/manifest-v2.json")) return new Response(JSON.stringify({ segments: [] }));
      if (u.includes("/tree?below=")) {
        const x = Number(u.split("below=")[1]) - (opts.wrongBoundary ? 0.5 : 0);
        return new Response(JSON.stringify({ block: opts.wrongBoundary ? `hX${x}` : `h${x}`, daa: x, size: x, leaf: "l", ommers: [] }));
      }
      if (u.includes("/tree?block=")) {
        const c = Number(u.split("block=h")[1]);
        return new Response(JSON.stringify({ block: `h${c}`, size: c, leaf: "l", ommers: [] }));
      }
      if (u.includes("/blocks?after=")) {
        const after = Number(u.split("after=h")[1].split("&")[0]);
        asked.push(String(after));
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return new Response(enc(after + 1, Math.max(0, Math.min(K, TIP - after))));
      }
      if (u.endsWith("/mempool")) return new Response("[]");
      return new Response("{}");
    }) as typeof fetch,
    verifyManifest: (j) => j,
    segmentMatches: () => true,
    create: () => eng,
    restore: () => eng,
    load: async () => new Uint8Array([1]), // resume (the fakes publish no segments)
    save: async () => true,
    files: ["https://m"],
    gateway: "https://gw",
    birthday: 0,
    onStatus: (s) => {
      if (s.phase === "synced") synced++;
    },
    shouldStop: () => synced >= 2,
    sleep: async () => {},
    pageCursor: (p) => {
      const { from, n } = dec(p);
      return JSON.stringify({ last: n ? `h${from + n - 1}` : null, count: n * 10, reorged: false });
    },
    pageIndexOf: (p, h) => {
      const { from, n } = dec(p);
      const x = Number(h.slice(1));
      return Number.isInteger(x) && x >= from && x < from + n ? x - from : -1;
    },
  };
  return { d, asked, peak: () => peak };
}

describe("parallel page streams", () => {
  it("fetch in parallel, ingest every block exactly once, in order", async () => {
    const eng = new Eng();
    const t = deps(eng);
    await runSync(t.d);
    expect(eng.cursor).toBeGreaterThanOrEqual(TIP - 200 - K);
    expect(eng.ingested.length).toBe(eng.cursor);
    expect(eng.ingested.every((x, i) => x === i + 1)).toBe(true);
    expect(t.peak()).toBeGreaterThanOrEqual(3);
  });

  it("a boundary the pages never contain: no runaway streams, and the plain loop finishes the job", async () => {
    const eng = new Eng();
    const t = deps(eng, { wrongBoundary: true });
    await runSync(t.d);
    expect(eng.ingested.every((x, i) => x === i + 1)).toBe(true);
    expect(eng.cursor).toBeGreaterThanOrEqual(TIP - 200 - K);
    // Each stream stops after its page budget; nothing near 4x the range was fetched.
    expect(t.asked.length).toBeLessThan(2 * (TIP / K));
  });

  it("a short stretch is fetched the plain way", async () => {
    expect(STREAM_MIN_DAA).toBeGreaterThan(K);
  });
});
