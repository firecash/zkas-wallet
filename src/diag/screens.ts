// "How long from the tap to the screen?" — measured, per screen, every time.
//
// `useScreenLog(name)` is called by whatever owns a screen (the router shell for routes, the
// wallet for its tabs). When the name changes it records `nav.screen` with:
//   since_tap  ms from the pointer-down that started the current action to React's commit
//              of the new screen (absent when no recent interaction caused it: a deep link,
//              a redirect, the app opening)
//   paint      ms from that commit to the second animation frame after it — the frame the
//              user actually sees
//   prev       the screen it replaced
// Two frames rather than one: the first rAF callback runs BEFORE the paint of that frame.

import { useEffect, useRef } from "react";
import { currentAction, event } from "./log";

let currentScreen = "";
let screenSince = 0;

export function activeScreen(): string {
  return currentScreen;
}

export function screenChanged(name: string, extra: Record<string, unknown> = {}): void {
  if (!name || name === currentScreen) return;
  const committed = performance.now();
  const a = currentAction();
  const prev = currentScreen || undefined;
  const prevMs = currentScreen ? Math.round(committed - screenSince) : undefined;
  currentScreen = name;
  screenSince = committed;
  const sinceTap = a ? committed - a.at : undefined;
  let done = false;
  const emit = (paint?: number) => {
    if (done) return;
    done = true;
    event(
      "nav",
      "screen",
      {
        screen: name,
        prev,
        prev_ms: prevMs,
        since_tap: sinceTap === undefined ? undefined : Math.round(sinceTap),
        paint: paint === undefined ? undefined : Math.round(paint * 10) / 10,
        tap_to_paint: sinceTap === undefined || paint === undefined ? undefined : Math.round(sinceTap + paint),
        cause: a ? a.kind : "none",
        ...(a ? { aid: a.id } : {}),
        ...extra,
      },
      { lvl: sinceTap !== undefined && sinceTap + (paint ?? 0) > 1_000 ? "warn" : "info" },
    );
  };
  try {
    requestAnimationFrame(() => requestAnimationFrame(() => emit(performance.now() - committed)));
  } catch {
    emit();
  }
  // A hidden page does not run animation frames; say what is known rather than nothing.
  setTimeout(() => emit(), 1_500);
}

/// Record a screen change whenever `name` changes. Runs after commit (useEffect).
export function useScreenLog(name: string | null | undefined, extra?: Record<string, unknown>): void {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!name || name === last.current) return;
    last.current = name;
    screenChanged(name, extra);
    // `extra` is descriptive; a new object each render must not re-fire the event.
  }, [name]);
}

/// For tests.
export function resetScreensForTests(): void {
  currentScreen = "";
  screenSince = 0;
}
