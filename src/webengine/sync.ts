// The browser wallet's sync loop: published chain files first, then the chain gateway to the
// tip margin, then the wallet's tree checked against the node's — the same sequence and the same
// checks as the phone engine (walletd), driven from a web worker.
//
// Everything it touches is passed in (`SyncDeps`), so the identical code runs in the worker and
// in a Node test against the real CDN and gateway.

/** The subset of the wasm `Engine` this loop drives. */
export interface EngineLike {
  low(): string;
  scanned(): bigint;
  ingest_segment(bytes: Uint8Array, index: bigint, fromBlock: string): string;
  ingest_page(bytes: Uint8Array): string;
  tip_frontier(): string | undefined;
  checkpoint(): Uint8Array;
  status(): string;
  history?(limit: number, offset: number): string;
  free?(): void;
}

export interface Boundary {
  block: string;
  daa: number;
  size: number;
  leaf: string;
  ommers: string[];
}
export interface Segment {
  index: number;
  file: string;
  sha256: string;
  bytes: number;
  blocks: number;
  from: Boundary;
  to: Boundary;
}
export interface Manifest {
  segments: Segment[];
}

export interface BrowserSyncStatus {
  phase: "starting" | "files" | "tip" | "synced" | "error";
  scanned: number;
  tip: number;
  birthday: number;
  balanceSompi: string;
  notes: number;
  /** The wallet tree equalled the node's at the cursor (null: not checked yet this session). */
  verified: boolean | null;
  error?: string;
}

export interface SyncDeps {
  fetch: typeof fetch;
  verifyManifest(json: string): string;
  segmentMatches(bytes: Uint8Array, sha256: string, size: bigint): boolean;
  create(boundaryJson: string, birthday: bigint): EngineLike;
  restore(bytes: Uint8Array): EngineLike;
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<boolean>;
  /** Chain-file mirrors, tried in turn; one that fails is skipped for the rest of the session. */
  files: string[];
  gateway: string;
  birthday: number;
  onStatus(s: BrowserSyncStatus): void;
  /** Called with the live engine whenever it is created or replaced (history reads use it). */
  onEngine?(e: EngineLike): void;
  shouldStop(): boolean;
  /** Seconds between tip polls once synced (default 10). */
  pollSecs?: number;
  sleep?(ms: number): Promise<void>;
}

/** Checkpoint every this many segments while catching up. */
const SAVE_EVERY_SEGMENTS = 2;

export async function runSync(d: SyncDeps): Promise<void> {
  const bad = new Set<string>();
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let eng: EngineLike | null = null;
  let tip = 0;
  let verified: boolean | null = null;

  const report = (phase: BrowserSyncStatus["phase"], error?: string) => {
    let st = { balance_sompi: "0", notes: 0 };
    try {
      if (eng) st = JSON.parse(eng.status());
    } catch {
      /* keep the defaults */
    }
    d.onStatus({
      phase,
      scanned: eng ? Number(eng.scanned()) : 0,
      tip,
      birthday: d.birthday,
      balanceSompi: st.balance_sompi,
      notes: st.notes,
      verified,
      ...(error ? { error } : {}),
    });
  };

  const get = async (url: string): Promise<Response> => {
    const r = await d.fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r;
  };

  // A mirror that fails once (unreachable, no CORS for this origin, wrong bytes) is not asked
  // again this session: a missing CORS rule must cost one request, not one per file.
  const fromMirrors = async <T,>(path: (base: string) => string, start: number, consume: (r: Response, base: string) => Promise<T>): Promise<T> => {
    const live = d.files.filter((b) => !bad.has(b));
    if (!live.length) throw new Error("no chain-file mirror is reachable");
    let last: unknown = null;
    for (let i = 0; i < live.length; i++) {
      const base = live[(start + i) % live.length];
      try {
        return await consume(await get(path(base)), base);
      } catch (e) {
        last = e;
        bad.add(base);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };

  const refreshTip = async () => {
    try {
      tip = (await (await get(`${d.gateway}/tip`)).json()).virtual_daa_score ?? tip;
    } catch {
      /* keep the last known tip */
    }
  };

  report("starting");
  await refreshTip();
  const manifest: Manifest = await fromMirrors(
    (b) => `${b}/manifest-v2.json`,
    0,
    async (r) => JSON.parse(d.verifyManifest(await r.text())),
  );
  const segs = manifest.segments;

  // Resume, or start at the signed boundary of the segment the birthday falls in.
  const saved = await d.load();
  if (saved) {
    try {
      eng = d.restore(saved);
    } catch {
      eng = null;
    }
  }
  if (!eng) {
    const start = [...segs].reverse().find((s) => s.from.daa <= d.birthday) ?? segs[0];
    eng = d.create(JSON.stringify(start.from), BigInt(d.birthday));
  }
  d.onEngine?.(eng);

  // 1. Published segments.
  let sinceSave = 0;
  for (const s of segs) {
    if (d.shouldStop()) return;
    if (s.to.daa <= Number(eng.scanned())) continue;
    const bytes = await fromMirrors(
      (b) => `${b}/${s.file}`,
      s.index,
      async (r) => {
        const b = new Uint8Array(await r.arrayBuffer());
        if (!d.segmentMatches(b, s.sha256, BigInt(s.bytes))) throw new Error(`segment ${s.index} does not match the manifest`);
        return b;
      },
    );
    try {
      eng.ingest_segment(bytes, BigInt(s.index), s.from.block);
    } catch (e) {
      // The cursor is not in this segment (a gap, or the wallet already past it): the gateway
      // serves from the cursor whatever the files hold.
      if (String(e).includes("does not continue")) break;
      throw e;
    }
    if (++sinceSave >= SAVE_EVERY_SEGMENTS) {
      sinceSave = 0;
      await d.save(eng.checkpoint());
    }
    report("files");
  }
  await d.save(eng.checkpoint());

  // 2. The gateway to the tip margin; then the node check; then keep following the tip.
  for (;;) {
    if (d.shouldStop()) return;
    for (;;) {
      if (d.shouldStop()) return;
      const page = new Uint8Array(await (await get(`${d.gateway}/blocks?after=${eng.low()}&limit=1000`)).arrayBuffer());
      let res: { ingested: number; at_margin: boolean };
      try {
        res = JSON.parse(eng.ingest_page(page));
      } catch (e) {
        if (String(e).includes("reorged")) {
          // The cursor left the selected chain: go back to the last saved checkpoint.
          const ck = await d.load();
          if (!ck) throw e;
          eng.free?.();
          eng = d.restore(ck);
          d.onEngine?.(eng);
          continue;
        }
        throw e;
      }
      report("tip");
      if (res.at_margin) break;
    }
    if (verified === null) {
      const mine = eng.tip_frontier();
      if (mine) {
        const m = JSON.parse(mine);
        const node = await (await get(`${d.gateway}/tree?block=${eng.low()}`)).json();
        verified = node.block === m.block && node.size === m.size && node.leaf === m.leaf && JSON.stringify(node.ommers) === JSON.stringify(m.ommers);
        if (!verified) {
          report("error", "this wallet's tree does not equal the node's: its data is discarded and rebuilt");
          throw new Error("tree differs from the node");
        }
      }
    }
    await d.save(eng.checkpoint());
    await refreshTip();
    report("synced");
    await sleep((d.pollSecs ?? 10) * 1000);
    await refreshTip();
  }
}
