// The "Run on this phone" choice, shared by every phone start-site (first run,
// the connection switcher, and Settings -> Network privacy) so the flow is
// identical everywhere.
//
// First tap reveals the node address (prefilled with the default public ZKas
// node) and a Tor toggle. The node is who you ask about your coins; Tor (via
// Orbot) hides your IP from that node. Both are chosen before the on-device
// engine starts.

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { embeddedNode, embeddedTor, DEFAULT_EMBEDDED_NODE } from "./embedded";

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
  onStart: (node: string, tor: boolean) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [node, setNode] = useState(() => embeddedNode());
  const [tor, setTor] = useState(() => embeddedTor());
  const go = () => void onStart(node.trim() || DEFAULT_EMBEDDED_NODE, tor);
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
            placeholder={DEFAULT_EMBEDDED_NODE}
            disabled={!!busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            style={{ width: "100%" }}
          />
          <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input type="checkbox" checked={tor} style={{ marginTop: 3 }} disabled={!!busy} onChange={(e) => setTor(e.target.checked)} />
            <span>
              <b>{t("runOnPhoneOption.torTitle")}</b>
              <br />
              <span className="muted small">{t("runOnPhoneOption.torDesc")}</span>
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
