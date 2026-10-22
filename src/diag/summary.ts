// What the Diagnostics screen shows at a glance, computed from the in-memory ring.

import type { DiagEvent } from "./log";

export interface DiagSummary {
  events: number;
  since?: string;
  errors: number;
  warnings: number;
  lastErrors: { t: string; cat: string; ev: string; msg?: string }[];
  sync: {
    state?: string;
    bps?: number;
    avgBps?: number;
    behind?: number;
    /// Behind beyond the settlement margin walletd holds back by design.
    lag?: number;
    timeToSyncedMs?: number;
    usPerAction?: number;
    usPerLeaf?: number;
    fetchPct?: number;
    fetchMsPerPage?: number;
    ingestMsPerPage?: number;
    /// walletd's latest per-wallet `scan_stats` window: where a minute of syncing went.
    stages?: Record<string, number>;
    /// The latest `ckpt_load`: how long opening the wallet took, and from what.
    lastLoad?: Record<string, number>;
  };
  screens: { screen: string; n: number; p50: number; p95: number; max: number }[];
  endpoints: { key: string; n: number; p50: number; p95: number; errors: number }[];
  sends: { n: number; lastTotalMs?: number; lastProveMs?: number; lastSignMs?: number; lastSubmitMs?: number };
  longTasks: number;
  worstLagMs?: number;
}

function pct(v: number[], p: number): number {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function summarize(ring: readonly DiagEvent[]): DiagSummary {
  const out: DiagSummary = {
    events: ring.length,
    since: ring[0]?.t,
    errors: 0,
    warnings: 0,
    lastErrors: [],
    sync: {},
    screens: [],
    endpoints: [],
    sends: { n: 0 },
    longTasks: 0,
  };
  const screens = new Map<string, number[]>();
  const endpoints = new Map<string, { ms: number[]; errors: number; n: number }>();
  const bps: number[] = [];
  for (const e of ring) {
    if (e.lvl === "error") {
      out.errors++;
      out.lastErrors.push({ t: e.t, cat: e.cat, ev: e.ev, msg: typeof e.msg === "string" ? e.msg : typeof e.err === "string" ? e.err : undefined });
    } else if (e.lvl === "warn") out.warnings++;
    if (e.cat === "nav" && e.ev === "screen") {
      const v = num(e.tap_to_paint) ?? num(e.since_tap);
      if (v !== undefined && typeof e.screen === "string") screens.set(e.screen, [...(screens.get(e.screen) ?? []), v]);
    } else if (e.cat === "net" && (e.ev === "req" || e.ev === "summary")) {
      const key = `${e.method ?? ""} ${e.path ?? ""}`;
      const cur = endpoints.get(key) ?? { ms: [], errors: 0, n: 0 };
      if (e.ev === "req") {
        cur.n++;
        if (e.dur !== undefined) cur.ms.push(e.dur);
        if (e.outcome !== "ok") cur.errors++;
      } else {
        cur.n += num(e.n) ?? 0;
        cur.errors += num(e.errors) ?? 0;
        if (num(e.p95) !== undefined) cur.ms.push(e.p95 as number);
      }
      endpoints.set(key, cur);
    } else if (e.cat === "sync") {
      if (e.ev === "state") out.sync.state = String(e.state);
      if (e.ev === "progress") {
        if (num(e.bps) !== undefined) {
          out.sync.bps = e.bps as number;
          bps.push(e.bps as number);
        }
        out.sync.behind = num(e.behind);
        out.sync.lag = num(e.lag);
      }
      if (e.ev === "synced") out.sync.timeToSyncedMs = num(e.since_boot_ms);
      if (e.ev === "scan_cost") {
        out.sync.usPerAction = num(e.us_per_action);
        out.sync.usPerLeaf = num(e.us_per_leaf);
      }
      if (e.ev === "stage_stats") {
        const nums: Record<string, number> = {};
        for (const [k, v] of Object.entries(e)) if (num(v) !== undefined && !["m", "seq", "dur"].includes(k)) nums[k] = v as number;
        if (e.kind === "scan_stats") {
          out.sync.stages = nums;
          if (num(e.decrypt_us_per_action) !== undefined) out.sync.usPerAction = e.decrypt_us_per_action as number;
        } else if (e.kind === "ckpt_load") out.sync.lastLoad = nums;
      }
      if (e.ev === "page_pipeline") {
        out.sync.fetchPct = num(e.fetch_pct);
        out.sync.fetchMsPerPage = num(e.fetch_ms_per_page);
        out.sync.ingestMsPerPage = num(e.ingest_ms_per_page);
      }
    } else if (e.cat === "send") {
      if (e.ev === "done") {
        out.sends.n++;
        out.sends.lastTotalMs = e.dur;
      }
      if (e.ev === "prepare") out.sends.lastProveMs = e.dur;
      if (e.ev === "sign") out.sends.lastSignMs = e.dur;
      if (e.ev === "submit") out.sends.lastSubmitMs = e.dur;
    } else if (e.cat === "perf") {
      if (e.ev === "longtask") out.longTasks++;
      if (e.ev === "loop_lag") out.worstLagMs = Math.max(out.worstLagMs ?? 0, num(e.lag_ms) ?? 0);
    }
  }
  if (bps.length) out.sync.avgBps = Math.round((bps.reduce((a, b) => a + b, 0) / bps.length) * 10) / 10;
  out.lastErrors = out.lastErrors.slice(-5).reverse();
  out.screens = [...screens.entries()]
    .map(([screen, v]) => ({ screen, n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: Math.round(Math.max(...v)) }))
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 8);
  out.endpoints = [...endpoints.entries()]
    .map(([key, v]) => ({ key, n: v.n, p50: pct(v.ms, 50), p95: pct(v.ms, 95), errors: v.errors }))
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 8);
  return out;
}
