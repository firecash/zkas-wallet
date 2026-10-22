// Every request the app makes, timed — without changing a single one of them.
//
// Three paths carry the app's traffic, and each is observed where it already is:
//   - the wallet API (`api.ts req()`): reports itself through `recordRequest`, because only
//     it knows the route (embedded engine, Tor via the shell, clearnet service) and whether
//     the reply parsed;
//   - every other `fetch` (chain API, explorer, prices, services directory): a transparent
//     wrapper around `globalThis.fetch` that forwards the IDENTICAL arguments and hands back
//     the identical response or error;
//   - desktop IPC (`invoke`): a wrapper around the Tauri internals' invoke, timing each
//     command by name. Arguments are never read except the wallet API's `path`/`method`.
//
// Nothing here adds a header, a query parameter, a request or a retry. The privacy gate
// (src/lib/privacy.ts) decides what is fetched; this only watches. test/diag-net.test.ts
// holds the wrapper to that.

import { currentAction, event, isVerbose } from "./log";
import { describeUrl, templatePath, type HostClass } from "./redact";

export type NetOutcome = "ok" | "http" | "timeout" | "unreachable" | "aborted" | "error" | "bad-body";

export interface RequestRecord {
  kind: "api" | "fetch" | "ipc";
  method: string;
  /// Already-templated path, or a raw URL (templated here).
  path?: string;
  url?: string;
  status?: number;
  ms: number;
  bytes?: number;
  outcome: NetOutcome;
  /// Where it went: "engine" (in-process / on-device), "tor", "clearnet", "ipc".
  route?: string;
  host?: HostClass;
  timeoutMs?: number;
  err?: string;
}

// ---- aggregation --------------------------------------------------------------

/// Requests at normal level are recorded individually when they are interesting — part of
/// a user action, failed, slow, or the first of their kind this session — and otherwise
/// folded into a once-a-minute summary. The 1-second status poll alone would be 86,400
/// lines a day; its summary is 1,440 and says more (count, p50, p95, max, errors).
const SLOW_MS = 3_000;
const SUMMARY_MS = 60_000;

interface Agg {
  n: number;
  err: number;
  bytes: number;
  ms: number[];
}
const aggs = new Map<string, Agg>();
const seen = new Set<string>();
let summaryTimer: ReturnType<typeof setInterval> | null = null;

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function flushNetSummary(): void {
  for (const [key, a] of aggs) {
    if (!a.n) continue;
    const sorted = a.ms.slice().sort((x, y) => x - y);
    const [method, host, path] = key.split(" ");
    event("net", "summary", {
      method,
      host_class: host,
      path,
      n: a.n,
      errors: a.err,
      p50: Math.round(pct(sorted, 50)),
      p95: Math.round(pct(sorted, 95)),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
      kb: Math.round(a.bytes / 102.4) / 10,
      window_s: SUMMARY_MS / 1000,
    }, { withAction: false });
  }
  aggs.clear();
}

export function startNetSummary(): void {
  if (summaryTimer) return;
  summaryTimer = setInterval(flushNetSummary, SUMMARY_MS);
}

/// Record one finished request.
export function recordRequest(r: RequestRecord): void {
  const d = r.url ? describeUrl(r.url) : null;
  const path = r.path ? templatePath(r.path) : d?.path ?? "?";
  const host = r.host ?? d?.host ?? "none";
  const key = `${r.method} ${host} ${path}`;
  const failed = r.outcome !== "ok";
  const aid = currentAction()?.id;
  const firstOfKind = !seen.has(`${key} ${r.status ?? r.outcome}`);
  seen.add(`${key} ${r.status ?? r.outcome}`);
  const individually = isVerbose() || failed || !!aid || r.ms >= SLOW_MS || firstOfKind;
  if (individually) {
    event(
      "net",
      "req",
      {
        kind: r.kind,
        method: r.method,
        path,
        host_class: host,
        zkas_host: d?.hostName,
        route: r.route,
        status: r.status,
        outcome: r.outcome,
        bytes: r.bytes,
        timeout_ms: r.timeoutMs,
        err: r.err,
      },
      { dur: r.ms, lvl: failed ? (r.outcome === "http" && (r.status ?? 0) < 500 ? "warn" : "error") : "info" },
    );
  }
  if (!individually || !aid) {
    const a = aggs.get(key) ?? { n: 0, err: 0, bytes: 0, ms: [] };
    a.n++;
    if (failed) a.err++;
    a.bytes += r.bytes ?? 0;
    if (a.ms.length < 500) a.ms.push(r.ms);
    aggs.set(key, a);
  }
}

// ---- the fetch wrapper ------------------------------------------------------------

/// Requests whose owner reports them itself (the wallet API). Keyed by the AbortSignal the
/// owner already passes, so claiming one puts nothing on the wire.
const claimed = new WeakSet<AbortSignal>();

export function claimSignal(signal: AbortSignal): void {
  claimed.add(signal);
}

let originalFetch: typeof fetch | null = null;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

export function installFetchWrapper(): void {
  if (originalFetch || typeof globalThis.fetch !== "function") return;
  const inner = globalThis.fetch;
  originalFetch = inner;
  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal && claimed.has(signal)) return inner.call(globalThis, input, init);
    const t0 = performance.now();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let url = "";
    try {
      url = urlOf(input);
    } catch {
      url = "";
    }
    const p = inner.call(globalThis, input, init);
    p.then(
      (res) => {
        try {
          const len = Number(res.headers.get("content-length") ?? "");
          recordRequest({
            kind: "fetch",
            method,
            url,
            status: res.status,
            ms: performance.now() - t0,
            bytes: Number.isFinite(len) && len > 0 ? len : undefined,
            outcome: res.ok ? "ok" : "http",
          });
        } catch {
          /* observing must never fail the request */
        }
      },
      (e: unknown) => {
        try {
          const aborted = (e as Error)?.name === "AbortError";
          recordRequest({
            kind: "fetch",
            method,
            url,
            ms: performance.now() - t0,
            outcome: aborted ? "aborted" : "unreachable",
            err: (e as Error)?.name,
          });
        } catch {
          /* as above */
        }
      },
    );
    // The caller gets the ORIGINAL promise: same resolution, same rejection, same timing.
    return p;
  };
  globalThis.fetch = wrapped as typeof fetch;
}

/// For tests.
export function uninstallFetchWrapper(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  aggs.clear();
  seen.clear();
}

// ---- the Tauri IPC wrapper ----------------------------------------------------------

type InvokeFn = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
let originalInvoke: InvokeFn | null = null;

/// Commands that are themselves the log's plumbing (or tick every second), recorded only
/// at verbose or never.
const NEVER = new Set(["diag_append", "diag_config", "diag_set_level", "diag_stats", "plugin:event|listen", "plugin:event|unlisten"]);
const CHATTY = new Set(["service_logs", "node_status", "walletd_status", "mining_status", "self_host_status"]);

export function installInvokeWrapper(): void {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }).__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function" || originalInvoke) return;
  const inner = internals.invoke.bind(internals);
  originalInvoke = inner;
  internals.invoke = (cmd: string, args?: unknown, options?: unknown) => {
    if (NEVER.has(cmd)) return inner(cmd, args, options);
    const t0 = performance.now();
    const p = inner(cmd, args, options);
    p.then(
      (res) => {
        try {
          if (cmd === "wallet_api_request") return; // reported by api.ts with more context
          if (CHATTY.has(cmd) && !isVerbose()) {
            recordRequest({ kind: "ipc", method: "IPC", path: `/${cmd}`, host: "ipc", route: "ipc", ms: performance.now() - t0, outcome: "ok" });
            return;
          }
          const bytes = typeof res === "string" ? res.length : undefined;
          event("net", "ipc", { cmd, outcome: "ok", bytes }, { dur: performance.now() - t0 });
        } catch {
          /* never fail the call */
        }
      },
      (e: unknown) => {
        try {
          if (cmd === "wallet_api_request") return;
          event("net", "ipc", { cmd, outcome: "error", msg: typeof e === "string" ? e : (e as Error)?.message }, { dur: performance.now() - t0, lvl: "warn" });
        } catch {
          /* as above */
        }
      },
    );
    return p;
  };
}
