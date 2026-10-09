import { useEffect, useRef } from "react";

/// Android's hardware back button, and Escape, close the TOPMOST overlay.
///
/// Listeners fire in registration order — the OUTER one first — so open overlays
/// are kept on a stack and only the one on top answers. Lives in its own module
/// rather than in App.tsx so overlays defined in other files (Chat, and anything
/// after it) can claim the back press without importing App and creating a cycle.
const backStack: Array<() => void> = [];

export function useBackClose(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const entry = () => closeRef.current();
    backStack.push(entry);
    const onBack = (event: Event) => {
      if (backStack[backStack.length - 1] !== entry) return;
      event.preventDefault();
      entry();
    };
    // Escape, which this hook's own docstring has always promised and never
    // delivered: the only listener was for `zkas:back`, and that event is
    // dispatched from exactly one place — inside main.tsx's
    // `Capacitor.isNativePlatform()` branch. So on web and on desktop the whole
    // mechanism was inert for all fifteen overlays that use it: Send, Receive,
    // the connection modal, the wallet switcher, every confirm dialog, the
    // transaction detail, the QR scanner, the chat sheets. Caught by driving the
    // app — pressing Escape on the Receive sheet left it open, and the next tap
    // landed on the sheet instead of the Send button underneath it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (backStack[backStack.length - 1] !== entry) return;
      event.preventDefault();
      entry();
    };
    window.addEventListener("zkas:back", onBack);
    window.addEventListener("keydown", onKey);
    return () => {
      const at = backStack.indexOf(entry);
      if (at >= 0) backStack.splice(at, 1);
      window.removeEventListener("zkas:back", onBack);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
}
