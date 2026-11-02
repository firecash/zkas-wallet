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
  ingest_segment(bytes: Uint8Array, index: bigint, fromBlock: string, toBoundaryJson: string): string;
  ingest_page(bytes: Uint8Array): string;
  /** `ingest_page` up to and including block `stop` (parallel page streams). */
  ingest_page_until?(bytes: Uint8Array, stop: string): string;
  tip_frontier(): string | undefined;
  checkpoint(): Uint8Array;
  status(): string;
  history?(limit: number, offset: number): string;
  /** Returns why the anchor was not taken ("ahead" / "below_base"), or nothing when it was. */
  set_anchor?(boundaryJson: string): string | undefined | void;
  /** Counts only: tree, base, anchor, leaves the oldest unmatured coin still needs. */
  anchor_debug?(): string;
  set_mempool?(payloadsJson: string): void;
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
  /** walletd's money fields, from the engine (sompi, decimal strings). */
  spendableSompi?: string;
  maturingSompi?: string;
  pendingInSompi?: string;
  pendingOutSompi?: string;
  pendingChangeSompi?: string;
  spendReady?: boolean;
  /** The wallet tree equalled the node's at the cursor (null: not checked yet this session). */
  verified: boolean | null;
  /** An anchor has been evaluated (taken or not): matured vs maturing is known. */
  anchorKnown?: boolean;
  /** Seconds until the oldest maturing coin is spendable (anchor lag / observed leaf rate). */
  maturingEtaSecs?: number;
  /** While a chain file downloads (nothing can be ingested until it is whole): bytes so far / total. */
  downloadDone?: number;
  downloadTotal?: number;
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
  /** Where a gateway page ends (`page_cursor`): lets the next page download during this ingest. */
  pageCursor?(page: Uint8Array): string;
  /** Where block `hash` sits in a gateway page, or -1 (`page_index_of`): parallel page streams. */
  pageIndexOf?(page: Uint8Array, hash: string): number;
  /** The last matured anchor and when it was taken (JSON), kept across reloads: a reload is
   *  spend-ready at once instead of after a round trip. */
  loadAnchor?(): Promise<string | null>;
  saveAnchor?(json: string): Promise<unknown>;
  /** Timing of each sync phase, for the diagnostic log (what a slow catch-up spent its time on). */
  onPhase?(ev: string, fields: Record<string, number | string | boolean>): void;
  sleep?(ms: number): Promise<void>;
}

/** How far below the tip (DAA) the matured anchor is taken: consensus wants 600 blue score of
 *  depth when the spend is mined; walletd adds 30 of slack; DAA runs a little ahead of blue. */
export const ANCHOR_DEPTH_DAA = 1_000;

/** Segments downloaded ahead of the one being ingested (~10 MB each). */
export const SEGMENT_READ_AHEAD = 2;

/** Checkpoint every this many segments while catching up. */
const SAVE_EVERY_SEGMENTS = 2;
/** Below this gap (DAA) a resumed wallet skips the chain-file manifest: no segment is worth it. */
export const MANIFEST_MIN_GAP = 20_000;
/** A cached anchor younger than this is used on resume (it is still deep and final). */
export const ANCHOR_CACHE_MS = 10 * 60_000;

/** How often a segment download reports its progress. */
const DOWNLOAD_REPORT_MS = 700;

/** Blocks per gateway page (the gateway's maximum). */
const PAGE_LIMIT = 1000;

/** A gateway stretch at least this long (DAA) is fetched as parallel page streams. Pages one at a
 *  time pay a proxy round trip each (~1.3 s through wallet.zkas.info) before their transfer: a
 *  user log (2 Nov) moved ~23k DAA in 51 s on a link that carried the 7 MB segment at 2 Mbit/s. */
export const STREAM_MIN_DAA = 6_000;
/** Streams in flight at once. */
export const STREAMS = 4;
/** The streams end this far below the tip; the plain loop takes the rest (and the tip margin). */
export const STREAM_STOP_BEFORE_TIP = 3_000;
/** At most this much (DAA) per stream at once: bounds the pages held while earlier ones ingest. */
export const STREAM_MAX_DAA = 25_000;
/** During a gateway catch-up, save at most this often (a reload resumes from here). */
const GATEWAY_SAVE_MS = 15_000;

export async function runSync(d: SyncDeps): Promise<void> {
  const bad = new Set<string>();
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let eng: EngineLike | null = null;
  let tip = 0;
  let verified: boolean | null = null;
  let everSynced = false;
  let verifyJob: Promise<boolean> | null = null;
  let lastAnchorWhy = "";
  let lastAnchorLog = 0;
  let anchorKnown = false;
  let maturingEtaSecs: number | null = null;
  // Leaves added per second, from the tree's growth between rounds (default: measured ~1.5/s).
  let leafRate = 1.5;
  let lastTree: { leaves: number; at: number } | null = null;
  // Waits for the tree check if one is running; a mismatch reports and stops (the caller rebuilds).
  const settleVerify = async () => {
    if (!verifyJob) return;
    const job = verifyJob;
    verifyJob = null;
    try {
      verified = await job;
    } catch {
      verified = null; // could not ask: asked again at the next tip
      return;
    }
    if (!verified) {
      report("error", "this wallet's tree does not equal the node's: its data is discarded and rebuilt");
      throw new Error("tree differs from the node");
    }
  };
  let downloading: { done: number; total: number } | null = null;

  const report = (phase: BrowserSyncStatus["phase"], error?: string) => {
    let st: Record<string, string | number | boolean> = { balance_sompi: "0", notes: 0 };
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
      balanceSompi: String(st.balance_sompi ?? "0"),
      notes: Number(st.notes ?? 0),
      spendableSompi: st.spendable_sompi as string | undefined,
      maturingSompi: st.maturing_sompi as string | undefined,
      pendingInSompi: st.pending_in_sompi as string | undefined,
      pendingOutSompi: st.pending_out_sompi as string | undefined,
      pendingChangeSompi: st.pending_change_sompi as string | undefined,
      spendReady: st.spend_ready as boolean | undefined,
      verified,
      ...(downloading ? { downloadDone: downloading.done, downloadTotal: downloading.total } : {}),
      ...(anchorKnown ? { anchorKnown } : {}),
      ...(maturingEtaSecs !== null ? { maturingEtaSecs } : {}),
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

  // Resume FIRST, before any network: a reloaded page reports where the wallet really is (and its
  // balance) at once. It used to fetch the tip and the manifest first — seconds over the proxy —
  // reporting nothing meanwhile, so the page fell back to the birthday and showed 0% between the
  // cached 99% and the real 99%.
  const phase = (ev: string, fields: Record<string, number | string | boolean>) => {
    try {
      d.onPhase?.(ev, fields);
    } catch {
      /* diagnostics never break a sync */
    }
  };
  const ms = (t0: number) => Math.round(performance.now() - t0);
  let t = performance.now();
  const saved = await d.load();
  if (saved) {
    try {
      eng = d.restore(saved);
      d.onEngine?.(eng);
    } catch {
      eng = null;
    }
  }
  report("starting");
  phase("resume", { ms: ms(t), checkpoint_kb: saved ? Math.round(saved.length / 1024) : 0, scanned: eng ? Number(eng.scanned()) : 0 });
  const resumed = !!eng;
  // A reload costs round trips, each 1.5-7 s through the wallet.zkas.info proxy (measured): it
  // used to make five in a row (tip, manifest, page, tree check, anchor) before "synced". A
  // resumed wallet now asks for its next page and the tip at once, uses its cached anchor, skips
  // the manifest when the gap is short, and checks its tree in the background.
  const fetchPage = async (after: string) => new Uint8Array(await (await get(`${d.gateway}/blocks?after=${after}&limit=${PAGE_LIMIT}`)).arrayBuffer());
  let firstPage: { after: string; page: Promise<Uint8Array> } | null = null;
  if (eng) {
    const low = eng.low();
    const page = fetchPage(low);
    page.catch(() => undefined); // awaited (and rethrown) in the gateway loop
    firstPage = { after: low, page };
    try {
      const cached = JSON.parse((await d.loadAnchor?.()) ?? "null");
      if (cached && typeof cached.at === "number" && Date.now() - cached.at < ANCHOR_CACHE_MS && cached.anchor) {
        const why = eng.set_anchor?.(JSON.stringify(cached.anchor));
        anchorKnown = true;
        phase("anchor_cached", { outcome: why || "taken", age_s: Math.round((Date.now() - cached.at) / 1000) });
      }
    } catch {
      /* fetched at the tip as before */
    }
  }
  t = performance.now();
  await refreshTip();
  phase("tip_fetch", { ms: ms(t), tip });
  const shortGap = !!eng && tip > 0 && tip - Number(eng.scanned()) < MANIFEST_MIN_GAP;
  let segs: Segment[] = [];
  if (!shortGap) {
    t = performance.now();
    let manifestBytes = 0;
    const manifest: Manifest = await fromMirrors(
      (b) => `${b}/manifest-v2.json`,
      0,
      async (r) => {
        const text = await r.text();
        manifestBytes = text.length;
        return JSON.parse(d.verifyManifest(text));
      },
    );
    phase("manifest", { ms: ms(t), kb: Math.round(manifestBytes / 1024), segments: manifest.segments.length });
    segs = manifest.segments;
  }

  // Or start at the signed boundary of the segment the birthday falls in.
  // A wallet born after the last published segment (every new wallet) starts at the node's own
  // frontier at its birthday, as the phone engine's fast sync does, instead of replaying up to a
  // whole 12-hour segment it cannot hold notes in. The frontier is checked against the node again
  // once the wallet reaches the tip (step 2), and a gateway that cannot place one falls back to
  // the segment start below.
  const lastSeg = segs[segs.length - 1];
  if (!eng && lastSeg && d.birthday > lastSeg.to.daa) {
    try {
      const fr = await (await get(`${d.gateway}/tree?below=${d.birthday}`)).json();
      if (typeof fr?.block === "string" && typeof fr?.size === "number" && fr.daa >= lastSeg.to.daa && fr.daa <= d.birthday) {
        eng = d.create(JSON.stringify(fr), BigInt(d.birthday));
      }
    } catch {
      /* start from the segment instead */
    }
  }
  if (!eng) {
    const start = [...segs].reverse().find((s) => s.from.daa <= d.birthday) ?? segs[0];
    eng = d.create(JSON.stringify(start.from), BigInt(d.birthday));
  }
  d.onEngine?.(eng);

  // 1. Published segments. Downloads run AHEAD of ingest (up to SEGMENT_READ_AHEAD at once), so
  // the network and the decryption overlap instead of taking turns: each segment used to sit
  // idle on the CPU while the next one downloaded, and the reverse.
  // Bytes received per segment index, while it downloads (read as a stream, so a 7 MB file on a
  // slow link shows progress instead of a percentage frozen for half a minute).
  const received = new Map<number, number>();
  const readAll = async (r: Response, index: number): Promise<Uint8Array> => {
    const reader = r.body?.getReader?.();
    if (!reader) return new Uint8Array(await r.arrayBuffer());
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
      received.set(index, n);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const fetchSegment = (s: Segment) =>
    fromMirrors(
      (b) => `${b}/${s.file}`,
      s.index,
      async (r) => {
        const b = await readAll(r, s.index);
        if (!d.segmentMatches(b, s.sha256, BigInt(s.bytes))) throw new Error(`segment ${s.index} does not match the manifest`);
        return b;
      },
    );
  const pending = segs.filter((s) => s.to.daa > Number(eng!.scanned()));
  const inflight = new Map<number, Promise<Uint8Array>>();
  const started = new Map<number, number>();
  const ensure = (i: number) => {
    const s = pending[i];
    if (s && !inflight.has(i)) {
      started.set(i, performance.now());
      const p = fetchSegment(s);
      p.catch(() => undefined); // awaited (and rethrown) when its turn comes
      inflight.set(i, p);
    }
  };
  let sinceSave = 0;
  for (let i = 0; i < pending.length; i++) {
    const s = pending[i];
    if (d.shouldStop()) return;
    for (let k = 0; k <= SEGMENT_READ_AHEAD; k++) ensure(i + k);
    const tWait = performance.now();
    const tick = setInterval(() => {
      downloading = { done: received.get(s.index) ?? 0, total: Number(s.bytes) };
      report("files");
    }, DOWNLOAD_REPORT_MS);
    let bytes: Uint8Array;
    try {
      bytes = await inflight.get(i)!;
    } finally {
      clearInterval(tick);
      downloading = null;
    }
    inflight.delete(i);
    const waited = ms(tWait);
    const tIngest = performance.now();
    try {
      // The segment's signed end frontier: an engine holding no note adopts it instead of
      // hashing the segment's leaves.
      eng.ingest_segment(bytes, BigInt(s.index), s.from.block, JSON.stringify(s.to));
    } catch (e) {
      // The cursor is not in this segment (a gap, or the wallet already past it): the gateway
      // serves from the cursor whatever the files hold.
      if (String(e).includes("does not continue")) break;
      throw e;
    }
    phase("segment", { index: s.index, kb: Math.round(bytes.length / 1024), download_ms: Math.round(performance.now() - (started.get(i) ?? tWait)) - ms(tIngest), waited_ms: waited, ingest_ms: ms(tIngest) });
    if (++sinceSave >= SAVE_EVERY_SEGMENTS) {
      sinceSave = 0;
      await d.save(eng.checkpoint());
    }
    report("files");
  }
  if (pending.length) await d.save(eng.checkpoint());

  // 2. The gateway to the tip margin; then the node check; then keep following the tip.
  let lastGatewaySave = Date.now();
  // The page after the one being ingested, already downloading (catch-up only), and the cursor it
  // was asked from: used only if ingest stops exactly there (at the margin it stops earlier, and
  // that page would skip the blocks in between).
  let ahead: { after: string; page: Promise<Uint8Array> } | null = firstPage;
  let catchup = { pages: 0, kb: 0, waitMs: 0, ingestMs: 0, startedAt: performance.now(), from: Number(eng.scanned()) };

  // Parallel page streams for a long stretch: the range is split at chain blocks the gateway names
  // (public, cached; asking reveals nothing about the wallet), every stream downloads at once, and
  // the pages are ingested strictly in order, each stream ending exactly on the block the next one
  // starts after. Anything unexpected (a missing boundary, a reorg flag, a stream that does not
  // end where it must) stops the streams; the plain loop below then continues from wherever the
  // wallet really is, so a failure costs time, never correctness.
  const streamed = async (): Promise<void> => {
    const e = eng!;
    if (!d.pageIndexOf || !d.pageCursor || !e.ingest_page_until) return;
    const from = Number(e.scanned());
    const end = Math.min(tip - STREAM_STOP_BEFORE_TIP, from + STREAMS * STREAM_MAX_DAA);
    if (end - from < STREAM_MIN_DAA) return;
    const t0 = performance.now();
    const step = (end - from) / STREAMS;
    let bounds: { block: string; daa: number }[];
    try {
      bounds = await Promise.all(
        Array.from({ length: STREAMS }, (_, i) => Math.round(from + step * (i + 1))).map(async (x) => {
          const b = await (await get(`${d.gateway}/tree?below=${x}`)).json();
          if (typeof b?.block !== "string" || typeof b?.daa !== "number") throw new Error("no boundary");
          return { block: b.block as string, daa: b.daa as number };
        }),
      );
    } catch {
      return;
    }
    // Strictly ascending and past the wallet, or no streams.
    if (bounds.some((b, i) => b.daa <= (i ? bounds[i - 1].daa : from))) return;
    const starts = [e.low(), ...bounds.slice(0, -1).map((b) => b.block)];
    let failed = false;
    // Each stream: its pages, in order, as they arrive.
    const streams = starts.map((start, i) => {
      const stop = bounds[i].block;
      const pages: { page: Uint8Array; until: boolean }[] = [];
      const sig: { wake: (() => void) | null } = { wake: null };
      let done = false;
      // A 1000-block page spans at least 1000 DAA: a stream needs at most span/1000 + 1 pages. A
      // boundary that is somehow not where the stream expects it must not run on into its
      // neighbours' ranges.
      const span = bounds[i].daa - (i ? bounds[i - 1].daa : from);
      const maxPages = Math.ceil(span / PAGE_LIMIT) + 2;
      const run = (async () => {
        let after = start;
        for (let guard = 0; guard < maxPages && !failed; guard++) {
          const page = await fetchPage(after);
          const hit = d.pageIndexOf!(page, stop) >= 0;
          pages.push({ page, until: hit });
          sig.wake?.();
          if (hit) return;
          const c = JSON.parse(d.pageCursor!(page));
          if (typeof c.last !== "string" || c.reorged || !c.count) throw new Error("stream cannot continue");
          after = c.last;
        }
        throw new Error("stream did not reach its end");
      })()
        .catch(() => {
          failed = true;
        })
        .finally(() => {
          done = true;
          sig.wake?.();
        });
      const next = async (): Promise<{ page: Uint8Array; until: boolean } | null> => {
        for (;;) {
          if (pages.length) return pages.shift()!;
          if (done || failed) return null;
          await new Promise<void>((r) => (sig.wake = r));
          sig.wake = null;
        }
      };
      return { stop, next, run };
    });
    let pagesIn = 0;
    let kb = 0;
    let ingestMs = 0;
    try {
      for (const s of streams) {
        for (;;) {
          if (d.shouldStop()) {
            failed = true;
            return;
          }
          const item = await s.next();
          if (!item) break;
          const ti = performance.now();
          const res = JSON.parse(item.until ? e.ingest_page_until!(item.page, s.stop) : e.ingest_page(item.page));
          ingestMs += ms(ti);
          pagesIn++;
          kb += item.page.length / 1024;
          if (res.at_margin) failed = true;
          report("tip");
          if (item.until || failed) break;
        }
        if (failed || e.low() !== s.stop) {
          failed = true;
          break;
        }
      }
    } catch {
      failed = true; // a reorg or a bad page: the plain loop takes over from the wallet's cursor
    }
    failed = true; // stop any stream still running
    await Promise.all(streams.map((s) => s.run));
    phase("streamed_catchup", { streams: streams.length, pages: pagesIn, blocks: Number(e.scanned()) - from, kb: Math.round(kb), ms: ms(t0), ingest_ms: Math.round(ingestMs), complete: e.low() === bounds[bounds.length - 1].block });
  };
  if (!everSynced) await streamed();

  for (;;) {
    if (d.shouldStop()) return;
    for (;;) {
      if (d.shouldStop()) return;
      const low = eng.low();
      const tWait = performance.now();
      const page = ahead && ahead.after === low ? await ahead.page : await fetchPage(low);
      ahead = null;
      const waited = ms(tWait);
      if (d.pageCursor && !everSynced) {
        try {
          const c = JSON.parse(d.pageCursor(page));
          if (typeof c.last === "string" && c.count >= PAGE_LIMIT && !c.reorged) {
            const p = fetchPage(c.last);
            p.catch(() => undefined); // awaited (and rethrown) only if used
            ahead = { after: c.last, page: p };
          }
        } catch {
          /* no read-ahead for this page */
        }
      }
      const tIngest = performance.now();
      let res: { ingested: number; at_margin: boolean };
      try {
        res = JSON.parse(eng.ingest_page(page));
      } catch (e) {
        ahead = null;
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
      // Following the tip once synced, a page that lands at the margin is not "catching up":
      // reporting it as "tip" flipped the status to not-synced and NOT SPEND-READY for a moment
      // on every new block page (seen in a user log every few seconds, Send greyed out). The
      // "synced" report a moment later carries the new balance.
      if (!everSynced) {
        catchup.pages++;
        catchup.kb += page.length / 1024;
        catchup.waitMs += waited;
        catchup.ingestMs += ms(tIngest);
      }
      if (!(res.at_margin && everSynced)) report("tip");
      if (res.at_margin) {
        ahead = null;
        break;
      }
      // Long gateway catch-ups (a wallet back after days, or the stretch past the last chain
      // file) used to save only at the margin, so a reload mid-way restarted from the files'
      // end and the screen went back to an early percentage.
      if (Date.now() - lastGatewaySave > GATEWAY_SAVE_MS) {
        lastGatewaySave = Date.now();
        await d.save(eng.checkpoint());
      }
    }
    if (!everSynced && catchup.pages > 0) {
      phase("gateway_catchup", {
        pages: catchup.pages,
        blocks: Number(eng.scanned()) - catchup.from,
        kb: Math.round(catchup.kb),
        ms: ms(catchup.startedAt),
        network_wait_ms: Math.round(catchup.waitMs),
        ingest_ms: Math.round(catchup.ingestMs),
      });
      catchup = { pages: 0, kb: 0, waitMs: 0, ingestMs: 0, startedAt: performance.now(), from: Number(eng.scanned()) };
    }
    t = performance.now();
    let verifyMs = 0;
    if (verified === null && !verifyJob) {
      const mine = eng.tip_frontier();
      if (mine) {
        const m = JSON.parse(mine);
        verifyJob = get(`${d.gateway}/tree?block=${eng.low()}`)
          .then((r) => r.json())
          .then((node) => node.block === m.block && node.size === m.size && node.leaf === m.leaf && JSON.stringify(node.ommers) === JSON.stringify(m.ommers));
        verifyJob.catch(() => undefined);
        // A wallet resumed from its own checkpoint was checked when it last reached the tip:
        // its check runs while it is shown up to date, and a mismatch still stops it a moment
        // later (below), discards its data and rebuilds. A new wallet waits for its check.
        if (!(resumed && !everSynced)) await settleVerify();
      }
      verifyMs = ms(t);
    }
    // The balance is current now: say so at once. A user log (2 Nov) showed ~25 s between
    // reaching the tip and "synced" while the save, the tip, the anchor and the mempool went
    // one after another through the proxy. Spend-ready follows with the anchor (the engine's
    // own status says so), reported again below.
    if (!everSynced) report("synced");
    // The rest in parallel: the checkpoint write, the tip, then the matured anchor (the node's
    // frontier well below the tip, so a spend rooted there is final when mined: the consensus
    // depth is 600 blue, ~1000 DAA leaves room) and the mempool (an incoming payment shows a
    // second after it is sent). All best-effort but the save.
    const live = eng;
    const tSave = performance.now();
    const saving = d.save(live.checkpoint()).then((ok) => ({ ok, ms: ms(tSave) }));
    const tTip = performance.now();
    await refreshTip();
    const tipMs = ms(tTip);
    const tAnchor = performance.now();
    let anchorSetMs = 0;
    await Promise.all([
      tip > ANCHOR_DEPTH_DAA
        ? get(`${d.gateway}/tree?below=${tip - ANCHOR_DEPTH_DAA}`)
            .then((r) => r.json())
            .then((a) => {
              const ts = performance.now();
              if (typeof a?.block === "string") {
                const why = live.set_anchor?.(JSON.stringify(a)) || "taken";
                anchorKnown = true;
                // Why a coin is not spendable yet, when it should be: each change of outcome, and
                // once a minute while a coin is still maturing (counts only, no positions).
                let dbg: Record<string, number> = {};
                try {
                  dbg = JSON.parse(live.anchor_debug?.() ?? "{}");
                } catch {
                  /* older engine */
                }
                // When the oldest maturing coin becomes spendable: the leaves between it and this
                // candidate anchor (whether or not it was taken), at the rate the tree grows.
                const now = Date.now();
                if (typeof dbg.tree === "number") {
                  if (lastTree && now - lastTree.at > 5_000 && dbg.tree > lastTree.leaves) {
                    const r = (dbg.tree - lastTree.leaves) / ((now - lastTree.at) / 1000);
                    leafRate = leafRate * 0.7 + r * 0.3;
                  }
                  lastTree = { leaves: dbg.tree, at: now };
                }
                const needs = (dbg.unmatured_needs ?? 0) > 0 ? Math.max(0, dbg.unmatured_needs + (dbg.anchor ?? 0) - (Number(a.size) || 0)) : 0;
                maturingEtaSecs = needs > 0 && leafRate > 0 ? Math.round(needs / leafRate) : null;
                if (why !== lastAnchorWhy || ((dbg.unmatured_needs ?? 0) > 0 && Date.now() - lastAnchorLog > 60_000)) {
                  lastAnchorWhy = why;
                  lastAnchorLog = Date.now();
                  phase("anchor", { outcome: why, anchor_daa: Number(a.daa) || 0, tip, scanned: Number(live.scanned()), ...dbg });
                }
                void d.saveAnchor?.(JSON.stringify({ anchor: a, at: Date.now() }))?.catch?.(() => undefined);
              }
              anchorSetMs = ms(ts);
            })
            .catch(() => {
              /* the previous anchor stands */
            })
        : Promise.resolve(),
      get(`${d.gateway}/mempool`)
        .then((r) => r.json())
        .then((m) => {
          if (Array.isArray(m)) live.set_mempool?.(JSON.stringify(m));
        })
        .catch(() => {
          /* no mempool preview this round */
        }),
    ]);
    const saved = await saving;
    await settleVerify();
    if (!everSynced) {
      phase("at_tip", { verify_ms: verifyMs, save_ms: saved.ms, save_ok: saved.ok, tip_ms: tipMs, anchor_mempool_ms: ms(tAnchor), anchor_set_ms: anchorSetMs, total_ms: ms(t) });
    }
    report("synced");
    everSynced = true;
    await sleep((d.pollSecs ?? 5) * 1000);
    await refreshTip();
  }
}
