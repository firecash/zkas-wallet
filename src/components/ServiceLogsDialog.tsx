import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { desktopServices, type ServiceLog } from "../desktop-services";
import { ServiceLogs } from "./ServiceLogs";

type Props = {
  open: boolean;
  onClose: () => void;
  service: string;
  title: string;
};

const MAX_VISIBLE_LOGS = 2_000;

function logKey(line: ServiceLog): string {
  return `${line.at_unix_ms}\u0000${line.service}\u0000${line.stream}\u0000${line.line}`;
}

function mergeLogs(current: ServiceLog[], incoming: ServiceLog[]): ServiceLog[] {
  const merged = new Map<string, ServiceLog>();
  for (const line of current) merged.set(logKey(line), line);
  for (const line of incoming) merged.set(logKey(line), line);
  return [...merged.values()]
    .sort((left, right) => left.at_unix_ms - right.at_unix_ms)
    .slice(-MAX_VISIBLE_LOGS);
}

/**
 * A diagnostics surface independent from the page layout. Tauri events give it
 * low-latency updates; the one-second snapshot is intentional redundancy for
 * startup/restart lines emitted before the listener existed or missed while a
 * webview was suspended.
 */
export function ServiceLogsDialog({ open, onClose, service, title }: Props) {
  const [logs, setLogs] = useState<ServiceLog[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const hiddenBefore = useRef(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    let polling = false;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    hiddenBefore.current = 0;
    setLogs([]);
    setPollError(null);
    setLastUpdated(null);

    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const snapshot = await desktopServices.logs(service, MAX_VISIBLE_LOGS);
        if (!alive) return;
        const visible = snapshot.filter((line) => line.at_unix_ms >= hiddenBefore.current);
        setLogs((current) => mergeLogs(current, visible));
        setLastUpdated(Date.now());
        setPollError(null);
      } catch (error) {
        if (alive) setPollError(error instanceof Error ? error.message : String(error));
      } finally {
        polling = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<ServiceLog>("service-log", ({ payload }) => {
        if (!alive || payload.service !== service || payload.at_unix_ms < hiddenBefore.current) return;
        setLogs((current) => mergeLogs(current, [payload]));
        setLastUpdated(Date.now());
      });
      if (alive) unlisten = stop;
      else stop();
    })().catch((error) => {
      if (alive) setPollError(error instanceof Error ? error.message : String(error));
    });

    return () => {
      alive = false;
      clearInterval(timer);
      unlisten?.();
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, open, service]);

  if (!open) return null;

  const clearView = () => {
    hiddenBefore.current = Date.now();
    setLogs([]);
  };

  return createPortal(
    <div className="service-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="service-dialog service-logs-dialog" role="dialog" aria-modal="true" aria-label={`${title} diagnostics`}>
        <header className="service-dialog-header">
          <div>
            <span className="eyebrow">Diagnostics</span>
            <h2>{title}</h2>
          </div>
          <div className="service-dialog-header-actions">
            <span className={`log-live-state ${pollError ? "retrying" : ""}`}>
              <i />{pollError ? "Reconnecting" : lastUpdated ? "Live" : "Opening"}
            </span>
            <button className="dialog-close" aria-label="Close logs" title="Close" autoFocus onClick={onClose}><X size={19} /></button>
          </div>
        </header>
        {pollError && <div className="dialog-inline-error">Live events were interrupted. Snapshot polling will keep retrying: {pollError}</div>}
        <ServiceLogs logs={logs} onClear={clearView} preferredService={service} />
      </section>
    </div>,
    document.body,
  );
}
