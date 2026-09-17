// One-time "what's new" for EXISTING users on update.
//
// Fresh installs learn about phrases and connection choices in the first-run
// screens. An existing wallet skips all of that, so without this it would silently
// gain recovery phrases, accounts and Tor and the user would never know. Shown
// once per release that needs it, gated by the version key below.

import { useTranslation } from "react-i18next";

const SEEN_KEY = "whatsnew_seen_v1_0_17";

/** Whether to show the update notice: an existing wallet that hasn't seen it.
 *
 * RETIRED. The notice below is frozen at the 1.0.17 feature set (phrases / accounts
 * / Tor), which is now many releases old — so it read to users as a stale "new
 * version" popup that kept appearing on a current build. Returning false disables it.
 * To bring it back for a real release, refresh the content AND the SEEN_KEY, then
 * restore the `hasWalletHistory && !localStorage.getItem(SEEN_KEY)` gate. */
export function shouldShowWhatsNew(_hasWalletHistory: boolean): boolean {
  return false;
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
        <div className="whatsnew-list">
          <div>
            <b>{t("whatsNew.phraseTitle")}</b>
            <span className="muted small">{t("whatsNew.phraseDesc")}</span>
          </div>
          <div>
            <b>{t("whatsNew.accountsTitle")}</b>
            <span className="muted small">{t("whatsNew.accountsDesc")}</span>
          </div>
          <div>
            <b>{t("whatsNew.torTitle")}</b>
            <span className="muted small">{t("whatsNew.torDesc")}</span>
          </div>
        </div>
        <div className="row" style={{ marginTop: 16, gap: 10 }}>
          <button className="btn ghost" onClick={dismiss}>{t("whatsNew.gotIt")}</button>
          <button className="btn" onClick={openSettings}>{t("whatsNew.openSettings")}</button>
        </div>
      </div>
    </div>
  );
}
