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
    window.addEventListener("zkas:back", onBack);
    return () => {
      const at = backStack.indexOf(entry);
      if (at >= 0) backStack.splice(at, 1);
      window.removeEventListener("zkas:back", onBack);
    };
  }, [open]);
}
