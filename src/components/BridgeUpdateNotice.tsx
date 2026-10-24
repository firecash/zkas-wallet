/// "A mining-software update is waiting" — the merged-mining Stratum bridge, shown in the
/// WALLET rather than only on the Mine page.
///
/// Same reasoning as NodeUpdateNotice, and for the bridge it is sharper: a bridge from
/// before the ZKM1 fork submits work the node rejects as invalid proof-of-work. It keeps
/// running, keeps reporting hashrate, finds no ZKAS blocks and pays nobody — a failure
/// that looks exactly like working software. Someone mining with it will not go and read
/// the Mine page to find that out, so the wallet says it where they already are.
///
/// Desktop only by construction: `desktopServices` is Tauri `invoke`.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isDesktop } from "../desktop";
import { desktopServices } from "../desktop-services";

const RECHECK_MS = 60_000;

export function BridgeUpdateNotice() {
  const { t } = useTranslation();
  const [release, setRelease] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    let live = true;
    const check = async () => {
      const config = await desktopServices.config().catch(() => null);
      if (!live) return;
      // `bridge_update_available` is already gated on the bridge being INSTALLED and on
      // this platform having a verified release, so there is nothing to add here: an
      // update nobody can install must not be announced.
      const available = !!config?.components.bridge_update_available;
      setRelease(available ? (config?.bridge_release ?? "") : null);
    };
    void check();
    const id = globalThis.setInterval(() => void check(), RECHECK_MS);
    return () => {
      live = false;
      globalThis.clearInterval(id);
    };
  }, []);

  if (release === null) return null;

  return (
    <div className="msg warn small" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 180 }}>
        <b>{t("bridgeUpdateNotice.title")}</b>
        <br />
        <span className="muted">{t("bridgeUpdateNotice.note", { release })}</span>
      </span>
      <button
        className="btn small"
        onClick={() => {
          globalThis.location.hash = "#/mine";
        }}
      >
        {/* Reuses the node notice's action string: identical words, already translated
            into every locale, so this adds no untranslated key. */}
        {t("nodeRunner.updateTo", { version: release || t("nodeRunner.latest") })}
      </button>
    </div>
  );
}
