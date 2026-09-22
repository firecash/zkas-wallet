import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BadgeCheck, ShieldCheck, ShieldX } from "lucide-react";
import { api, type ChainHistoryRow, type PaymentProof as Proof, type ProofVerdict } from "./api";
import { exportFile, exportMessage } from "./exportfile";

/// Everything about a proof that a human should see before they hand it to someone.
function ProofFacts({ p }: { p: Proof }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="detail-row">
        <span className="k">{t("paymentProof.paid")}</span>
        <span className="v">{p.amountZkas ?? p.value / 1e8} ZKAS</span>
      </div>
      <div className="detail-row">
        <span className="k">{t("paymentProof.to")}</span>
        <span className="v mono" style={{ fontSize: 12 }}>{p.recipientAddress ?? p.recipient}</span>
      </div>
      <div className="detail-row">
        <span className="k">{t("paymentProof.tx")}</span>
        <span className="v mono" style={{ fontSize: 12 }}>{p.txid}</span>
      </div>
    </>
  );
}

/// "Prove payment": turn one of our own sends into a disclosure anybody can check.
///
/// The proof is generated on demand rather than stored: it is derived from the
/// transaction on chain plus this wallet's outgoing viewing key, so there is nothing to
/// keep and nothing to leak until the user decides to share it.
export function ProvePayment({ row, onClose }: { row: ChainHistoryRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [proof, setProof] = useState<Proof | null>(null);
  const [withMemo, setWithMemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  const make = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.proof(row.txid);
      setProof(r.proofs[0] ?? null);
      if (!r.proofs.length) setErr(t("paymentProof.errNone"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The memo is the payer's own words and is not needed to verify the payment, so it
  // is left out unless the user asks for it.
  const shareable = proof ? JSON.stringify(withMemo ? proof : { ...proof, memo: undefined }, null, 1) : "";

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t("paymentProof.title")}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>{t("paymentProof.intro")}</p>
      {err && <div className="msg err">{err}</div>}
      {!proof && (
        <button className="btn" onClick={() => void make()} disabled={busy}>
          {busy ? <span className="spin" /> : t("paymentProof.create")}
        </button>
      )}
      {proof && (
        <>
          <ProofFacts p={proof} />
          {!!proof.memo?.length && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
              <input type="checkbox" checked={withMemo} onChange={(e) => setWithMemo(e.target.checked)} />
              <span className="small">{t("paymentProof.includeMemo")}</span>
            </label>
          )}
          <textarea className="mono" readOnly rows={8} value={shareable} onFocus={(e) => e.currentTarget.select()} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(shareable).then(() => setCopied(true)).catch(() => setCopied(false));
              }}
            >
              {copied ? t("paymentProof.copied") : t("paymentProof.copy")}
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                void exportFile(`zkas-payment-proof-${proof.txid.slice(0, 8)}.json`, "application/json", shareable)
                  .then((o) => setErr(exportMessage(o, "proof.json")))
                  .catch((e) => setErr((e as Error).message));
              }}
            >
              {t("paymentProof.saveFile")}
            </button>
          </div>
          <p className="muted small">{t("paymentProof.disclosureNote")}</p>
        </>
      )}
      <button className="btn ghost" onClick={onClose}>{t("paymentProof.close")}</button>
    </div>
  );
}

/// "Verify a payment": paste what somebody sent you, check it against the chain.
export function VerifyPayment() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [verdict, setVerdict] = useState<ProofVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const check = async () => {
    setBusy(true);
    setErr("");
    setVerdict(null);
    try {
      const parsed = JSON.parse(text) as Proof;
      setVerdict(await api.verifyProof(parsed));
    } catch (e) {
      setErr(e instanceof SyntaxError ? t("paymentProof.errNotJson") : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>{t("paymentProof.verifyTitle")}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>{t("paymentProof.verifyIntro")}</p>
      <textarea
        className="mono"
        rows={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("paymentProof.pastePlaceholder")}
      />
      <button className="btn" onClick={() => void check()} disabled={busy || !text.trim()}>
        {busy ? <span className="spin" /> : t("paymentProof.verify")}
      </button>
      {err && <div className="msg err">{err}</div>}
      {verdict && verdict.valid && (
        <div className="msg ok">
          <ShieldCheck aria-hidden="true" size={17} strokeWidth={2.2} />{" "}
          {t("paymentProof.valid", { amount: verdict.amountZkas, address: verdict.recipient ?? "" })}
          <div className="muted small">
            {t("paymentProof.confirmations", { count: verdict.confirmations ?? 0 })}
            {verdict.memo ? ` · “${verdict.memo}”` : ""}
          </div>
        </div>
      )}
      {verdict && !verdict.valid && (
        <div className="msg err">
          <ShieldX aria-hidden="true" size={17} strokeWidth={2.2} /> {t("paymentProof.invalid")}
          <div className="muted small">{verdict.reason}</div>
        </div>
      )}
      <p className="muted small">
        <BadgeCheck aria-hidden="true" size={14} strokeWidth={2.2} /> {t("paymentProof.verifyNote")}
      </p>
    </div>
  );
}
