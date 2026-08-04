// Toasts: the app's voice for things that happen without the user asking.
//
// Before this, money arriving was a silent number change — the balance simply
// differed if you happened to be looking. A payment landing is the single most
// important event a wallet has; it deserves to be announced, and on a chain
// where the explorer can tell the user nothing about their own funds, the wallet
// is the only thing that can announce it.
//
// Deliberately tiny: no dependency, no portal gymnastics beyond one fixed layer,
// and every toast is dismissible and self-expiring.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ToastKind = "info" | "good" | "bad";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

interface ToastApi {
  show: (kind: ToastKind, title: string, body?: string) => void;
}

const Ctx = createContext<ToastApi>({ show: () => {} });

/** Raise a toast from anywhere inside the app. */
export function useToast(): ToastApi {
  return useContext(Ctx);
}

const LIFETIME_MS = 6000;

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, title, body }]); // at most 3 on screen
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), LIFETIME_MS);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <div className="toast-title">{t.title}</div>
              {t.body && <div className="toast-body">{t.body}</div>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

/**
 * Ask for OS notification permission once, lazily — only when the wallet has
 * something worth announcing. Never blocks or throws; a denied permission just
 * means the in-app toast is the whole story.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Fire an OS notification if allowed. Silent no-op otherwise. */
export function notifyOs(title: string, body: string): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      // BASE_URL, not "/…": the app is built with base "./" and the native shells
      // serve it from capacitor:// / tauri:// roots where an absolute path 404s.
      new Notification(title, { body, icon: `${import.meta.env.BASE_URL}icon-192.png` });
    }
  } catch {
    /* notifications are a nicety, never a failure path */
  }
}
