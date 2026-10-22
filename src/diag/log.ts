// The diagnostic log: one structured, redacted event stream for the whole app.
//
// What a call costs: an O(1) push onto an in-memory ring plus the redaction of its fields
// (microseconds; measured in test/diag-overhead.test.ts). Nothing here touches storage or
// the network on the calling thread. A timer drains the queue in batches to the platform
// sink (the Tauri shell's file writer, the Android plugin's, or nothing on the web), so a
// burst of events never becomes a burst of main-thread I/O.
//
// What it records is decided by the level the user picked in Settings → Diagnostics:
//   off      nothing at all
//   normal   (default) lifecycle, screens, taps, every non-poll request, poll summaries,
//            sync progress, errors, performance outliers
//   verbose  everything normal records, plus every request, every status poll, debug
//            engine lines and smaller performance outliers
// No level records a sensitive field: verbose changes VOLUME, never what kind of data.

import { redactError, redactFields, redactText } from "./redact";

export type DiagLevel = "off" | "normal" | "verbose";
export type Severity = "debug" | "info" | "warn" | "error";

export interface DiagEvent {
  t: string;
  m: number;
  src: string;
  sid: string;
  seq: number;
  lvl: Severity;
  cat: string;
  ev: string;
  dur?: number;
  aid?: string;
  [field: string]: unknown;
}

export interface DiagSink {
  /// Write a batch of already-redacted JSON lines. Must not throw synchronously.
  append(lines: string[]): Promise<void>;
  /// Persist the level (native shells keep it so their own collectors honour it at boot).
  setLevel?(level: DiagLevel): Promise<void>;
}

const LEVEL_KEY = "diag_level";
const RING_MAX = 3_000;
const FLUSH_MS = 2_000;
const FLUSH_BATCH = 100;
/// A queue that cannot drain (sink broken) must not grow without bound.
const QUEUE_MAX = 5_000;
/// How long a tap keeps "owning" the requests and renders that follow it.
export const ACTION_WINDOW_MS = 5_000;

let level: DiagLevel = readLevel();
let sink: DiagSink | null = null;
/// Settled once the platform has said whether it has a sink. Until then, events queue so
/// the boot sequence reaches the file; after it settles with none (the web), the ring is
/// the whole log and nothing queues.
let sinkSettled = false;
const ring: DiagEvent[] = [];
let queue: string[] = [];
let seq = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
const listeners = new Set<(e: DiagEvent) => void>();

/// 12 hex characters: unique enough per device, and deliberately below the 16-hex-run rule
/// the redaction checker enforces on every line.
export const sessionId: string = randomId(6);

// Self-accounting, reported as `diag.self`: the overhead budget is measured, not assumed.
const stats = { events: 0, bytes: 0, dropped: 0, logMs: 0, flushMs: 0, flushes: 0, sinkErrors: 0 };

function randomId(bytes: number): string {
  const a = new Uint8Array(bytes);
  try {
    crypto.getRandomValues(a);
  } catch {
    for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readLevel(): DiagLevel {
  try {
    const v = localStorage.getItem(LEVEL_KEY);
    if (v === "off" || v === "normal" || v === "verbose") return v;
  } catch {
    /* storage blocked: default */
  }
  return "normal";
}

export function getLevel(): DiagLevel {
  return level;
}

export function isVerbose(): boolean {
  return level === "verbose";
}

export function enabled(): boolean {
  return level !== "off";
}

export function setLevel(next: DiagLevel, fromNative = false): void {
  if (next === level) return;
  const prev = level;
  // Recorded on the way out of "off" and on the way into it, so the log shows the gap.
  if (prev !== "off") event("app", "level", { prev, next });
  level = next;
  try {
    localStorage.setItem(LEVEL_KEY, next);
  } catch {
    /* best effort */
  }
  if (next !== "off") event("app", "level", { prev, next });
  if (!fromNative) void sink?.setLevel?.(next).catch(() => undefined);
  if (next === "off") {
    queue = [];
  }
}

export function installSink(s: DiagSink | null): void {
  sink = s;
  sinkSettled = true;
  if (!sink) queue = [];
  if (sink && queue.length) scheduleFlush(0);
}

export function hasSink(): boolean {
  return sink !== null;
}

// ---- actions (correlation) ------------------------------------------------------

let action: { id: string; at: number; kind: string; target?: string } | null = null;
let actionSeq = 0;

/// A user interaction started. Requests and renders inside the window carry its id.
export function beginAction(kind: string, target?: string): string {
  const id = `a${++actionSeq}`;
  action = { id, at: performance.now(), kind, target };
  return id;
}

/// The action that currently owns new work, if it is still inside its window.
export function currentAction(): { id: string; at: number; kind: string; target?: string } | null {
  if (!action) return null;
  if (performance.now() - action.at > ACTION_WINDOW_MS) return null;
  return action;
}

// ---- recording ------------------------------------------------------------------

export interface EventOpts {
  lvl?: Severity;
  dur?: number;
  /// Only recorded at verbose.
  verbose?: boolean;
  /// Attach the current action id (default: true for ui/nav/net/send).
  withAction?: boolean;
}

const ACTION_CATS = new Set(["ui", "nav", "net", "send", "signer"]);

/// Record one event. Fields are redacted here — the ONLY way into the ring.
export function event(cat: string, ev: string, fields: Record<string, unknown> = {}, opts: EventOpts = {}): void {
  if (level === "off") return;
  if (opts.verbose && level !== "verbose") return;
  const started = performance.now();
  try {
    const e: DiagEvent = {
      t: new Date().toISOString(),
      m: Math.round(started * 10) / 10,
      src: "js",
      sid: sessionId,
      seq: ++seq,
      lvl: opts.lvl ?? "info",
      cat,
      ev,
    };
    if (opts.dur !== undefined) e.dur = Math.round(opts.dur * 10) / 10;
    if (opts.withAction ?? ACTION_CATS.has(cat)) {
      const a = currentAction();
      if (a && fields.aid === undefined) e.aid = a.id;
    }
    const safe = redactFields(fields);
    for (const [k, v] of Object.entries(safe)) {
      if (k in e && k !== "aid") continue; // never let a field overwrite the envelope
      if (v !== undefined) e[k] = v;
    }
    push(e);
  } catch {
    stats.dropped++;
  } finally {
    stats.logMs += performance.now() - started;
  }
}

/// Record an error with its stack, redacted.
export function error(cat: string, ev: string, err: unknown, fields: Record<string, unknown> = {}): void {
  const r = redactError(err);
  event(cat, ev, { ...fields, err: r.name, msg: r.message, stack: r.stack }, { lvl: "error" });
}

/// Time a piece of work. `end()` records it with its duration.
export function span(cat: string, ev: string, fields: Record<string, unknown> = {}, opts: EventOpts = {}) {
  const t0 = performance.now();
  const aid = currentAction()?.id;
  return {
    t0,
    end(extra: Record<string, unknown> = {}, endOpts: EventOpts = {}) {
      const dur = performance.now() - t0;
      event(cat, ev, { ...(aid ? { aid } : {}), ...fields, ...extra }, { ...opts, ...endOpts, dur });
      return dur;
    },
  };
}

/// For text that did not come from this app (engine lines, console): redacted, capped.
export function safeText(s: string, max = 600): string {
  return redactText(s, max);
}

function push(e: DiagEvent): void {
  ring.push(e);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  stats.events++;
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* a broken viewer must not break logging */
    }
  }
  if (!sink) {
    // Before the native sink is installed, keep a bounded queue so boot events reach the
    // file once the shell answers. On the web (settled, no sink) the ring is the log.
    if (sinkSettled) return;
    if (queue.length < QUEUE_MAX) queue.push(JSON.stringify(e));
    else stats.dropped++;
    return;
  }
  const line = JSON.stringify(e);
  stats.bytes += line.length + 1;
  if (queue.length >= QUEUE_MAX) {
    queue.shift();
    stats.dropped++;
  }
  queue.push(line);
  scheduleFlush(queue.length >= FLUSH_BATCH ? 0 : FLUSH_MS);
}

function scheduleFlush(ms: number): void {
  if (flushTimer !== null) {
    if (ms > 0) return;
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, ms);
}

/// Drain the queue to the sink. Safe to call any time; concurrent calls coalesce.
export async function flush(): Promise<void> {
  if (!sink || flushing || queue.length === 0) return;
  flushing = true;
  const t0 = performance.now();
  const batch = queue.splice(0, 500);
  try {
    await sink.append(batch);
    stats.flushes++;
  } catch {
    stats.sinkErrors++;
    // Put them back once; a sink that keeps failing will hit QUEUE_MAX and shed the oldest.
    queue = batch.concat(queue).slice(-QUEUE_MAX);
  } finally {
    flushing = false;
    stats.flushMs += performance.now() - t0;
    if (queue.length) scheduleFlush(FLUSH_MS);
  }
}

/// An event a native layer already wrote to the file: shown, never re-queued.
export function ingestForeign(e: DiagEvent): void {
  if (level === "off") return;
  ring.push(e);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* as in push */
    }
  }
}

// ---- reading --------------------------------------------------------------------

export function recent(): readonly DiagEvent[] {
  return ring;
}

export function subscribe(fn: (e: DiagEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearRing(): void {
  ring.length = 0;
  queue = [];
}

export function selfStats() {
  return { ...stats, queued: queue.length, ring: ring.length, level };
}

/// For tests only.
export function resetForTests(): void {
  ring.length = 0;
  queue = [];
  seq = 0;
  action = null;
  sink = null;
  sinkSettled = false;
  level = "normal";
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  flushing = false;
  listeners.clear();
  for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0;
}
