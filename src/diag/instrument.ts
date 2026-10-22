// Installs every passive collector of the diagnostic log, once, at the top of main.tsx.
//
//   errors       window errors (with stack), unhandled rejections, CSP violations, failed
//                resource loads, console.error/warn (mirrored, redacted)
//   interaction  every tap/click (stable element id, never free text with figures), form
//                submits, toggles, selects, committed fields (never their values), pastes
//                (never their content), keyboard shortcuts (never typing), hardware Back
//   lifecycle    boot timings, first render, interactive, background/foreground with time
//                away and resume-to-frame, online/offline, unload
//   performance  long tasks (Chromium WebViews), event-loop lag (everywhere — WebKit has no
//                long-task API), JS heap, frame drops (verbose), the logger's own cost
//   network      transparent fetch + Tauri IPC observers (see net.ts)
//   engine       the engine's own log, polled and parsed (see sync.ts)

import { APP_BUILT, APP_VERSION } from "../version";
import { privacyMode } from "../lib/privacy";
import {
  ACTION_WINDOW_MS,
  beginAction,
  currentAction,
  enabled,
  error as logError,
  event,
  flush,
  getLevel,
  isVerbose,
  selfStats,
  sessionId,
} from "./log";
import { installFetchWrapper, installInvokeWrapper, startNetSummary, flushNetSummary } from "./net";
import { describeUrl, redactText, safeLabel, setKnownSecrets } from "./redact";
import { activeScreen } from "./screens";
import { connectSink, diagPlatform, type NativeDiagConfig } from "./sink";
import { ingestEngineText } from "./sync";
import { ingestNativeLine } from "./native";

let installed = false;
let nativeConfig: NativeDiagConfig | null = null;
/// performance.now() at the moment the native side reported its uptime.
let procOffsetMs: number | null = null;
const jsInstallAt = typeof performance !== "undefined" ? performance.now() : 0;

export function nativeDiagConfig(): NativeDiagConfig | null {
  return nativeConfig;
}

/// ms from process start to `perfNow`, when the native side told us when it started.
function sinceProcess(perfNow: number): number | undefined {
  return procOffsetMs === null ? undefined : Math.round(perfNow + procOffsetMs);
}

// ---- element identity -----------------------------------------------------------

const INTERACTIVE =
  "button, a[href], [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=radio], [role=option], [role=link], input, select, textarea, label, summary, [data-diag]";

function safeId(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  if (!/^[A-Za-z][\w.:-]{0,48}$/.test(v)) return undefined;
  if (/\d{4,}/.test(v)) return undefined;
  return v;
}

export function describeElement(target: EventTarget | null): Record<string, unknown> | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(INTERACTIVE) ?? target;
  const tag = el.tagName.toLowerCase();
  const out: Record<string, unknown> = { el: tag };
  const id =
    safeId(el.getAttribute("data-diag")) ??
    safeId(el.getAttribute("data-testid")) ??
    safeId(el.id) ??
    safeId(el.getAttribute("name"));
  if (id) out.id = id;
  const role = el.getAttribute("role");
  if (role) out.role = role;
  if (el instanceof HTMLInputElement) out.type = el.type;
  const cls = [...el.classList].filter((c) => /^[a-z][\w-]{0,30}$/i.test(c)).slice(0, 3).join(".");
  if (cls) out.cls = cls;
  // A label only from an explicit accessible name or a short text node, and only if it is
  // words: a button reading "Send 1.5 ZKAS" or showing an address is dropped, not cleaned.
  const textual = tag === "button" || tag === "a" || tag === "summary" || tag === "label" || !!role;
  const raw = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? (textual ? (el.textContent ?? "").slice(0, 60) : null);
  const label = safeLabel(raw);
  // `ui_label`, not `label`: a field called `label` is a contact label and is dropped.
  if (label) out.ui_label = label;
  const scope = el.closest("[data-diag-scope], [role=dialog]");
  if (scope) {
    const s = safeId(scope.getAttribute("data-diag-scope")) ?? safeLabel(scope.getAttribute("aria-label"));
    if (s) out.scope = s;
  }
  if (el instanceof HTMLButtonElement && el.disabled) out.disabled = true;
  out.screen = activeScreen() || undefined;
  return out;
}

// ---- collectors -----------------------------------------------------------------

function installErrorCapture(): void {
  window.addEventListener(
    "error",
    (e: Event) => {
      if (e instanceof ErrorEvent) {
        logError("err", "uncaught", e.error ?? e.message, { where: e.filename ? describeUrl(e.filename).path : undefined, line: e.lineno, col: e.colno });
        return;
      }
      // A failed <script>/<link>/<img> load reports on the element, not as an ErrorEvent.
      const t = e.target as Element | null;
      if (t && t !== (window as unknown as Element)) {
        const src = (t as HTMLScriptElement).src || (t as HTMLLinkElement).href || "";
        event("err", "resource", { tag: t.tagName?.toLowerCase(), path: src ? describeUrl(src).path : undefined }, { lvl: "error" });
      }
    },
    true,
  );
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    logError("err", "rejection", e.reason);
  });
  document.addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => {
    event("err", "csp", { directive: e.violatedDirective, blocked: e.blockedURI ? describeUrl(e.blockedURI).path : undefined, disposition: e.disposition }, { lvl: "error" });
  });
}

let inConsole = false;
function installConsoleMirror(): void {
  const levels: ("error" | "warn" | "info" | "log")[] = ["error", "warn", "info", "log"];
  for (const name of levels) {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      orig(...args);
      if (inConsole || !enabled()) return;
      if ((name === "log" || name === "info") && !isVerbose()) return;
      inConsole = true;
      try {
        const text = args
          .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
          .join(" ");
        const stack = args.find((a): a is Error => a instanceof Error)?.stack;
        event("err", "console", { level: name, msg: redactText(text, 500), stack }, { lvl: name === "error" ? "error" : name === "warn" ? "warn" : "debug" });
      } finally {
        inConsole = false;
      }
    };
  }
}

function installInteractionCapture(): void {
  let lastPointerAid: { id: string; at: number } | null = null;
  document.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (!enabled()) return;
      const d = describeElement(e.target);
      const id = beginAction("tap", (d?.id as string | undefined) ?? (d?.label as string | undefined));
      lastPointerAid = { id, at: performance.now() };
    },
    true,
  );
  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      if (!enabled()) return;
      const d = describeElement(e.target);
      if (!d) return;
      // A click with no pointer-down before it is the keyboard (Enter/Space) or a script.
      const recent = lastPointerAid && performance.now() - lastPointerAid.at < 2_000;
      if (!recent) beginAction(e.isTrusted ? "key" : "script", (d.id as string | undefined) ?? (d.label as string | undefined));
      lastPointerAid = null;
      const a = currentAction();
      event("ui", "tap", { ...d, trusted: e.isTrusted || undefined, press_ms: a ? Math.round(performance.now() - a.at) : undefined });
    },
    true,
  );
  document.addEventListener(
    "submit",
    (e: Event) => {
      if (!enabled()) return;
      const f = e.target as HTMLFormElement;
      beginAction("submit", safeId(f?.id) ?? safeId(f?.getAttribute?.("name")));
      event("ui", "submit", { id: safeId(f?.getAttribute?.("data-diag")) ?? safeId(f?.id) ?? safeId(f?.getAttribute?.("name")), screen: activeScreen() || undefined });
    },
    true,
  );
  document.addEventListener(
    "change",
    (e: Event) => {
      if (!enabled()) return;
      const t = e.target;
      const d = describeElement(t);
      if (!d) return;
      if (t instanceof HTMLInputElement && (t.type === "checkbox" || t.type === "radio")) {
        event("ui", "toggle", { ...d, checked: t.checked });
      } else if (t instanceof HTMLSelectElement) {
        // Option values here are enums (language codes, levels, node presets). Anything
        // that does not look like one is withheld.
        const v = /^[a-z][\w-]{0,15}$/i.test(t.value) && !/\d{3,}/.test(t.value) ? t.value : undefined;
        event("ui", "select", { ...d, choice: v, index: t.selectedIndex });
      } else if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
        // A committed text field: which one, and whether it is filled. Never the value.
        event("ui", "field", { ...d, filled: t.value.length > 0 });
      }
    },
    true,
  );
  document.addEventListener(
    "paste",
    (e: ClipboardEvent) => {
      if (!enabled()) return;
      const d = describeElement(e.target);
      event("ui", "paste", { ...(d ?? {}) });
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!enabled()) return;
      // Shortcuts and Escape only. Ordinary typing is never recorded, not even its timing.
      if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key.length === 1)) {
        beginAction("key");
        const combo = `${e.ctrlKey ? "Ctrl+" : ""}${e.metaKey ? "Meta+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
        event("ui", "key", { combo, screen: activeScreen() || undefined });
      }
    },
    true,
  );
  window.addEventListener("zkas:back", () => {
    if (!enabled()) return;
    beginAction("back");
    event("nav", "back", { screen: activeScreen() || undefined });
  });
}

function installLifecycle(): void {
  let hiddenAt: number | null = document.visibilityState === "hidden" ? performance.now() : null;
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      if (hiddenAt !== null) return;
      hiddenAt = performance.now();
      event("app", "background", { screen: activeScreen() || undefined });
      flushNetSummary();
      void flush();
    } else {
      if (hiddenAt === null) return;
      const away = performance.now() - hiddenAt;
      hiddenAt = null;
      const t0 = performance.now();
      const done = (frame?: number) => event("app", "foreground", { away_ms: Math.round(away), resume_frame_ms: frame === undefined ? undefined : Math.round(frame), screen: activeScreen() || undefined });
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - t0)));
      } catch {
        done();
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  // Capacitor's Cordova-compatible lifecycle events, for WebViews that do not flip
  // visibility on pause/resume.
  document.addEventListener("pause", () => onVisibility());
  document.addEventListener("resume", () => onVisibility());
  window.addEventListener("online", () => event("app", "online", {}));
  window.addEventListener("offline", () => event("app", "offline", {}, { lvl: "warn" }));
  window.addEventListener("pagehide", () => {
    event("app", "unload", { screen: activeScreen() || undefined, uptime_ms: Math.round(performance.now()) });
    flushNetSummary();
    void flush();
  });
}

function installPerf(): void {
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      const po = new PerformanceObserver((list) => {
        const min = isVerbose() ? 50 : 200;
        for (const entry of list.getEntries()) {
          if (entry.duration < min) continue;
          event("perf", "longtask", { start_ms: Math.round(entry.startTime), screen: activeScreen() || undefined, during_action: currentAction()?.id }, { dur: entry.duration, lvl: entry.duration >= 1_000 ? "warn" : "info" });
        }
      });
      po.observe({ type: "longtask", buffered: true });
    }
  } catch {
    /* unsupported */
  }
  // Event-loop lag: a 500 ms timer that fires late measures how long the main thread was
  // busy. This is what catches a freeze on WebKit (desktop Linux/macOS, iOS), which has no
  // long-task API. Skipped while hidden, where timers are throttled on purpose.
  let expected = performance.now() + 500;
  setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    expected = now + 500;
    if (document.visibilityState !== "visible" || !enabled()) return;
    const min = isVerbose() ? 100 : 250;
    if (lag >= min) event("perf", "loop_lag", { lag_ms: Math.round(lag), screen: activeScreen() || undefined }, { lvl: lag >= 1_000 ? "warn" : "info" });
  }, 500);
  // Memory and the logger's own cost.
  let lastSelf = performance.now();
  let lastLogMs = 0;
  let lastFlushMs = 0;
  setInterval(() => {
    if (!enabled()) return;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (mem) {
      event("perf", "memory", {
        js_heap_mb: Math.round(mem.usedJSHeapSize / 1e5) / 10,
        js_heap_total_mb: Math.round(mem.totalJSHeapSize / 1e5) / 10,
        js_heap_limit_mb: Math.round(mem.jsHeapSizeLimit / 1e6),
      });
    }
    const now = performance.now();
    if (now - lastSelf >= 300_000) {
      const s = selfStats();
      const wall = now - lastSelf;
      const spent = s.logMs - lastLogMs + (s.flushMs - lastFlushMs);
      event("diag", "self", {
        events: s.events,
        kb: Math.round(s.bytes / 102.4) / 10,
        dropped: s.dropped,
        sink_errors: s.sinkErrors,
        queued: s.queued,
        log_ms: Math.round((s.logMs - lastLogMs) * 10) / 10,
        flush_ms: Math.round((s.flushMs - lastFlushMs) * 10) / 10,
        overhead_pct: Math.round((spent / wall) * 10_000) / 100,
        window_s: Math.round(wall / 1000),
      });
      lastSelf = now;
      lastLogMs = s.logMs;
      lastFlushMs = s.flushMs;
    }
  }, 60_000);
  // Frame drops, verbose only: a rAF loop costs a little every frame, which is not worth it
  // unless somebody is actually chasing jank.
  let frames = 0;
  let slow = 0;
  let worst = 0;
  let windowStart = performance.now();
  let prev = 0;
  const tick = (ts: number) => {
    if (isVerbose() && document.visibilityState === "visible") {
      if (prev) {
        const d = ts - prev;
        frames++;
        if (d > 50) slow++;
        if (d > worst) worst = d;
      }
      prev = ts;
      if (ts - windowStart >= 10_000) {
        if (slow > 0) event("perf", "frames", { frames, over_50ms: slow, worst_ms: Math.round(worst), screen: activeScreen() || undefined });
        frames = 0;
        slow = 0;
        worst = 0;
        windowStart = ts;
      }
      requestAnimationFrame(tick);
    } else {
      prev = 0;
      setTimeout(() => requestAnimationFrame(tick), 2_000);
    }
  };
  try {
    requestAnimationFrame(tick);
  } catch {
    /* no rAF */
  }
}

// ---- engine log poller -------------------------------------------------------------

let enginePollTimer: ReturnType<typeof setTimeout> | null = null;

async function pollEngineOnce(): Promise<void> {
  const platform = diagPlatform();
  try {
    const { knownWalletTokens } = await import("../walletstate");
    setKnownSecrets(knownWalletTokens());
  } catch {
    /* tokens are also caught by shape */
  }
  if (platform === "desktop") {
    const { desktopServices } = await import("../desktop-services");
    const rows = await desktopServices.logs("wallet-engine", 400).catch(() => []);
    if (rows.length) ingestEngineText(rows.map((r) => `${r.at_unix_ms} ${r.line}`).join("\n"), "desktop");
  } else if (platform === "android") {
    const { rawEngineLogText } = await import("../embedded");
    const text = await rawEngineLogText();
    if (text) ingestEngineText(text, "android");
  }
}

function scheduleEnginePoll(): void {
  if (enginePollTimer) clearTimeout(enginePollTimer);
  const ms = isVerbose() ? 3_000 : 10_000;
  enginePollTimer = setTimeout(async () => {
    if (enabled() && document.visibilityState === "visible") await pollEngineOnce().catch(() => undefined);
    scheduleEnginePoll();
  }, ms);
}

// ---- boot markers ------------------------------------------------------------------

let firstRenderDone = false;
let interactiveDone = false;

/// The app's first frame is on screen (the splash is handing over).
export function markFirstRender(): void {
  if (firstRenderDone) return;
  firstRenderDone = true;
  const now = performance.now();
  const paints = (() => {
    try {
      return Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name.replace(/-/g, "_"), Math.round(p.startTime)]));
    } catch {
      return {};
    }
  })();
  event("app", "first_render", { since_js_ms: Math.round(now), since_process_ms: sinceProcess(now), ...paints });
}

/// The first real wallet state is on screen.
export function markInteractive(what: string): void {
  if (interactiveDone) return;
  interactiveDone = true;
  const now = performance.now();
  event("app", "interactive", { what, since_js_ms: Math.round(now), since_process_ms: sinceProcess(now) });
}

function envFields(): Record<string, unknown> {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string; type?: string; saveData?: boolean } };
  const mq = (q: string) => {
    try {
      return matchMedia(q).matches;
    } catch {
      return undefined;
    }
  };
  return {
    platform: diagPlatform(),
    app_version: APP_VERSION,
    built: APP_BUILT,
    ua: navigator.userAgent,
    lang: navigator.language,
    cores: navigator.hardwareConcurrency,
    device_memory_gb: nav.deviceMemory,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    online: navigator.onLine,
    net_type: nav.connection?.effectiveType ?? nav.connection?.type,
    save_data: nav.connection?.saveData,
    reduced_motion: mq("(prefers-reduced-motion: reduce)"),
    privacy_mode: privacyMode(),
    level: getLevel(),
  };
}

function maybeTour(): void {
  // The scripted tour (desktop, ZKAS_DIAG_TOUR=1): what a person would do on a first launch
  // — accept the default node, then tap every top-level page and every wallet tab in turn,
  // then open Diagnostics and press Export — so a headless run exercises the tap → screen →
  // requests chain and the export path end to end. It only clicks; it types nothing.
  if (!nativeConfig?.tour) return;
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const steps: (() => void)[] = [];
  const clickAll = (selector: string) => {
    const n = document.querySelectorAll(selector).length;
    for (let i = 0; i < n; i++) steps.push(() => document.querySelectorAll<HTMLElement>(selector)[i]?.click());
  };
  const plan = () => {
    clickAll(".app-page-links button");
    steps.push(() => q<HTMLElement>(".app-page-links button")?.click());
    clickAll("[role=tab]");
    steps.push(() => {
      beginAction("script", "diagnostics");
      location.hash = "#/diagnostics";
    });
    steps.push(() => q<HTMLElement>("[data-diag=diag-export]")?.click());
    steps.push(() => {
      event("diag", "tour", { phase: "round_end" });
      // Go round again while the app runs, so screens, taps and exports keep being exercised
      // through a long sync. Tour mode only.
      setTimeout(() => {
        location.hash = "#/";
        setTimeout(() => {
          plan();
          next();
        }, 3_000);
      }, 60_000);
    });
  };
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    try {
      steps[i++]();
    } catch {
      /* keep going */
    }
    setTimeout(next, 2_500);
  };
  setTimeout(() => {
    event("diag", "tour", { phase: "start" });
    const firstRun = q<HTMLElement>("[data-diag=first-run-continue]");
    if (firstRun) {
      firstRun.click();
      // The wallet mounts once the node choice settles.
      setTimeout(() => {
        plan();
        next();
      }, 12_000);
    } else {
      plan();
      next();
    }
  }, 15_000);
}

/// Install everything. Synchronous collectors first (so nothing at boot is missed), then the
/// platform sink, which needs an IPC round trip.
export function installDiagnostics(): Promise<void> {
  if (installed) return Promise.resolve();
  installed = true;
  // Each collector on its own: one that cannot install on this engine (WebKitGTK makes the
  // Tauri internals read-only, for one) must not take the others down with it — found in
  // the first real run, where a throw here silently skipped the performance collectors.
  const parts: [string, () => void][] = [
    ["errors", installErrorCapture],
    ["console", installConsoleMirror],
    ["interaction", installInteractionCapture],
    ["lifecycle", installLifecycle],
    ["fetch", installFetchWrapper],
    ["ipc", installInvokeWrapper],
    ["perf", installPerf],
    ["net_summary", startNetSummary],
  ];
  for (const [name, install] of parts) {
    try {
      install();
    } catch (e) {
      // Recorded at info: on engines where the IPC observer cannot install, the fetch
      // observer sees the same calls (Tauri's IPC travels over fetch).
      event("diag", "collector_unavailable", { collector: name, err: (e as Error)?.name, msg: (e as Error)?.message }, { lvl: name === "ipc" ? "info" : "error" });
    }
  }
  const navEntry = (() => {
    try {
      const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      // Zero means "has not happened yet" (boot runs before load), not "took no time".
      const pos = (v: number) => (v > 0 ? Math.round(v) : undefined);
      return n
        ? { dom_interactive_ms: pos(n.domInteractive), dcl_ms: pos(n.domContentLoadedEventEnd), load_ms: pos(n.loadEventEnd), nav_type: n.type }
        : {};
    } catch {
      return {};
    }
  })();
  return connectSink(ingestNativeLine)
    .then((cfg) => {
      nativeConfig = cfg;
      if (cfg.procUptimeMs > 0 && diagPlatform() !== "web") procOffsetMs = cfg.procUptimeMs - performance.now();
    })
    .catch((e) => {
      logError("diag", "sink_failed", e);
    })
    .finally(() => {
      const cfg = nativeConfig;
      event("app", "boot", {
        sid: sessionId,
        start_kind: cfg?.startKind,
        js_start_ms: Math.round(jsInstallAt),
        native_before_js_ms: procOffsetMs === null ? undefined : Math.round(procOffsetMs),
        aid_window_ms: ACTION_WINDOW_MS,
        ...navEntry,
      });
      event("app", "env", { ...envFields(), ...(cfg?.env ?? {}) });
      if (cfg?.prevUnclean) event("app", "prev_unclean", {}, { lvl: "warn" });
      scheduleEnginePoll();
      maybeTour();
    });
}

/// Poll the engine log now (the Diagnostics screen's refresh).
export function pollEngineNow(): Promise<void> {
  return pollEngineOnce();
}
