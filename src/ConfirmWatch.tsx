// "Someone sent you a link that watches a wallet. Do you want to?"
//
// The link used to be acted on at boot with nothing asked: it registered the
// key with the wallet service, made a wallet for it and started scanning. This
// is the question that was missing. It is deliberately a full screen and not a
// toast — the answer changes what this device holds and what its server scans.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { adoptViewKey, clearPendingViewKey, type PendingWatch } from "./lib/watchadopt";

export function ConfirmWatch({ pending, onDone }: { pending: PendingWatch; onDone: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const accept = async () => {
    setBusy(true);
    setError("");
    try {
      await adoptViewKey(pending.key, pending.birthday);
      clearPendingViewKey();
      location.reload();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      setBusy(false);
    }
  };

  const decline = () => {
    clearPendingViewKey();
    onDone();
  };

  return (
    <main className="control-page">
      <div className="card">
        <h1 style={{ marginTop: 0 }}>{t("confirmWatch.title")}</h1>
        <p className="muted">{t("confirmWatch.body")}</p>
        {/* The key itself, so someone who did not expect this link can see that
            it is not their wallet. Truncated: 192 hex characters is not a thing
            anyone reads, and the ends are what distinguish one key from another. */}
        <div className="addr mono" style={{ wordBreak: "break-all" }}>
          {pending.key.slice(0, 16)}…{pending.key.slice(-16)}
        </div>
        <div className="msg warn">{t("confirmWatch.warn")}</div>
        {error && <div className="msg warn">{error}</div>}
        <button className="btn" disabled={busy} onClick={() => void accept()}>
          {busy ? t("confirmWatch.adding") : t("confirmWatch.accept")}
        </button>
        <button className="btn ghost" style={{ marginTop: 8 }} disabled={busy} onClick={decline}>
          {t("confirmWatch.decline")}
        </button>
      </div>
    </main>
  );
}
