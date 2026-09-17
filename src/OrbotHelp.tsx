// Shown when "Connect over Tor" cannot reach the onion — which almost always
// means no Tor transport is running, not that anything is broken.
//
// The wallet bundles no Tor client, so what the user must do differs completely
// by platform. Telling a desktop user to install an Android app (as this once
// did) is worse than saying nothing: it reads as "this feature is not for you".

import { useTranslation, Trans } from "react-i18next";
import { isNative } from "./api";
import { isDesktop } from "./desktop";
import { ONION_WALLETD_URL, ORBOT_APPSTORE_URL, ORBOT_PLAY_URL } from "./lib/relay";

/// iPhone or Android — they get Orbot from different stores, and only Android has
/// a "VPN mode" to turn on (Orbot for iOS is a VPN, full stop).
function isIos(): boolean {
  const cap = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return cap?.getPlatform?.() === "ios";
}

/// The onion origin without the /daemon suffix — the address a Tor Browser user
/// can open directly to get the whole wallet over Tor.
const ONION_SITE = ONION_WALLETD_URL.replace(/\/daemon\/?$/, "");

export function OrbotHelp() {
  const { t } = useTranslation();
  if (isNative()) {
    // Same app, two stores, and Android's "VPN mode" wording does not exist on
    // iOS — sending an iPhone to Google Play read as "not for you".
    const ios = isIos();
    return (
      <div className="orbot-help">
        <b>{t("orbotHelp.nativeTitle")}</b>
        <p className="muted small" style={{ margin: "4px 0 8px" }}>
          {t("orbotHelp.nativeIntro")}
        </p>
        <ol className="orbot-steps">
          <li>{ios ? t("orbotHelp.stepInstallIos") : t("orbotHelp.stepInstall")}</li>
          {ios
            ? <li><Trans i18nKey="orbotHelp.stepConnectIos" components={{ b: <b /> }} /></li>
            : <li><Trans i18nKey="orbotHelp.stepVpnMode" components={{ b: <b /> }} /></li>}
          <li><Trans i18nKey="orbotHelp.stepRetry" components={{ b: <b /> }} /></li>
        </ol>
        <a className="btn small ghost" href={ios ? ORBOT_APPSTORE_URL : ORBOT_PLAY_URL} target="_blank" rel="noreferrer">{t("orbotHelp.getOrbot")}</a>
      </div>
    );
  }

  if (isDesktop()) {
    return (
      <div className="orbot-help">
        <b>{t("orbotHelp.desktopTitle")}</b>
        {/* This used to say the app had no Tor client and needed the SYSTEM to
            route through Tor — which is a far bigger ask than it needs to be, and
            wrong since the shell started speaking SOCKS itself. Running Tor
            Browser is enough, and is how most people on Windows and macOS have
            Tor at all. */}
        <p className="muted small" style={{ margin: "4px 0 8px" }}>
          {t("orbotHelp.desktopIntro")}
        </p>
        <p className="muted small" style={{ margin: "0 0 8px" }}>
          <Trans i18nKey="orbotHelp.desktopPorts" components={{ code: <code /> }} />
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          <Trans i18nKey="orbotHelp.desktopOwnNode" components={{ b: <b /> }} />
        </p>
      </div>
    );
  }

  // Plain browser: the realistic path is Tor Browser, and the whole wallet is
  // served on the onion, so they can just open it there.
  return (
    <div className="orbot-help">
      <b>{t("orbotHelp.browserTitle")}</b>
      <p className="muted small" style={{ margin: "4px 0 8px" }}>
        <Trans i18nKey="orbotHelp.browserIntro" components={{ code: <code /> }} />
      </p>
      <div className="addr" style={{ marginBottom: 8 }}>{ONION_SITE}</div>
      <p className="muted small" style={{ margin: 0 }}>{t("orbotHelp.browserKeys")}</p>
    </div>
  );
}
