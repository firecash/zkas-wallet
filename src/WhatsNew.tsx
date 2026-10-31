// One-time "what's new" for EXISTING users on update.
//
// Fresh installs meet these choices in the first-run screens, so they are marked as having
// seen it; an existing wallet skips first-run and would otherwise gain them silently. Shown
// once per release that needs it, gated by the version key below. The previous notice (the
// on-device engine, 1.0.39) had its own key, so whoever dismissed that one still sees this.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { embeddedAvailable, embeddedFastSync } from "./embedded";

const SEEN_KEY = "whatsnew_seen_v1_0_52_rc22_fastsync";

/** Whether to show the update notice: an existing wallet, on a build with the on-device
 * engine (Android), that has not seen it. A device with no wallet yet is a fresh install:
 * it is marked seen here, so it does not get the notice after creating its first wallet. */
export function shouldShowWhatsNew(hasWalletHistory: boolean): boolean {
  if (!embeddedAvailable()) return false;
  try {
    if (!hasWalletHistory) {
      localStorage.setItem(SEEN_KEY, "1");
      return false;
    }
    return !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}

export function WhatsNew({ onClose, onDisableFastSync }: { onClose: () => void; onDisableFastSync: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fastOn = embeddedFastSync();
  const done = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    onClose();
  };
  const disable = () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    // Seen only once it worked: a failed engine restart keeps the card, with the error.
    void Promise.resolve(onDisableFastSync()).then(
      () => { setBusy(false); done(); },
      (e: unknown) => { setBusy(false); setErr((e as Error)?.message || t("whatsNew.switchFailed")); },
    );
  };
  const item = (title: string, desc: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <b>{title}</b>
      <span className="muted small">{desc}</span>
    </div>
  );
  return (
    <div className="modalwrap" onClick={() => { if (!busy) done(); }}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <span className="eyebrow">{t("whatsNew.eyebrow")}</span>
        <h2 style={{ margin: "6px 0 12px" }}>{t("whatsNew.title")}</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {item(t("whatsNew.fastTitle"), t("whatsNew.fastDesc"))}
          {item(t("whatsNew.fixTitle"), t("whatsNew.fixDesc"))}
          {item(t("whatsNew.logsTitle"), t("whatsNew.logsDesc"))}
          {err && <span className="small" style={{ color: "var(--bad, #fca5a5)" }}>{err}</span>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {fastOn && (
              <button className="btn ghost" data-diag="whatsnew-disable-fast-sync" disabled={busy} onClick={disable}>
                {busy ? t("whatsNew.disabling") : t("whatsNew.disableFast")}
              </button>
            )}
            <button className="btn" disabled={busy} onClick={done}>{t("whatsNew.ok")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
