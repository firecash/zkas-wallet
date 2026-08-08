import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { api, type Status } from "../api";

type ToolTab = "request" | "batch" | "maintenance";

function cleanAmount(value: string): string {
  const stripped = value.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = stripped.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 8)}` : whole;
}

function paymentUri(address: string, amount: string, memo: string, label: string): string {
  const params = new URLSearchParams();
  if (amount) params.set("amount", amount);
  if (memo.trim()) params.set("memo", memo.trim());
  if (label.trim()) params.set("label", label.trim());
  const query = params.toString();
  return `${address}${query ? `?${query}` : ""}`;
}

function sompi(value: string): bigint {
  const match = value.trim().match(/^(\d*)(?:\.(\d{0,8}))?$/);
  if (!match) return 0n;
  return BigInt(match[1] || "0") * 100_000_000n + BigInt((match[2] || "").padEnd(8, "0"));
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

function visibleBalance(status: Status): bigint {
  return BigInt(status.balance_sompi || "0") + BigInt(status.pending_in_sompi || "0");
}

async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

function PaymentRequest({ status }: { status: Status | null }) {
  const address = status?.address || "";
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState("15");
  const [createdAt, setCreatedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [qr, setQr] = useState("");
  const [pos, setPos] = useState(false);
  const [paid, setPaid] = useState(false);
  const [copied, setCopied] = useState(false);
  const [posBusy, setPosBusy] = useState(false);
  const [posError, setPosError] = useState("");
  const posBaseline = useRef<bigint | null>(null);
  const posPollInFlight = useRef(false);
  const uri = useMemo(() => paymentUri(address, amount, memo, label), [address, amount, memo, label]);
  const expiry = createdAt + Math.max(1, Number(minutes) || 15) * 60_000;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!address) return;
    QRCode.toDataURL(uri, { width: 520, margin: 1 }).then(setQr).catch(() => setQr(""));
  }, [address, uri]);

  useEffect(() => {
    if (!pos || paid || posBaseline.current == null) return;
    const requested = sompi(amount);
    let live = true;
    const poll = async () => {
      if (posPollInFlight.current) return;
      posPollInFlight.current = true;
      try {
        const next = await api.status();
        if (live && requested > 0n && posBaseline.current != null && visibleBalance(next) - posBaseline.current >= requested) setPaid(true);
      } catch {
        // A later poll can recover; never mark an unpaid invoice as paid.
      } finally {
        posPollInFlight.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pos, paid, amount, createdAt]);

  const regenerate = async () => {
    setPosError("");
    if (pos) {
      try {
        posBaseline.current = visibleBalance(await api.status());
      } catch {
        setPosError("Cannot start a new request until the wallet service responds.");
        return;
      }
    }
    setCreatedAt(Date.now());
    setPaid(false);
  };

  const enterPos = async () => {
    setPosBusy(true);
    setPosError("");
    try {
      // The page-level status may be seconds old. Take the baseline immediately
      // before opening POS so an earlier payment cannot satisfy this invoice.
      posBaseline.current = visibleBalance(await api.status());
      setCreatedAt(Date.now());
      setPaid(false);
      setPos(true);
    } catch {
      setPosError("Cannot start POS mode until the wallet service responds.");
    } finally {
      setPosBusy(false);
    }
  };

  const content = (
    <div className={pos ? "pos-panel" : "payment-request-layout"}>
      <div className="request-qr">{qr ? <img src={qr} alt="ZKAS payment request QR" /> : <span className="spin" />}</div>
      <div className="request-summary">
        <span className="eyebrow">{paid ? "Payment received" : now > expiry ? "Request expired" : "Pay with ZKAS"}</span>
        <strong>{amount || "0"} <small>ZKAS</small></strong>
        {memo && <p>{memo}</p>}
        <code>{address}</code>
        {!paid && <p className="subtle">Expires {new Date(expiry).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>}
        {paid && <div className="payment-success">✓ Paid</div>}
        {posError && <div className="control-error">{posError}</div>}
        <div className="control-actions">
          <button className="btn compact" onClick={async () => { await copy(uri); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied ✓" : "Copy request"}</button>
          <button className="btn ghost compact" onClick={() => void regenerate()}>New request</button>
          {pos && <button className="btn ghost compact" onClick={() => setPos(false)}>Exit POS</button>}
        </div>
      </div>
    </div>
  );

  if (pos) return <div className="pos-overlay">{content}</div>;
  return (
    <>
      <section className="control-card">
        <div className="card-title-row"><div><h2>Payment request</h2><p>Create a QR without sharing any key.</p></div><button className="btn ghost compact" disabled={posBusy || !address || !(sompi(amount) > 0n)} onClick={() => void enterPos()}>{posBusy ? "Checking…" : "POS mode"}</button></div>
        <div className="request-fields">
          <label className="field-label">Amount<input className="control-input" inputMode="decimal" value={amount} onChange={(event) => setAmount(cleanAmount(event.target.value))} placeholder="0.00" /></label>
          <label className="field-label">Expires in<select className="control-input" value={minutes} onChange={(event) => { setMinutes(event.target.value); regenerate(); }}><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option></select></label>
          <label className="field-label">Memo<input className="control-input" maxLength={512} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Order or message (optional)" /></label>
          <label className="field-label">Your name<input className="control-input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Shown to the payer (optional)" /></label>
        </div>
      </section>
      {posError && <div className="control-error">{posError}</div>}
      {address ? content : <div className="control-error">Open or create a wallet before making a payment request.</div>}
      <p className="subtle explorer-note">Expiry is a point-of-sale instruction, not a chain rule. The wallet detects a matching balance increase while this screen is open; merchant websites should use the gateway's unique-address invoices instead.</p>
    </>
  );
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
  const [tab, setTabState] = useState<ToolTab>(requested && ["request", "batch", "maintenance"].includes(requested) ? requested : "request");
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
      <div className="control-heading"><div><span className="eyebrow">Wallet tools</span><h1>Payments</h1><p>Request, accept, and manage private payments.</p></div>{status?.watch_only && <span className="status-pill">Device-signed</span>}</div>
      <div className="mode-tabs tool-tabs">{(["request", "batch", "maintenance"] as ToolTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => choose(item)}>{item === "request" ? "Request / POS" : item === "batch" ? "Batch send" : "Maintenance"}</button>)}</div>
      {tab === "request" ? <PaymentRequest status={status} /> : tab === "batch" ? <BatchSend status={status} onRefresh={refresh} /> : <Maintenance status={status} onRefresh={refresh} />}
    </main>
  );
}
