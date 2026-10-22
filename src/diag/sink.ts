// Where the diagnostic log is kept, per platform.
//
//   desktop (Tauri)   the shell's rotating writer: <app data>/logs/diag/diag.N.jsonl
//   Android           the Diagnostics plugin's rotating writer: <files>/diag/diag.N.jsonl
//   web               nowhere: the in-memory ring is the whole log, gone on reload
//
// Both native writers bound the files at 10 x 2 MB and never send them anywhere. The only
// way a log leaves the device is the Export / Copy button on the Diagnostics screen.

import { registerPlugin } from "@capacitor/core";
import { installSink, setLevel, type DiagLevel, type DiagSink } from "./log";
import { setSalt } from "./redact";

export interface NativeDiagConfig {
  salt: string;
  level: DiagLevel;
  /// Milliseconds since the PROCESS started, read at the moment of the call. Lets the
  /// boot event say how long the native side took before any JavaScript ran.
  procUptimeMs: number;
  /// Android: "cold" when this is the first activity of the process, "warm" when the
  /// activity was recreated inside a living process.
  startKind?: string;
  /// Device/OS facts the WebView cannot see. Safe by construction (no identifiers).
  env?: Record<string, unknown>;
  dir?: string;
  /// Desktop only: the previous session never reached a clean exit.
  prevUnclean?: boolean;
  /// Desktop only: run the scripted diagnostics tour (ZKAS_DIAG_TOUR=1).
  tour?: boolean;
}

export interface ExportResult {
  outcome: "saved" | "shared" | "copied" | "downloaded";
  path?: string;
}

interface DiagnosticsPlugin {
  config(): Promise<NativeDiagConfig>;
  append(opts: { lines: string[] }): Promise<void>;
  setLevel(opts: { level: DiagLevel }): Promise<void>;
  export(opts: { header: string }): Promise<{ outcome: string }>;
  clear(): Promise<void>;
  stats(): Promise<{ files: number; bytes: number }>;
  addListener(name: "line", fn: (e: { line: string }) => void): Promise<{ remove: () => void }>;
}

export type Platform = "desktop" | "android" | "ios" | "web";

export function diagPlatform(): Platform {
  if ("__TAURI_INTERNALS__" in globalThis) return "desktop";
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
  if (cap?.isNativePlatform?.()) {
    const p = cap.getPlatform?.();
    if (p === "android") return "android";
    if (p === "ios") return "ios";
  }
  return "web";
}

let androidPlugin: DiagnosticsPlugin | null = null;
function android(): DiagnosticsPlugin {
  androidPlugin ??= registerPlugin<DiagnosticsPlugin>("Diagnostics");
  return androidPlugin;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function webSalt(): string {
  try {
    const have = localStorage.getItem("diag_salt");
    if (have && /^[0-9a-f]{32}$/.test(have)) return have;
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    const fresh = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("diag_salt", fresh);
    return fresh;
  } catch {
    // No storage: a per-load salt. Pseudonyms then only correlate within this page load,
    // which is all a ring that dies with the page can offer anyway.
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}

/// Lines a native layer recorded itself, forwarded so the live tail can show them.
type NativeLineHandler = (line: string) => void;

/// Connect the logger to this platform's store. Resolves with the native config (or a
/// web stand-in) so boot can report what the native side knows.
export async function connectSink(onNativeLine: NativeLineHandler): Promise<NativeDiagConfig> {
  const platform = diagPlatform();
  if (platform === "desktop") {
    const cfg = await tauriInvoke<NativeDiagConfig>("diag_config");
    setSalt(cfg.salt);
    setLevel(cfg.level, true);
    const sink: DiagSink = {
      append: (lines) => tauriInvoke<void>("diag_append", { lines }),
      setLevel: (level) => tauriInvoke<void>("diag_set_level", { level }),
    };
    installSink(sink);
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<string>("diag-line", (e) => onNativeLine(e.payload));
    } catch {
      /* the tail just will not show shell events live; they are still in the file */
    }
    return cfg;
  }
  if (platform === "android") {
    const p = android();
    const cfg = await p.config();
    setSalt(cfg.salt);
    setLevel(cfg.level, true);
    installSink({
      append: (lines) => p.append({ lines }),
      setLevel: (level) => p.setLevel({ level }),
    });
    try {
      await p.addListener("line", (e) => onNativeLine(e.line));
    } catch {
      /* as above */
    }
    return cfg;
  }
  setSalt(webSalt());
  installSink(null);
  return { salt: "", level: "normal", procUptimeMs: Math.round(performance.now()) };
}

/// Save or share every stored log file (plus `header`, the summary and environment).
export async function exportNative(header: string): Promise<ExportResult | null> {
  const platform = diagPlatform();
  if (platform === "desktop") {
    const r = await tauriInvoke<{ path: string }>("diag_export", { header });
    return { outcome: "saved", path: r.path };
  }
  if (platform === "android") {
    const r = await android().export({ header });
    return { outcome: r.outcome === "copied" ? "copied" : "shared" };
  }
  return null;
}

export async function clearNative(): Promise<void> {
  const platform = diagPlatform();
  if (platform === "desktop") await tauriInvoke<void>("diag_clear");
  else if (platform === "android") await android().clear();
}

export async function nativeStats(): Promise<{ files: number; bytes: number } | null> {
  const platform = diagPlatform();
  try {
    if (platform === "desktop") return await tauriInvoke<{ files: number; bytes: number }>("diag_stats");
    if (platform === "android") return await android().stats();
  } catch {
    /* unknown */
  }
  return null;
}

/// Open the folder holding an exported file (desktop).
export async function revealExport(path: string): Promise<void> {
  if (diagPlatform() !== "desktop") return;
  await tauriInvoke<void>("reveal_path", { path }).catch(() => undefined);
}
