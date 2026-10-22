// Lines the native layers (Rust shell, Android) recorded themselves and forwarded for the
// live tail. They are already in the file; here they only join the in-memory ring so the
// Diagnostics screen shows one stream. They are re-checked by the redactor on the way in —
// a native writer is held to the same rules as everything else.

import { ingestForeign, type DiagEvent } from "./log";
import { redactFields } from "./redact";

export function ingestNativeLine(line: string): void {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.cat !== "string" || typeof parsed.ev !== "string") return;
    const { t, m, src, sid, seq, lvl, cat, ev, dur, ...rest } = parsed;
    const e: DiagEvent = {
      t: String(t ?? new Date().toISOString()),
      m: Number(m ?? 0),
      src: "js",
      sid: String(sid ?? ""),
      seq: Number(seq ?? 0),
      lvl: (["debug", "info", "warn", "error"].includes(String(lvl)) ? lvl : "info") as DiagEvent["lvl"],
      cat,
      ev,
      ...(dur !== undefined ? { dur: Number(dur) } : {}),
      ...redactFields(rest),
    };
    (e as Record<string, unknown>).src = String(src ?? "native");
    ingestForeign(e);
  } catch {
    /* not a line we understand */
  }
}
