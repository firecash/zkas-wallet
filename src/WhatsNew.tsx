// One-time "what's new" for EXISTING users on update.
//
// Fresh installs learn about phrases and connection choices in the first-run
// screens. An existing wallet skips all of that, so without this it would silently
// gain recovery phrases, accounts and Tor and the user would never know. Shown
// once per release that needs it, gated by the version key below.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { embeddedAvailable, embeddedChosen } from "./embedded";

const SEEN_KEY = "whatsnew_seen_v1_0_39_onphone";

/** Whether to show the update notice: an existing wallet that hasn't seen it.
 *
 * Revived for the on-device engine, per the instructions this comment used to carry:
 * new content, new SEEN_KEY, gate restored. The previous notice was frozen at the
 * 1.0.17 feature set and had gone stale, which is why it was switched off.
 *
 * Shown only where it can be acted on: an existing wallet (a fresh install meets this
 * choice in first-run), on a build that HAS the engine, and not to somebody already
 * running it — offering a thing you are already using is how a notice teaches people
 * to dismiss notices. */
export function shouldShowWhatsNew(hasWalletHistory: boolean): boolean {
  // Not `&& !embeddedChosen()`. That was the first version and it was too broad: it
  // suppressed the notice for everyone ALREADY running on the phone, who are precisely
  // the people the new node and backup controls are for. The card adapts instead —
  // whoever is not on the engine is offered it, whoever is gets told about the nodes.
  if (!hasWalletHistory || !embeddedAvailable()) return false;
  try {
    return !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}

export function WhatsNew({ onClose, onSwitch }: { onClose: () => void; onSwitch?: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const [switching, setSwitching] = useState(false);
  const [err, setErr] = useState("");
  // Someone already on the engine does not need to be sold it; they need to know the
  // node controls exist.
  const alreadyOn = embeddedChosen();
  const switchNow = () => {
    if (switching || !onSwitch) return;
    setSwitching(true);
    setErr("");
    // Mark it seen only once it WORKED. Writing the key first and closing in a
    // `finally` meant a failed start left the user on the hosted service, with no
    // explanation and no way back to this card.
    void Promise.resolve(onSwitch()).then(
      () => {
        try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
        setSwitching(false);
        onClose();
      },
      (e: unknown) => {
        setSwitching(false);
        setErr((e as Error)?.message || t("whatsNew.switchFailed"));
      },
    );
  };
  const dismiss = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    onClose();
  };
  return (
    <div className="modalwrap" onClick={dismiss}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <span className="eyebrow">{t("whatsNew.eyebrow")}</span>
        <h2 style={{ margin: "6px 0 12px" }}>
          {alreadyOn ? t("whatsNew.titleOnPhone") : t("whatsNew.title")}
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!alreadyOn && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <b>{t("whatsNew.onPhoneTitle")}</b>
              <span className="muted small">{t("whatsNew.onPhoneDesc")}</span>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <b>{t("whatsNew.nodesTitle")}</b>
            <span className="muted small">{t("whatsNew.nodesDesc")}</span>
          </div>
          {!alreadyOn && <span className="muted small">{t("whatsNew.onPhoneCaveat")}</span>}
          {err && <span className="small" style={{ color: "var(--bad, #fca5a5)" }}>{err}</span>}
          {/* One action, done here. Sending somebody to Settings to finish an upgrade
              is not an upgrade, and for a user already on the engine there was nothing
              for them to do there at all — the card just bounced them out of the wallet. */}
          <div className="row" style={{ gap: 8 }}>
            {!alreadyOn && onSwitch ? (
              <>
                <button className="btn" disabled={switching} onClick={switchNow}>
                  {switching ? t("whatsNew.switching") : t("whatsNew.switchNow")}
                </button>
                <button className="btn ghost" disabled={switching} onClick={dismiss}>
                  {t("whatsNew.notNow")}
                </button>
              </>
            ) : (
              <button className="btn" onClick={dismiss}>{t("whatsNew.gotIt")}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
