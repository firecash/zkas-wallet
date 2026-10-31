// The "Run on this phone" choice, shared by every phone start-site (first run,
// the connection switcher, and Settings -> Network privacy) so the flow is
// identical everywhere.
//
// First tap reveals the node address (prefilled with the default public ZKas
// node) and a Tor toggle. The node is who you ask about your coins; Tor (via
// Orbot) hides your IP from that node. Fast sync reads catch-up from the chain
// files ZKas publishes instead of block by block from the node. All are chosen
// before the on-device engine starts.

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { embeddedTor, embeddedPrimaryNode, embeddedBackupNode, embeddedUsingBackup, embeddedFastSync, isPublicZkasNode } from "./embedded";

export function RunOnPhoneOption({
  active,
  busy,
  starting,
  tag,
  onStart,
}: {
  active?: boolean;
  busy?: boolean;
  starting?: boolean;
  tag?: ReactNode;
  onStart: (node: string, tor: boolean, backup?: string, fast?: boolean) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Two nodes, always both on screen: the one to sync from, and a spare to fall back to
  // when the first stops answering. The spare is optional — one node is a valid setup,
  // it just cannot be failed away from, and the field says so rather than implying a
  // second is required.
  const [node, setNode] = useState(() => embeddedPrimaryNode());
  const [backup, setBackup] = useState(() => embeddedBackupNode());
  const [tor, setTor] = useState(() => embeddedTor());
  // The user's choice, kept as chosen even while it cannot apply (Tor on, or their own node):
  // switching Tor off again must not silently leave fast sync off, or turn it on.
  const [fast, setFast] = useState(() => embeddedFastSync());
  const onBackup = embeddedUsingBackup();
  const publicNode = isPublicZkasNode(node || embeddedPrimaryNode());
  const fastApplies = !tor && publicNode;
  const go = () => void onStart(node.trim(), tor, backup.trim(), fast);
  return (
    <div className="run-on-phone">
      <button
        type="button"
        className={"connection-option" + (active ? " active" : "")}
        disabled={!!busy}
        onClick={() => (open ? go() : setOpen(true))}
      >
        <span>
          <b>{t("runOnPhoneOption.title")}</b>
          <small>{t("runOnPhoneOption.desc")}</small>
        </span>
        {tag != null && <span>{tag}</span>}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 2px 4px" }}>
          <label className="fieldhint muted">{t("runOnPhoneOption.nodeHint")}</label>
          <input
            value={node}
            onChange={(e) => setNode(e.target.value)}
            placeholder={t("runOnPhoneOption.nodePlaceholder")}
            disabled={!!busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            style={{ width: "100%" }}
          />
          <label className="fieldhint muted">{t("runOnPhoneOption.backupHint")}</label>
          <input
            value={backup}
            onChange={(e) => setBackup(e.target.value)}
            placeholder={t("runOnPhoneOption.backupPlaceholder")}
            disabled={!!busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            style={{ width: "100%" }}
          />
          {onBackup && <span className="muted small">{t("runOnPhoneOption.onBackupNow")}</span>}
          <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input type="checkbox" checked={tor} style={{ marginTop: 3 }} disabled={!!busy} onChange={(e) => setTor(e.target.checked)} />
            <span>
              <b>{t("runOnPhoneOption.torTitle")}</b>
              <br />
              <span className="muted small">{t("runOnPhoneOption.torDesc")}</span>
            </span>
          </label>
          <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: fastApplies ? "pointer" : "default", opacity: fastApplies ? 1 : 0.6 }}>
            <input
              type="checkbox"
              data-diag="fast-sync"
              checked={fast && fastApplies}
              style={{ marginTop: 3 }}
              disabled={!!busy || !fastApplies}
              onChange={(e) => setFast(e.target.checked)}
            />
            <span>
              <b>{t("runOnPhoneOption.fastTitle")}</b>
              <br />
              <span className="muted small">
                {tor ? t("runOnPhoneOption.fastOffTor") : !publicNode ? t("runOnPhoneOption.fastOffOwnNode") : t("runOnPhoneOption.fastDesc")}
              </span>
            </span>
          </label>
          <button type="button" className="btn" disabled={!!busy} onClick={go}>
            {starting ? t("runOnPhoneOption.starting") : t("runOnPhoneOption.start")}
          </button>
        </div>
      )}
    </div>
  );
}
