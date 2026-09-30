// One-time "what's new" for EXISTING users on update.
//
// Fresh installs learn about phrases and connection choices in the first-run
// screens. An existing wallet skips all of that, so without this it would silently
// gain recovery phrases, accounts and Tor and the user would never know. Shown
// once per release that needs it, gated by the version key below.

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
  if (!hasWalletHistory || !embeddedAvailable() || embeddedChosen()) return false;
  try {
    return !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}

export function WhatsNew({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dismiss = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    onClose();
  };
  const openSettings = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    // The settings SCREEN, not the in-wallet tab, so this lands where the nav
    // sends people and Back returns to the wallet.
    location.hash = "#/settings";
    onClose();
  };
  return (
    <div className="modalwrap" onClick={dismiss}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <span className="eyebrow">{t("whatsNew.eyebrow")}</span>
        <h2 style={{ margin: "6px 0 12px" }}>{t("whatsNew.title")}</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <b>{t("whatsNew.onPhoneTitle")}</b>
            <span className="muted small">{t("whatsNew.onPhoneDesc")}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <b>{t("whatsNew.nodesTitle")}</b>
            <span className="muted small">{t("whatsNew.nodesDesc")}</span>
          </div>
          <span className="muted small">{t("whatsNew.onPhoneCaveat")}</span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={openSettings}>{t("whatsNew.setItUp")}</button>
            <button className="btn ghost" onClick={dismiss}>{t("whatsNew.notNow")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
