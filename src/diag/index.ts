// The diagnostic log's public face. App code imports from here.
//
//   diag.event / diag.error / diag.span   record (redacted, level-aware, never blocking)
//   useScreenLog                          tap → screen timing
//   observeStatus / observePollFailure    sync story
//   exportLogs / clearLogs                the only ways a log leaves or is removed

import { exportFile } from "../exportfile";
import { clearRing, error, event, flush, getLevel, recent, selfStats, sessionId, setLevel, span, type DiagLevel } from "./log";
import { nativeDiagConfig } from "./instrument";
import { clearNative, diagPlatform, exportNative, nativeStats, revealExport, type ExportResult } from "./sink";
import { summarize } from "./summary";
import { APP_BUILT, APP_VERSION } from "../version";

export { event, error, span, getLevel, setLevel, recent, selfStats, type DiagLevel };
export { useScreenLog, screenChanged } from "./screens";
export { observeStatus, observePollFailure } from "./sync";
export { recordRequest, claimSignal } from "./net";
export { installDiagnostics, markFirstRender, markInteractive, pollEngineNow } from "./instrument";
export { summarize } from "./summary";
export { subscribe } from "./log";

/// The first lines of an export: what produced it, and the summary — so the file is
/// readable on its own, before anyone greps it.
export function exportHeader(): string {
  const cfg = nativeDiagConfig();
  return JSON.stringify({
    zkas_diagnostics: 1,
    exported: new Date().toISOString(),
    app_version: APP_VERSION,
    built: APP_BUILT,
    platform: diagPlatform(),
    session: sessionId,
    level: getLevel(),
    env: cfg?.env,
    summary: summarize(recent()),
    note: "Local diagnostic log. Addresses, txids, tokens and keys are salted pseudonyms; amounts are magnitude buckets; seeds, phrases, PINs, memos and viewing keys are never recorded.",
  });
}

export async function exportLogs(): Promise<ExportResult> {
  event("diag", "export", { platform: diagPlatform() });
  await flush();
  const header = exportHeader();
  const native = await exportNative(header);
  if (native) {
    if (native.path) void revealExport(native.path.replace(/[\\/][^\\/]+$/, ""));
    return native;
  }
  // Web: the ring IS the log.
  const body = [header, ...recent().map((e) => JSON.stringify(e))].join("\n") + "\n";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outcome = await exportFile(`zkas-diagnostics-${stamp}.jsonl`, "application/x-ndjson", body);
  return { outcome };
}

export async function clearLogs(): Promise<void> {
  clearRing();
  await clearNative().catch(() => undefined);
  event("diag", "cleared", {});
}

export async function storedStats() {
  return nativeStats();
}
