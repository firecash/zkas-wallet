// Sync, as a story the log can tell: which state the wallet was in, for how long, how fast
// it moved, when it stalled, when it arrived — and, from the engine's own counters, where
// the time went (trial decryption µs/action, tree µs/leaf, page fetch vs ingest).
//
// Two inputs, both already flowing through the app:
//   1. every `/api/status` reply the poll receives (`observeStatus`), and
//   2. the engine's own log lines (`ingestEngineText`), read from the Tauri log bridge on
//      desktop and from the on-device engine's ring on Android. The engine already reports
//      its scan cost at INFO; here those lines are parsed into numbers so they can be
//      charted and summarised, and kept (redacted) as lines so nothing is lost.

import type { Status } from "../api";
import { SETTLE_MARGIN, syncRate } from "../lib/syncrate";
import { event, isVerbose, safeText } from "./log";
import { partEnabled, partOfEngineLine } from "./parts";

export type SyncState = "no_wallet" | "loading" | "node_down" | "syncing" | "stalled" | "warming" | "synced" | "unreachable";

const PROGRESS_MS = 15_000;

let state: SyncState | null = null;
let stateSince = 0;
let lastProgressAt = -Infinity;
let firstProgress: { at: number; scanned: number } | null = null;
let syncedOnce = false;
let failStreak = 0;
let failSince = 0;

export function stateOf(s: Status, stalled: boolean): SyncState {
  if (!s.has_wallet) return "no_wallet";
  if (s.loading) return "loading";
  if (s.node_connected === false) return "node_down";
  if (s.synced) return s.warming ? "warming" : "synced";
  return stalled ? "stalled" : "syncing";
}

function transition(next: SyncState, fields: Record<string, unknown> = {}): void {
  const now = performance.now();
  if (state === next) return;
  const prev = state;
  const prevMs = prev ? Math.round(now - stateSince) : undefined;
  state = next;
  stateSince = now;
  const lvl = next === "stalled" || next === "node_down" || next === "unreachable" ? "warn" : "info";
  event("sync", "state", { state: next, prev, prev_ms: prevMs, ...fields }, { lvl });
}

/// One status reply arrived.
export function observeStatus(s: Status): void {
  const now = performance.now();
  if (failStreak > 0) {
    event("sync", "poll_recovered", { failures: failStreak }, { dur: now - failSince });
    failStreak = 0;
  }
  const r = syncRate();
  const tip = Math.max(s.daa_score || 0, s.chain_len || 0);
  const next = stateOf(s, r.stalled);
  transition(next, { scanned: s.scanned_blocks, tip, behind: r.behind, lag: r.lag });

  if (!firstProgress && s.has_wallet && !s.loading) firstProgress = { at: now, scanned: s.scanned_blocks };
  const due = isVerbose() || now - lastProgressAt >= PROGRESS_MS;
  if (due && s.has_wallet) {
    lastProgressAt = now;
    event(
      "sync",
      "progress",
      {
        scanned: s.scanned_blocks,
        tip,
        behind: r.behind,
        // `behind` includes the ~200 blocks walletd holds back until they settle (payments in
        // them show as pending); `lag` is what is left beyond that margin.
        lag: r.lag,
        settle_margin: SETTLE_MARGIN,
        bps: r.blocksPerSec === null ? undefined : Math.round(r.blocksPerSec * 10) / 10,
        eta_s: r.etaSecs === null ? undefined : Math.round(r.etaSecs),
        window_s: Math.round(r.windowSecs),
        synced: s.synced,
        spend_ready: s.spend_ready,
        notes: s.note_count,
        warming_pct: s.warming_pct === undefined ? undefined : Math.round(s.warming_pct * 10) / 10,
        warming_eta_s: s.warming_eta_secs,
        node: s.node_connected,
        missing_history: s.missing_history || undefined,
      },
      { verbose: false },
    );
  }
  if (!syncedOnce && s.synced && s.has_wallet) {
    syncedOnce = true;
    event("sync", "synced", {
      since_boot_ms: Math.round(now),
      since_first_progress_ms: firstProgress ? Math.round(now - firstProgress.at) : undefined,
      blocks_scanned: firstProgress ? Math.max(0, s.scanned_blocks - firstProgress.scanned) : undefined,
    });
  }
}

/// The status poll failed (`kind` is the error's class, never its text).
export function observePollFailure(kind: string): void {
  if (failStreak === 0) failSince = performance.now();
  failStreak++;
  if (failStreak === 1 || failStreak === 5 || failStreak % 60 === 0) {
    event("sync", "poll_failed", { kind, streak: failStreak }, { lvl: failStreak >= 5 ? "warn" : "info" });
  }
  if (failStreak === 5) transition("unreachable", { kind });
}

// ---- engine lines --------------------------------------------------------------

const ENGINE_LINES_PER_MIN = 60;
let engineMinute = 0;
let engineInMinute = 0;
let engineSuppressed = 0;
const lastSeen = new Map<string, string>();
/// Wall-clock ms at which THIS app process started (0 = unknown). The engine runs in-process
/// on desktop and Android, so an engine line stamped before it belongs to a previous session —
/// and the desktop log bridge replays services.log at startup, which made run 2 of the smoke
/// test re-record run 1's scan-cost and page-pipeline figures under its own session id.
let engineSessionStartMs = 0;

/// Set from the native config at install: Date.now() − process uptime.
export function setEngineSessionStart(ms: number): void {
  engineSessionStartMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/// The engine's own timestamp on a raw line, in ms: desktop rows start with unix ms, the
/// Android ring with unix seconds. Undefined when the line has none (kept, then).
export function engineLineTimeMs(raw: string): number | undefined {
  const m = /^(\d{9,13}) /.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1e12 ? n : n * 1000;
}

/// Rust's `{:?}` for a Duration: "5.2s", "312.4ms", "17µs", "1.5m" isn't produced.
export function rustDurationMs(s: string): number | undefined {
  const m = /^([\d.]+)\s*(ns|µs|us|ms|s)$/.exec(s.trim());
  if (!m) return undefined;
  const v = Number(m[1]);
  switch (m[2]) {
    case "ns": return v / 1e6;
    case "µs":
    case "us": return v / 1e3;
    case "ms": return v;
    case "s": return v * 1e3;
  }
  return undefined;
}

const D = "([\\d.]+(?:ns|µs|us|ms|s))";
const PARSERS: { re: RegExp; ev: string; map: (m: RegExpExecArray) => Record<string, unknown> }[] = [
  {
    re: /scan cost so far: decrypt (\d+) ms \((\d+)%\) over (\d+) actions = ([\d.]+) us\/action \| tree (\d+) ms \((\d+)%\) over (\d+) leaves = ([\d.]+) us\/leaf/,
    ev: "scan_cost",
    map: (m) => ({ decrypt_ms: +m[1], decrypt_pct: +m[2], actions: +m[3], us_per_action: +m[4], tree_ms: +m[5], tree_pct: +m[6], leaves: +m[7], us_per_leaf: +m[8] }),
  },
  {
    re: /tree split: mirror (\d+) ms \(([\d.]+) us\/leaf[^|]*\| subtree cache (\d+) ms \(([\d.]+) us\/leaf/,
    ev: "tree_split",
    map: (m) => ({ mirror_ms: +m[1], mirror_us_per_leaf: +m[2], subtree_ms: +m[3], subtree_us_per_leaf: +m[4] }),
  },
  {
    re: /page pipeline: fetch (\d+) ms \(([\d.]+) ms\/page\) \| ingest (\d+) ms \(([\d.]+) ms\/page\) \| (\d+) pages -> fetch is (\d+)%/,
    ev: "page_pipeline",
    map: (m) => ({ fetch_ms: +m[1], fetch_ms_per_page: +m[2], ingest_ms: +m[3], ingest_ms_per_page: +m[4], pages: +m[5], fetch_pct: +m[6] }),
  },
  {
    re: /page contents: (\d+) actions over (\d+) pages = ([\d.]+) actions\/page/,
    ev: "page_contents",
    map: (m) => ({ actions: +m[1], pages: +m[2], actions_per_page: +m[3] }),
  },
  { re: new RegExp(`prepare: Halo2 proof took ${D}`), ev: "engine_timing", map: (m) => ({ what: "halo2_proof", ms: rustDurationMs(m[1]) }) },
  { re: new RegExp(`send: tx (\\d+)/(\\d+) proven in ${D}`), ev: "engine_timing", map: (m) => ({ what: "send_tx_proven", part: +m[1], parts: +m[2], ms: rustDurationMs(m[3]) }) },
  { re: new RegExp(`leaf-stream decoded in ${D}`), ev: "engine_timing", map: (m) => ({ what: "leaf_stream_decode", ms: rustDurationMs(m[1]) }) },
  { re: new RegExp(`Orchard proving key ready in ${D}`), ev: "engine_timing", map: (m) => ({ what: "proving_key", ms: rustDurationMs(m[1]) }) },
  { re: new RegExp(`spend-ready in ${D} \\((\\d+) leaves`), ev: "engine_timing", map: (m) => ({ what: "spend_ready", ms: rustDurationMs(m[1]), leaves: +m[2] }) },
  { re: new RegExp(`witness_path_at\\(note@\\d+\\) took ${D}`), ev: "engine_timing", map: (m) => ({ what: "witness_fallback", ms: rustDurationMs(m[1]) }) },
  { re: /wallet sync page timed out after ([\d.]+\w+)/, ev: "page_timeout", map: (m) => ({ after_ms: rustDurationMs(m[1]) }) },
  { re: /checkpoint on request: saved (\d+)\/(\d+) wallet\(s\), preserving (\d+) block/, ev: "checkpoint", map: (m) => ({ saved: +m[1], total: +m[2], blocks: +m[3] }) },
  { re: /release_memory: dropped (\d+) decoded leaves/, ev: "release_memory", map: (m) => ({ leaves: +m[1] }) },
  // Chain files and the frontier almanac: where catch-up came from, and what it cost.
  {
    re: /chain files: segment (\d+) ready: (\d+) blocks, (\d+) KB, (\d+) ms \((\d+) MB downloaded this session, (\d+) pages served from files\)/,
    ev: "chain_file_segment",
    map: (m) => ({ segment: +m[1], blocks: +m[2], kb: +m[3], ms: +m[4], session_mb: +m[5], pages: +m[6] }),
  },
  { re: /chain files: segment (\d+) fetched (\d+) times this session \((\d+) MB/, ev: "chain_file_refetch", map: (m) => ({ segment: +m[1], times: +m[2], session_mb: +m[3] }) },
  { re: /chain files verified: the tree built from them equals the node's/, ev: "chain_files_verified", map: () => ({}) },
  { re: /chain files DISABLED: (.*)$/, ev: "chain_files_disabled", map: (m) => ({ why: m[1].slice(0, 200) }) },
  { re: /starting from the frontier almanac at daa (\d+) \(tree position (\d+)\)/, ev: "almanac_start", map: (m) => ({ daa: +m[1], position: +m[2] }) },
  // walletd's structured per-wallet stage timings (zkas-rusty 0fb6f65): one `scan_stats` line
  // per wallet per minute at most, and one `ckpt_load` per wallet load. Space-separated
  // key=value, keys [a-z_]+, every value a number except `tok` (a SHA-256 pseudonym of the
  // wallet token, never the token). Keys may be appended, never renamed; `v` bumps if a
  // meaning changes. So one generic entry, not a regex per field: a key added later is
  // recorded without an app release.
  { re: /^(scan_stats|ckpt_load) (v=\d+(?: [a-z_]+=[^ ]+)*)$/, ev: "stage_stats", map: (m) => kvFields(m[1], m[2]) },
];

function kvFields(kind: string, body: string): Record<string, unknown> {
  const o: Record<string, unknown> = { kind };
  for (const kv of body.split(" ")) {
    const i = kv.indexOf("=");
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    if (k === "tok") o.tok = v;
    else if (Number.isFinite(Number(v))) o[k] = Number(v);
  }
  return o;
}

/// Parse one engine message into a structured sync event, if it is one of the known ones.
export function parseEngineMessage(msg: string): { ev: string; fields: Record<string, unknown> } | null {
  for (const p of PARSERS) {
    const m = p.re.exec(msg);
    if (m) return { ev: p.ev, fields: p.map(m) };
  }
  return null;
}

interface EngineLine {
  level: string;
  target?: string;
  msg: string;
}

/// Android ring: `secs [INFO] target: message`. Desktop bridge rows, as the poller builds
/// them: `unix_ms [INFO target] message` (the timestamp keeps two identical messages
/// distinct, which the dedup below relies on).
export function splitEngineLine(raw: string): EngineLine {
  let m = /^\d+ \[(\w+)\] (\S+?): (.*)$/.exec(raw);
  if (m) return { level: m[1], target: m[2].split("::").pop(), msg: m[3] };
  m = /^(?:\d+ )?\[(\w+)(?: ([^\]]+))?\] (.*)$/.exec(raw);
  if (m) return { level: m[1], target: m[2], msg: m[3] };
  return { level: "INFO", msg: raw };
}

/// The whole module path of an Android ring line (`zkas_walletd::chain_files`), which
/// `splitEngineLine` shortens to its last segment: the log-part filter needs all of it to
/// tell walletd's own submodules from third-party crates. Desktop rows carry it already.
function moduleOf(raw: string, line: EngineLine): string | undefined {
  return /^\d+ \[\w+\] (\S+?): /.exec(raw)?.[1] ?? line.target;
}

function emitEngineLine(line: EngineLine, source: string, module?: string): void {
  const lvl = /^err/i.test(line.level) ? "error" : /^warn/i.test(line.level) ? "warn" : /^(debug|trace)/i.test(line.level) ? "debug" : "info";
  // Settings → Log parts, decided BEFORE anything is recorded: a part switched off drops both
  // the raw line and the structured event parsed from it. Warnings and errors are kept.
  const part = partOfEngineLine(module ?? line.target, line.msg);
  if (!partEnabled(part) && lvl !== "error" && lvl !== "warn") return;
  const parsed = parseEngineMessage(line.msg);
  if (parsed) event("sync", parsed.ev, { ...parsed.fields, source }, { withAction: false, part });
  if (lvl === "debug" && !isVerbose()) return;
  // Rate-limited at normal: the engine is chatty, and the files are a ring — a flood of
  // engine lines must not rotate the app's own events out.
  if (!isVerbose() && !parsed && lvl !== "error" && lvl !== "warn") {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== engineMinute) {
      if (engineSuppressed > 0) event("engine", "suppressed", { lines: engineSuppressed, source });
      engineMinute = minute;
      engineInMinute = 0;
      engineSuppressed = 0;
    }
    if (++engineInMinute > ENGINE_LINES_PER_MIN) {
      engineSuppressed++;
      return;
    }
  }
  event("engine", "line", { source, level: line.level.toLowerCase(), target: line.target, line: safeText(line.msg, 600) }, { lvl, withAction: false });
}

/// Feed the engine's current log text; only lines not seen before are recorded.
///
/// Both sources return a RING (newest last). The last line recorded is remembered, and
/// everything after its last occurrence is new. If it is no longer in the ring, the ring
/// has wrapped past it: everything is new, and the gap is said out loud.
export function ingestEngineText(text: string, source: "desktop" | "android"): number {
  if (!text) return 0;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (!lines.length) return 0;
  const last = lastSeen.get(source);
  let start = 0;
  if (last !== undefined) {
    const at = lines.lastIndexOf(last);
    if (at >= 0) start = at + 1;
    else event("engine", "gap", { source, lines: lines.length }, { lvl: "warn" });
  } else {
    // First read this session: the ring holds the engine's history since it started, which
    // is worth having once, but cap it so a 3,000-line ring does not land in one burst.
    start = Math.max(0, lines.length - 400);
    if (start > 0) event("engine", "backlog_skipped", { source, lines: start });
  }
  lastSeen.set(source, lines[lines.length - 1]);
  let n = 0;
  let previous = 0;
  for (const raw of lines.slice(start)) {
    if (/^(how this app ended|last-exit history|\s{2}\d{4}-)/.test(raw)) continue; // the exit-history prefix
    const at = engineSessionStartMs ? engineLineTimeMs(raw) : undefined;
    if (at !== undefined && at < engineSessionStartMs) {
      // Already in the previous session's own log, if logging was on then.
      previous++;
      continue;
    }
    const line = splitEngineLine(raw);
    emitEngineLine(line, source, moduleOf(raw, line));
    n++;
  }
  if (previous) event("engine", "previous_session_skipped", { source, lines: previous });
  return n;
}

/// For tests.
export function resetSyncForTests(): void {
  state = null;
  stateSince = 0;
  lastProgressAt = -Infinity;
  firstProgress = null;
  syncedOnce = false;
  failStreak = 0;
  lastSeen.clear();
  engineSessionStartMs = 0;
  engineMinute = 0;
  engineInMinute = 0;
  engineSuppressed = 0;
}
