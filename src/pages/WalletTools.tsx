import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
      setResult(`Paid ${response.payees} recipients in ${response.tx_count} transaction${response.tx_count === 1 ? "" : "s"}.`);
      onRefresh();
    } catch (e) {
      const message = (e as Error).message;
      setError(message.includes("custodial") || message.includes("403") ? "Batch send needs a self-hosted walletd that holds this wallet's seed. This app will not upload your seed to enable it." : message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="control-card">
      <h2>Batch send</h2>
      <p>One recipient per line: <code>address, amount, optional memo</code>. walletd packs recipients into as few proofs as consensus allows.</p>
      <textarea className="control-input mono batch-input" rows={9} value={rows} onChange={(event) => setRows(event.target.value)} placeholder={"zkas:…, 1.25, Invoice 1042\nzkas:…, 0.5"} />
      <div className="batch-summary"><span>{parsed.length} recipients</span><strong>{formatSompi(total)} ZKAS</strong></div>
      {invalid && <div className="control-error">Line {invalid.line} has an invalid address or amount.</div>}
      {fee && feeSompi == null && <div className="control-error">Enter a positive fee with at most 8 decimal places.</div>}
      <details className="advanced-details"><summary>Advanced fee floor</summary><label className="field-label">ZKAS per transaction<input className="control-input short-field" inputMode="decimal" value={fee} onChange={(event) => setFee(cleanAmount(event.target.value))} placeholder="Automatic" /></label><p className="subtle">Automatic is recommended. The node raises a low value to the byte-proportional relay minimum; paying more does not buy a faster lane.</p></details>
      {error && <div className="control-error">{error}</div>}
      {result && <div className="msg ok">{result}</div>}
      <button className="btn" disabled={busy || !status?.synced || !parsed.length || !!invalid || (fee ? feeSompi == null : false) || total <= 0n} onClick={() => void send()}>{busy ? "Building private payout…" : `Review & send ${parsed.length || ""}`}</button>
    </section>
  );
}

function Maintenance({ status, onRefresh }: { status: Status | null; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await api.consolidate();
      setMessage(`Combined ${response.consolidated} notes. ${response.notes_remaining} notes remain.`);
      onRefresh();
    } catch (e) {
      const text = (e as Error).message;
      setError(text.includes("custodial") || text.includes("403") ? "Manual consolidation needs a self-hosted walletd that holds this wallet's seed. Automatic fee-safe consolidation remains a daemon setting; the app never uploads your seed." : text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="control-card">
      <div className="card-title-row"><div><h2>Notes</h2><p>Fewer notes make large payments cheaper and faster to prove.</p></div><span className="status-pill">{status?.note_count ?? "—"} notes</span></div>
      <p className="subtle">Do not consolidate a normal wallet just to make the count smaller: it costs a real fee and creates an on-chain transaction. It is useful for mining and payout wallets with hundreds of small matured notes.</p>
      {message && <div className="msg ok">{message}</div>}
      {error && <div className="control-error">{error}</div>}
      <button className="btn ghost" disabled={busy || !status?.synced || (status?.note_count ?? 0) < 2} onClick={() => void run()}>{busy ? "Combining notes…" : "Consolidate once"}</button>
    </section>
  );
}

export function WalletTools() {
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
      <div className="control-heading"><div><span className="eyebrow">Wallet tools</span><h1>Wallet maintenance</h1><p>Batch payouts and note management.</p></div>{status?.watch_only && <span className="status-pill">Device-signed</span>}</div>
      <div className="mode-tabs tool-tabs">{(["batch", "maintenance"] as ToolTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => choose(item)}>{item === "batch" ? "Batch send" : "Maintenance"}</button>)}</div>
      {tab === "batch" ? <BatchSend status={status} onRefresh={refresh} /> : <Maintenance status={status} onRefresh={refresh} />}
    </main>
  );
}
