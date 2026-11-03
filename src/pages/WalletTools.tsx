import { VerifyPayment } from "../PaymentProof";
import { looksLikeAddress, networkOf } from "../lib/utils";
import { consolidateNonCustodial, sendNonCustodial } from "../noncustodial";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, type Status } from "../api";
import { browserConsolidate, browserModeChosen, browserSendMany } from "../webengine";
import { resolveDeviceSeed } from "../lib/deviceseed";

type ToolTab = "batch" | "maintenance" | "verify";

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
  // looksLikeAddress, not a local regex. This file had its own —
  // `/^(zkas|firecash):[a-z0-9]{50,100}$/i` — which accepts `b`, `i`, `o` and `1`: the four
  // characters bech32 leaves out BECAUSE humans confuse them when copying. A batch send is the
  // worst place for that, because addresses arrive PASTED IN BULK and a one-character
  // transcription error is exactly what happens here. Mining carried the same regex under a
  // comment claiming "the app already owns the real test and uses it in WalletTools" — it did
  // not: this was the instance that comment vouched for.
  const invalid = parsed.find((row) => !looksLikeAddress(row.to) || row.amount_sompi == null);
  const feeSompi = fee ? parseSompi(fee) : undefined;
  const total = parsed.reduce((sum, row) => sum + (row.amount_sompi ?? 0n), 0n);
  const send = async () => {
    setBusy(true);
    setError("");
    setResult("");
    try {
      const payees = parsed.map(({ to, amount_sompi, memo }) => ({ to, amount_sompi: amount_sompi!.toString(), memo }));
      const seed = await resolveDeviceSeed(status?.address ?? undefined);
      if (browserModeChosen()) {
        // In browser mode this page holds the key: one transaction, proven here.
        const response = await browserSendMany(seed, payees);
        setResult(t("batchSend.paid", { payees: response.payees, count: response.tx_count }));
      } else {
        // Every wallet service holds this wallet watch-only, so the service-side
        // /api/wallet/send-many (it needs the seed) only ever refused it. Pay each line as an
        // ordinary payment instead: the service proves, this device signs. In order, and on a
        // failure stop and say which line, so a retry never pays anyone twice.
        let txs = 0;
        for (let i = 0; i < parsed.length; i++) {
          const row = parsed[i];
          try {
            const r = await sendNonCustodial(seed, networkOf(status), row.to, Number(row.amount_sompi!) / 1e8, feeSompi != null ? Number(feeSompi) : undefined, undefined, row.memo, true);
            txs += r.txids?.length ?? 1;
          } catch (e) {
            if (i === 0) throw e;
            setError(t("batchSend.partial", { done: i, total: parsed.length, line: row.line, error: (e as Error).message }));
            onRefresh();
            return;
          }
        }
        setResult(t("batchSend.paid", { payees: parsed.length, count: txs }));
      }
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
      const seed = await resolveDeviceSeed(status?.address ?? undefined);
      if (browserModeChosen()) {
        const response = await browserConsolidate(seed);
        setMessage(t("walletMaintenance.combined", { consolidated: response.consolidated, remaining: response.notes_remaining }));
      } else {
        // Every wallet service (the Public service, the phone's own engine, a custom walletd)
        // holds this wallet watch-only, so the service-side /api/wallet/consolidate always
        // refused it. Merge the way sends work: the service proves, this device signs.
        if (!status?.address) throw new Error(t("consolidateDialog.errNoAddress"));
        const before = status.note_count ?? 0;
        const r = await consolidateNonCustodial(seed, networkOf(status), status.address, BigInt(status.spendable_sompi ?? "0"), undefined, 1, undefined, 1, before);
        setMessage(t("walletMaintenance.combined", { consolidated: r.inputs, remaining: Math.max(1, before - r.inputs + r.txids.length) }));
      }
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
      <div className="card-title-row"><div><h2>{t("walletMaintenance.title")}</h2><p>{t("walletMaintenance.intro")}</p></div><span className="status-pill" title={t("walletMaintenance.notesCount", { n: status?.note_count ?? "—" })}>{t("walletMaintenance.notesCount", { n: status?.note_count ?? "—" })}</span></div>
      <p className="subtle">{t("walletMaintenance.warning")}</p>
      {message && <div className="msg ok">{message}</div>}
      {error && <div className="control-error">{error}</div>}
      <button className="btn ghost" disabled={busy || !status?.synced || (status?.note_count ?? 0) < 2} onClick={() => void run()}>{busy ? t("walletMaintenance.combining") : t("walletMaintenance.consolidateOnce")}</button>
    </section>
  );
}

/// `status` is the shell's already-polled wallet status. When the caller passes it
/// (even as null, while it loads) this page runs no poll of its own; left undefined,
/// the page keeps its own 2 s /api/status poll so other call sites still work.
export function WalletTools({ status: shared }: { status?: Status | null } = {}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as ToolTab | null;
  const [tab, setTabState] = useState<ToolTab>(requested && ["batch", "maintenance"].includes(requested) ? requested : "batch");
  const [ownStatus, setOwnStatus] = useState<Status | null>(null);
  const polls = shared === undefined;
  const status = polls ? ownStatus : shared;
  const refreshInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (!polls || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      setOwnStatus(await api.status());
    } catch {
      // Preserve the last known status through a transient connection failure.
    } finally {
      refreshInFlight.current = false;
    }
  }, [polls]);
  useEffect(() => {
    if (!polls) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [polls, refresh]);
  const choose = (next: ToolTab) => {
    setTabState(next);
    setParams({ tab: next }, { replace: true });
  };
  return (
    <main className="control-page tools-page">
      <div className="control-heading"><div><span className="eyebrow">{t("walletTools.eyebrow")}</span><h1>{t("walletTools.title")}</h1><p>{t("walletTools.intro")}</p></div>{status?.watch_only && <span className="status-pill" title={t("walletTools.deviceSigned")}>{t("walletTools.deviceSigned")}</span>}</div>
      <div className="mode-tabs tool-tabs">{(["batch", "maintenance", "verify"] as ToolTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => choose(item)}>{item === "batch" ? t("walletTools.tabBatch") : item === "maintenance" ? t("walletTools.tabMaintenance") : t("walletTools.tabVerify")}</button>)}</div>
      {tab === "batch" ? <BatchSend status={status} onRefresh={refresh} /> : tab === "maintenance" ? <Maintenance status={status} onRefresh={refresh} /> : <VerifyPayment />}
    </main>
  );
}
