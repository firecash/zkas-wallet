/// "A node update is waiting" — shown in the WALLET, not only on the Node page.
///
/// It used to live only on the Node page, which is the one screen a user has no reason to open
/// while the wallet appears to be working. That makes a critical update invisible exactly when
/// it matters, and on this chain a node being behind is not cosmetic: a node that has not taken
/// a consensus fork **fails closed** — it disqualifies every chain block and stops accepting
/// payments — and a wallet pointed at it reads a chain that has stopped moving. The user sees a
/// stale balance and a send that the network refuses, with nothing on screen connecting either
/// to the node they are running.
///
/// So the notice is rendered in both places. The Node page keeps its full card (it owns the
/// install action and the "stop the node first" rule); this is the compact form, and its button
/// hands over to that one page rather than starting a second install path — one installer, one
/// set of preconditions.
///
/// Desktop only, by construction: `desktopServices` is Tauri `invoke`, and `isDesktop()` is
/// false on web and in the mobile shell, where there is no managed node to update.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isDesktop } from "../desktop";
import { desktopServices } from "../desktop-services";

/// Re-checked on this cadence. The config is a cheap local call, and the answer only changes
/// when a release appears, so a minute is generous. Not a one-shot: the app is left open for
/// days, and an update that lands mid-session must still surface.
const RECHECK_MS = 60_000;

export function NodeUpdateNotice() {
  const { t } = useTranslation();
  const [release, setRelease] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    let live = true;
    const check = async () => {
      // A failure here is not worth reporting: the banner simply does not appear. The Node
      // page is where install/connection errors belong, and a toast on the wallet screen for
      // a background version check would be noise.
      const config = await desktopServices.config().catch(() => null);
      if (!live) return;
      const installed = !!config?.components.zkas_node;
      const available = !!config?.components.zkas_node_update_available;
      setRelease(installed && available ? (config?.zkas_release ?? "") : null);
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
        <b>{t("nodeRunner.updateTitle")}</b>
        <br />
        <span className="muted">{t("nodeRunner.updateNote", { release })}</span>
      </span>
      {/* HashRouter: setting the hash is navigation, and it needs no router context here, so
          this component can be dropped into any tree — including one that is not a Route. */}
      <button
        className="btn small"
        onClick={() => {
          globalThis.location.hash = "#/node";
        }}
      >
        {t("nodeRunner.updateTo", { version: release || t("nodeRunner.latest") })}
      </button>
    </div>
  );
}
