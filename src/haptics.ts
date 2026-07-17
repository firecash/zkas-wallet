// Haptic feedback for the native app: every tap answers with a soft tick, a
// completed send with a success pattern. Web is untouched (no-ops) — this is
// purely the "the app feels alive under your finger" layer for Android/iOS.
//
// @capacitor/haptics is loaded lazily so the web bundle never pays for it, with
// a navigator.vibrate fallback for WebViews where the plugin is unavailable.

import { isNative } from "./api";

type HapticsModule = typeof import("@capacitor/haptics");
let mod: Promise<HapticsModule> | null = null;
function load(): Promise<HapticsModule> {
  if (!mod) mod = import("@capacitor/haptics");
  return mod;
}

/** Soft tick for any tap on a control (buttons, tabs, links, list rows). */
export function tapFeedback() {
  if (!isNative()) return;
  load()
    .then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }))
    .catch(() => navigator.vibrate?.(8));
}

/** Distinct success pattern for the moment a payment is broadcast. */
export function successFeedback() {
  if (!isNative()) return;
  load()
    .then(({ Haptics, NotificationType }) => Haptics.notification({ type: NotificationType.Success }))
    .catch(() => navigator.vibrate?.([25, 40, 25]));
}

/** Attach the global tap listener (capture phase, so it fires for every control
 * before React handlers). Call once at app mount; returns the cleanup. */
export function attachTapHaptics(): () => void {
  if (!isNative()) return () => {};
  const onTap = (e: Event) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest?.("button, a, input[type='checkbox'], .txrow")) tapFeedback();
  };
  document.addEventListener("click", onTap, true);
  return () => document.removeEventListener("click", onTap, true);
}
