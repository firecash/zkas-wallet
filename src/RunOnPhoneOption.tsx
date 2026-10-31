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
import {
  embeddedTor,
  embeddedPrimaryNode,
  embeddedBackupNode,
  embeddedUsingBackup,
  embeddedFastSync,
  embeddedChainFilesUrl,
  isPublicZkasNode,
  normalizeChainFilesUrl,
  validChainFilesUrl,
  DEFAULT_CHAIN_FILES_URL,
  type FastSync,
} from "./embedded";

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
  onStart: (node: string, tor: boolean, backup?: string, fast?: FastSync) => void | Promise<void>;
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
  const [fastUrl, setFastUrl] = useState(() => embeddedChainFilesUrl() || DEFAULT_CHAIN_FILES_URL);
  const onBackup = embeddedUsingBackup();
  const publicNode = isPublicZkasNode(node || embeddedPrimaryNode());
  // The engine's rule: the default address only with ZKas's public nodes; an address the
  // user typed with any node; never over Tor.
  const customUrl = normalizeChainFilesUrl(fastUrl) !== "";
  const fastApplies = !tor && (publicNode || customUrl);
  const urlOk = validChainFilesUrl(fastUrl);
  const go = () => {
    if (fast && !tor && !urlOk) return;
    void onStart(node.trim(), tor, backup.trim(), { on: fast, url: fastUrl });
  };
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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label className="row" style={{ gap: 10, alignItems: "center", cursor: tor ? "default" : "pointer" }}>
              <input type="checkbox" data-diag="fast-sync" checked={fast && !tor} disabled={!!busy || tor} onChange={(e) => setFast(e.target.checked)} />
              <b>{t("runOnPhoneOption.fastTitle")}</b>
            </label>
            {fast && !tor && (
              <input
                value={fastUrl}
                onChange={(e) => setFastUrl(e.target.value)}
                placeholder={t("runOnPhoneOption.fastUrlPlaceholder")}
                aria-label={t("runOnPhoneOption.fastUrlLabel")}
                disabled={!!busy}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="url"
                style={{ width: "100%" }}
              />
            )}
            <span className="muted small">
              {tor
                ? t("runOnPhoneOption.fastOffTor")
                : !fast
                  ? t("runOnPhoneOption.fastOff")
                  : !urlOk
                    ? t("runOnPhoneOption.fastBadUrl")
                    : !fastApplies
                      ? t("runOnPhoneOption.fastOffOwnNode")
                      : t("runOnPhoneOption.fastHint")}
            </span>
          </div>
          <button type="button" className="btn" disabled={!!busy || (fast && !tor && !urlOk)} onClick={go}>
            {starting ? t("runOnPhoneOption.starting") : t("runOnPhoneOption.start")}
          </button>
        </div>
      )}
    </div>
  );
}
