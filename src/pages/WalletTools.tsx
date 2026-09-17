import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, type Status } from "../api";

type ToolTab = "batch" | "maintenance";

function cleanAmount(value: string): string {
  const stripped = value.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = stripped.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 8)}` : whole;
}

function parseSompi(value: string): bigint | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!match) return null;
  const result = BigInt(match[1]) * 100_000_000n + BigInt((match[2] || "").padEnd(8, "0"));
  return result > 0n ? result : null;
}

function formatSompi(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function BatchSend({ status, onRefresh }: { status: Status | null; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState("");
  const [fee, setFee] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const parsed = useMemo(() => rows.split(/\r?\n/).map((line, index) => {
    const [to = "", rawAmount = "", ...memo] = line.split(",");
    const amount_sompi = parseSompi(rawAmount);
    return { line: index + 1, to: to.trim(), amount_sompi, memo: memo.join(",").trim() || undefined };
  }).filter((row) => row.to || row.amount_sompi != null), [rows]);
  const invalid = parsed.find((row) => !/^(zkas|firecash):[a-z0-9]{50,100}$/i.test(row.to) || row.amount_sompi == null);
  const feeSompi = fee ? parseSompi(fee) : undefined;
  const total = parsed.reduce((sum, row) => sum + (row.amount_sompi ?? 0n), 0n);
  const send = async () => {
    setBusy(true);
    setError("");
    setResult("");
    try {
      const response = await api.sendMany(
        parsed.map(({ to, amount_sompi, memo }) => ({ to, amount_sompi: amount_sompi!.toString(), memo })),
        feeSompi?.toString(),
      );
      setResult(t("batchSend.paid", { payees: response.payees, count: response.tx_count }));
      onRefresh();
    } catch (e) {
      const message = (e as Error).message;
      setError(message.includes("custodial") || message.includes("403") ? t("batchSend.custodial") : message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="control-card">
      <h2>{t("batchSend.title")}</h2>
      <p><Trans i18nKey="batchSend.intro" components={{ code: <code /> }} /></p>
      <textarea className="control-input mono batch-input" rows={9} value={rows} onChange={(event) => setRows(event.target.value)} placeholder={t("batchSend.placeholder")} />
      <div className="batch-summary"><span>{t("batchSend.recipients", { n: parsed.length })}</span><strong>{t("batchSend.totalZkas", { amount: formatSompi(total) })}</strong></div>
      {invalid && <div className="control-error">{t("batchSend.invalidLine", { line: invalid.line })}</div>}
      {fee && feeSompi == null && <div className="control-error">{t("batchSend.feeError")}</div>}
      <details className="advanced-details"><summary>{t("batchSend.advancedFee")}</summary><label className="field-label">{t("batchSend.feePerTx")}<input className="control-input short-field" inputMode="decimal" value={fee} onChange={(event) => setFee(cleanAmount(event.target.value))} placeholder={t("batchSend.automatic")} /></label><p className="subtle">{t("batchSend.feeNote")}</p></details>
      {error && <div className="control-error">{error}</div>}
      {result && <div className="msg ok">{result}</div>}
      <button className="btn" disabled={busy || !status?.synced || !parsed.length || !!invalid || (fee ? feeSompi == null : false) || total <= 0n} onClick={() => void send()}>{busy ? t("batchSend.building") : t("batchSend.reviewSend", { n: parsed.length || "" })}</button>
    </section>
  );
}

function Maintenance({ status, onRefresh }: { status: Status | null; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await api.consolidate();
      setMessage(t("walletMaintenance.combined", { consolidated: response.consolidated, remaining: response.notes_remaining }));
      onRefresh();
    } catch (e) {
      const text = (e as Error).message;
      setError(text.includes("custodial") || text.includes("403") ? t("walletMaintenance.custodial") : text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="control-card">
      <div className="card-title-row"><div><h2>{t("walletMaintenance.title")}</h2><p>{t("walletMaintenance.intro")}</p></div><span className="status-pill">{t("walletMaintenance.notesCount", { n: status?.note_count ?? "—" })}</span></div>
      <p className="subtle">{t("walletMaintenance.warning")}</p>
      {message && <div className="msg ok">{message}</div>}
      {error && <div className="control-error">{error}</div>}
      <button className="btn ghost" disabled={busy || !status?.synced || (status?.note_count ?? 0) < 2} onClick={() => void run()}>{busy ? t("walletMaintenance.combining") : t("walletMaintenance.consolidateOnce")}</button>
    </section>
  );
}

export function WalletTools() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as ToolTab | null;
  const [tab, setTabState] = useState<ToolTab>(requested && ["batch", "maintenance"].includes(requested) ? requested : "batch");
  const [status, setStatus] = useState<Status | null>(null);
  const refreshInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      setStatus(await api.status());
    } catch {
      // Preserve the last known status through a transient connection failure.
    } finally {
      refreshInFlight.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const choose = (next: ToolTab) => {
    setTabState(next);
    setParams({ tab: next }, { replace: true });
  };
  return (
    <main className="control-page tools-page">
      <div className="control-heading"><div><span className="eyebrow">{t("walletTools.eyebrow")}</span><h1>{t("walletTools.title")}</h1><p>{t("walletTools.intro")}</p></div>{status?.watch_only && <span className="status-pill">{t("walletTools.deviceSigned")}</span>}</div>
      <div className="mode-tabs tool-tabs">{(["batch", "maintenance"] as ToolTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => choose(item)}>{item === "batch" ? t("walletTools.tabBatch") : t("walletTools.tabMaintenance")}</button>)}</div>
      {tab === "batch" ? <BatchSend status={status} onRefresh={refresh} /> : <Maintenance status={status} onRefresh={refresh} />}
    </main>
  );
}
