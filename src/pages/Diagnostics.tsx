import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  clearLogs,
  exportLogs,
  getLevel,
  pollEngineNow,
  recent,
  selfStats,
  setLevel,
  storedStats,
  subscribe,
  summarize,
  type DiagLevel,
} from "../diag";
import type { DiagEvent } from "../diag/log";

const ENVELOPE = new Set(["t", "m", "src", "sid", "seq", "lvl", "cat", "ev", "dur", "aid"]);

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function fields(e: DiagEvent): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!ENVELOPE.has(k) && v !== undefined && k !== "stack") rest[k] = v;
  const s = JSON.stringify(rest);
  return s === "{}" ? "" : s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

/// Settings → Diagnostics. Everything shown here comes from the on-device log, which is
/// already redacted; the only ways out are the Export and Copy buttons below.
export function Diagnostics() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [level, setLevelState] = useState<DiagLevel>(getLevel());
  const [, setTick] = useState(0);
  const [cat, setCat] = useState("all");
  const [sev, setSev] = useState("all");
  const [text, setText] = useState("");
  const [paused, setPaused] = useState(false);
  const [note, setNote] = useState("");
  const [armClear, setArmClear] = useState(false);
  const [stored, setStored] = useState<{ files: number; bytes: number } | null>(null);

  useEffect(() => {
    // Re-render at most twice a second however busy the log is.
    let pending = false;
    const off = subscribe(() => {
      if (pending || paused) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        setTick((n) => n + 1);
      }, 500);
    });
    return () => {
      off();
    };
  }, [paused]);
  useEffect(() => {
    void storedStats().then(setStored);
    void pollEngineNow().catch(() => undefined);
  }, []);

  const ring = recent();
  const summary = useMemo(() => summarize(ring), [ring.length, ring[ring.length - 1]?.seq]);
  const cats = useMemo(() => [...new Set(ring.map((e) => e.cat))].sort(), [ring.length]);
  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const out: DiagEvent[] = [];
    for (let i = ring.length - 1; i >= 0 && out.length < 300; i--) {
      const e = ring[i];
      if (cat !== "all" && e.cat !== cat) continue;
      if (sev === "warn" && e.lvl !== "warn" && e.lvl !== "error") continue;
      if (sev === "error" && e.lvl !== "error") continue;
      if (needle && !`${e.cat}.${e.ev} ${fields(e)}`.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  }, [ring.length, ring[ring.length - 1]?.seq, cat, sev, text]);

  const changeLevel = (next: DiagLevel) => {
    setLevel(next);
    setLevelState(next);
  };
  const doExport = async () => {
    setNote("");
    try {
      const r = await exportLogs();
      const how = r.outcome === "shared" ? t("diagnostics.exportShared") : r.outcome === "copied" ? t("diagnostics.exportCopied") : t("diagnostics.exportDownloaded");
      setNote(r.path ? t("diagnostics.savedTo", { path: r.path }) : how);
    } catch (e) {
      setNote(t("diagnostics.exportFailed", { detail: (e as Error)?.message ?? "" }));
    }
  };
  const doCopy = async () => {
    const body = shown.slice().reverse().map((e) => JSON.stringify(e)).join("\n");
    try {
      await navigator.clipboard.writeText(body);
      setNote(t("diagnostics.copied", { n: shown.length }));
    } catch {
      setNote(t("diagnostics.copyFailed"));
    }
  };
  const doClear = async () => {
    if (!armClear) {
      setArmClear(true);
      setTimeout(() => setArmClear(false), 4_000);
      return;
    }
    setArmClear(false);
    await clearLogs();
    setStored(await storedStats());
    setNote(t("diagnostics.cleared"));
  };
  const self = selfStats();

  return (
    <main className="control-page diagnostics-page" data-diag-scope="diagnostics">
      <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button className="btn ghost small" data-diag="diag-back" onClick={() => navigate(-1)}>{t("diagnostics.back")}</button>
        <h2 style={{ margin: 0 }}>{t("diagnostics.title")}</h2>
      </div>
      <p className="muted small">{t("diagnostics.intro")}</p>

      <section className="card stack">
        <label className="row" style={{ gap: 10, alignItems: "center" }}>
          <b>{t("diagnostics.levelLabel")}</b>
          <select data-diag="diag-level" value={level} onChange={(e) => changeLevel(e.target.value as DiagLevel)}>
            <option value="off">{t("diagnostics.levelOff")}</option>
            <option value="normal">{t("diagnostics.levelNormal")}</option>
            <option value="verbose">{t("diagnostics.levelVerbose")}</option>
          </select>
        </label>
        <p className="muted small" style={{ margin: 0 }}>{level === "off" ? t("diagnostics.hintOff") : level === "verbose" ? t("diagnostics.hintVerbose") : t("diagnostics.hintNormal")}</p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn small" data-diag="diag-export" onClick={() => void doExport()}>{t("diagnostics.export")}</button>
          <button className="btn ghost small" data-diag="diag-copy" onClick={() => void doCopy()}>{t("diagnostics.copyShown")}</button>
          <button className="btn ghost small" data-diag="diag-clear" onClick={() => void doClear()}>{armClear ? t("diagnostics.clearConfirm") : t("diagnostics.clear")}</button>
        </div>
        {note && <p className="small" role="status" style={{ margin: 0, wordBreak: "break-all" }}>{note}</p>}
        <p className="muted small mono" style={{ margin: 0 }}>
          {t("diagnostics.storage", {
            events: self.events,
            files: stored?.files ?? 0,
            kb: stored ? Math.round(stored.bytes / 1024) : 0,
            ms: Math.round((self.logMs + self.flushMs) * 10) / 10,
          })}
        </p>
      </section>

      <section className="card stack">
        <h3 style={{ margin: 0 }}>{t("diagnostics.summary")}</h3>
        <table className="mono small" style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <Row k={t("diagnostics.syncState")} v={summary.sync.state ?? "—"} />
            <Row k={t("diagnostics.syncSpeed")} v={summary.sync.bps !== undefined ? t("diagnostics.bps", { now: summary.sync.bps, avg: summary.sync.avgBps ?? "—" }) : "—"} />
            <Row k={t("diagnostics.behind")} v={summary.sync.behind !== undefined ? String(summary.sync.behind) : "—"} />
            <Row k={t("diagnostics.timeToSynced")} v={fmtMs(summary.sync.timeToSyncedMs)} />
            <Row k={t("diagnostics.decrypt")} v={summary.sync.usPerAction !== undefined ? `${summary.sync.usPerAction} µs/action · ${summary.sync.usPerLeaf ?? "—"} µs/leaf` : "—"} />
            <Row k={t("diagnostics.pages")} v={summary.sync.fetchMsPerPage !== undefined ? t("diagnostics.pagesValue", { fetch: summary.sync.fetchMsPerPage, ingest: summary.sync.ingestMsPerPage ?? "—", pct: summary.sync.fetchPct ?? "—" }) : "—"} />
            <Row k={t("diagnostics.sends")} v={summary.sends.n ? t("diagnostics.sendsValue", { n: summary.sends.n, total: fmtMs(summary.sends.lastTotalMs), prove: fmtMs(summary.sends.lastProveMs), sign: fmtMs(summary.sends.lastSignMs) }) : "—"} />
            <Row k={t("diagnostics.errors")} v={t("diagnostics.errorsValue", { errors: summary.errors, warnings: summary.warnings })} />
            <Row k={t("diagnostics.freezes")} v={t("diagnostics.freezesValue", { longtasks: summary.longTasks, lag: fmtMs(summary.worstLagMs) })} />
          </tbody>
        </table>
        {summary.screens.length > 0 && (
          <>
            <h4 style={{ margin: "8px 0 0" }}>{t("diagnostics.slowestScreens")}</h4>
            <table className="mono small" style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {summary.screens.map((s) => <Row key={s.screen} k={s.screen} v={`p50 ${s.p50} ms · p95 ${s.p95} ms · max ${s.max} ms · n=${s.n}`} />)}
              </tbody>
            </table>
          </>
        )}
        {summary.endpoints.length > 0 && (
          <>
            <h4 style={{ margin: "8px 0 0" }}>{t("diagnostics.slowestRequests")}</h4>
            <table className="mono small" style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {summary.endpoints.map((s) => <Row key={s.key} k={s.key} v={`p50 ${s.p50} ms · p95 ${s.p95} ms · n=${s.n}${s.errors ? ` · ${s.errors} err` : ""}`} />)}
              </tbody>
            </table>
          </>
        )}
        {summary.lastErrors.length > 0 && (
          <>
            <h4 style={{ margin: "8px 0 0" }}>{t("diagnostics.lastErrors")}</h4>
            <ul className="mono small" style={{ margin: 0, paddingLeft: 18 }}>
              {summary.lastErrors.map((e, i) => <li key={i} style={{ wordBreak: "break-all" }}>{e.t.slice(11, 19)} {e.cat}.{e.ev} {e.msg ?? ""}</li>)}
            </ul>
          </>
        )}
      </section>

      <section className="card stack">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <h3 style={{ margin: 0, flex: "1 1 auto" }}>{t("diagnostics.live")}</h3>
          <select data-diag="diag-filter-cat" value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("diagnostics.filterCategory")}>
            <option value="all">{t("diagnostics.allCategories")}</option>
            {cats.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select data-diag="diag-filter-level" value={sev} onChange={(e) => setSev(e.target.value)} aria-label={t("diagnostics.filterLevel")}>
            <option value="all">{t("diagnostics.allLevels")}</option>
            <option value="warn">{t("diagnostics.warnUp")}</option>
            <option value="error">{t("diagnostics.errorsOnly")}</option>
          </select>
          <input data-diag="diag-filter-text" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("diagnostics.search")} style={{ minWidth: 0, flex: "1 1 120px" }} />
          <button className="btn ghost small" data-diag="diag-pause" onClick={() => setPaused((p) => !p)}>{paused ? t("diagnostics.resume") : t("diagnostics.pause")}</button>
        </div>
        <div className="mono small diag-tail" style={{ maxHeight: 480, overflow: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
          {shown.length === 0 && <div className="muted">{level === "off" ? t("diagnostics.offNote") : t("diagnostics.empty")}</div>}
          {shown.map((e) => (
            <div key={`${e.src}-${e.sid}-${e.seq}`} style={{ padding: "2px 0", borderBottom: "1px solid var(--border)", wordBreak: "break-all", color: e.lvl === "error" ? "var(--bad, #ff6b6b)" : e.lvl === "warn" ? "var(--warn, #f5b74e)" : undefined }}>
              <span className="muted">{e.t.slice(11, 23)}</span> <b>{e.cat}.{e.ev}</b>
              {e.dur !== undefined && <span> {fmtMs(e.dur)}</span>}
              {e.aid && <span className="muted"> [{e.aid}]</span>} <span className="muted">{fields(e)}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="muted" style={{ padding: "2px 10px 2px 0", verticalAlign: "top", whiteSpace: "nowrap" }}>{k}</td>
      <td style={{ padding: "2px 0", wordBreak: "break-all" }}>{v}</td>
    </tr>
  );
}
