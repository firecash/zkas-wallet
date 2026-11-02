// One-time "what's new" for EXISTING users on update.
//
// Version-based, not keyed per release: the app records the version it last ran, and the
// notice is shown to an existing wallet whose last-run version is older than the release
// that introduced what it describes (`NOTICE_SINCE`) — whichever later version they install,
// and however many releases they skipped. A fresh install records its version at first boot,
// so it never sees a notice about the version it started on. Writing a new notice means
// changing the text and `NOTICE_SINCE`; nothing else.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { embeddedAvailable, embeddedFastSync } from "./embedded";
import { isNewerVersion } from "./desktop";
import { APP_VERSION } from "./version";

/// The release this notice describes. rc28: the Public service opens at once, chain files come
/// from the Cloudflare CDN first (a third party that sees the device's IP, so phones keep the
/// "Disable fast sync" choice), a switch carries the scan, and the fixes. Shown on every
/// platform: the Public service is what most web users run.
export const NOTICE_SINCE = "1.0.52-rc28";
/// The app version that last ran on this device (written at every boot).
const LAST_VERSION_KEY = "app_last_seen_version";
/// Dismissal keys of the card before this mechanism, and the version each one was for.
const LEGACY_DISMISSED: [string, string][] = [["whatsnew_seen_v1_0_52_rc22_fastsync", "1.0.52-rc22"]];

function readLastVersion(): string | null {
  try {
    const recorded = localStorage.getItem(LAST_VERSION_KEY);
    if (recorded) return recorded;
    // Before versions were recorded: a dismissed card says the user saw THAT version.
    const legacy = LEGACY_DISMISSED.find(([k]) => localStorage.getItem(k));
    return legacy ? legacy[1] : null;
  } catch {
    return null;
  }
}

function recordVersion(v: string): void {
  try {
    localStorage.setItem(LAST_VERSION_KEY, v);
  } catch {
    /* no storage: the notice may show again, which is harmless */
  }
}

/** Whether to show the update notice. `version` is the running app (overridable for tests).
 * Records this boot's version unless the notice is still owed, so a later notice compares
 * against the version the user actually last ran. */
export function shouldShowWhatsNew(hasWalletHistory: boolean, version: string = APP_VERSION): boolean {
  if (!hasWalletHistory) {
    recordVersion(version);
    return false;
  }
  const last = readLastVersion();
  // No record: last run by a version from before versions were recorded — older than any
  // notice. Owed only if this build is at or past the notice's release; a "dev" build never.
  const owed = version !== "dev" && !isNewerVersion(NOTICE_SINCE, version) && (last === null || isNewerVersion(NOTICE_SINCE, last));
  if (!owed) recordVersion(version);
  return owed;
}

/** The notice was dealt with (OK, or fast sync turned off): record this version. */
export function markWhatsNewSeen(version: string = APP_VERSION): void {
  recordVersion(version);
}

export function WhatsNew({ onClose, onDisableFastSync }: { onClose: () => void; onDisableFastSync: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fastOn = embeddedAvailable() && embeddedFastSync();
  const done = () => {
    markWhatsNewSeen();
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
          {item(t("whatsNew.publicTitle"), t("whatsNew.publicDesc"))}
          {item(t("whatsNew.cdnTitle"), t("whatsNew.cdnDesc"))}
          {item(t("whatsNew.switchTitle"), t("whatsNew.switchDesc"))}
          {item(t("whatsNew.fixTitle"), t("whatsNew.fixesDesc", { button: t("walletMaintenance.consolidateOnce"), tools: t("appShell.tabTools") }))}
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
