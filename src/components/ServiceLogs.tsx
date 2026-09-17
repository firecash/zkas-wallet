import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clipboard, Download, Pause, Play, Search, WrapText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ServiceLog } from "../desktop-services";

type Props = {
  logs: ServiceLog[];
  onClear: () => void;
  preferredService?: string;
};

function severity(line: ServiceLog): "error" | "warn" | "info" {
  const text = line.line.toLowerCase();
  if (/(error|fatal|panic|reject|failed|failure)/.test(text)) return "error";
  if (line.stream === "stderr" || /(warn|retry|timeout|stale|disconnect)/.test(text)) return "warn";
  return "info";
}

function output(lines: ServiceLog[]): string {
  return lines.map((line) => `${new Date(line.at_unix_ms).toISOString()} [${line.service}] [${line.stream}] ${line.line}`).join("\n");
}

export function ServiceLogs({ logs, onClear, preferredService }: Props) {
  const { t } = useTranslation();
  const services = useMemo(() => Array.from(new Set(logs.map((line) => line.service))).sort(), [logs]);
  const [service, setService] = useState(preferredService ?? "all");
  const [query, setQuery] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (service !== "all" && !services.includes(service)) setService("all");
  }, [service, services]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((line) => {
      if (service !== "all" && line.service !== service) return false;
      if (issuesOnly && severity(line) === "info") return false;
      return !needle || line.line.toLowerCase().includes(needle) || line.service.toLowerCase().includes(needle);
    });
  }, [issuesOnly, logs, query, service]);

  useEffect(() => {
    if (!follow || !viewport.current) return;
    viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [follow, visible]);

  const copy = async () => {
    await navigator.clipboard.writeText(output(visible));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  const download = () => {
    const blob = new Blob([output(visible)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `zkas-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="service-console">
      <div className="service-console-tools">
        <label className="service-log-search"><Search size={14} /><input aria-label={t("serviceLogs.searchAria")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("serviceLogs.findPlaceholder")} /></label>
        <select aria-label={t("serviceLogs.serviceAria")} value={service} onChange={(event) => setService(event.target.value)}>
          <option value="all">{t("serviceLogs.allServices")}</option>
          {services.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button className={issuesOnly ? "active" : ""} onClick={() => setIssuesOnly((value) => !value)}>{t("serviceLogs.issues")}</button>
        <button className={follow ? "active" : ""} title={follow ? t("serviceLogs.pauseFollow") : t("serviceLogs.followNewest")} onClick={() => setFollow((value) => !value)}>{follow ? <Pause size={14} /> : <Play size={14} />}<span>{t("serviceLogs.follow")}</span></button>
        <button className={wrap ? "active" : ""} title={t("serviceLogs.wrapTitle")} onClick={() => setWrap((value) => !value)}><WrapText size={14} /><span>{t("serviceLogs.wrap")}</span></button>
        <button disabled={!visible.length} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Clipboard size={14} />}<span>{copied ? t("serviceLogs.copied") : t("serviceLogs.copy")}</span></button>
        <button disabled={!visible.length} onClick={download}><Download size={14} /><span>{t("serviceLogs.save")}</span></button>
        <button onClick={onClear}>{t("serviceLogs.clearView")}</button>
      </div>
      <div className={`log-view service-log-view ${wrap ? "wrap" : "nowrap"}`} ref={viewport} onScroll={(event) => {
        const element = event.currentTarget;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 20;
        if (!atBottom && follow) setFollow(false);
      }}>
        {visible.length === 0 ? <div className="service-log-empty">{t("serviceLogs.noMatching")}</div> : visible.map((line, index) => {
          const level = severity(line);
          return <div key={`${line.at_unix_ms}-${index}`} className={`service-log-line ${level}`}>
            <time>{new Date(line.at_unix_ms).toLocaleTimeString()}</time>
            <b>{line.service}</b>
            <span>{line.line}</span>
          </div>;
        })}
      </div>
      <div className="service-console-foot"><span>{t("serviceLogs.lines", { n: visible.length.toLocaleString() })}</span><span>{follow ? t("serviceLogs.followingNewest") : t("serviceLogs.paused")}</span></div>
    </div>
  );
}
