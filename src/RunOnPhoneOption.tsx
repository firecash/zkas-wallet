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
import { embeddedNode, embeddedTor, embeddedNodeIsAutomatic, PUBLIC_EMBEDDED_NODES } from "./embedded";

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
  // Empty means AUTOMATIC: the app assigns a public node and may move that assignment
  // if the node stops answering. A value here is a choice and is kept, failover
  // included — a node somebody typed is theirs, and its failure is worth reporting
  // rather than silently routing around. Prefilling the box would have made every
  // start a choice, which is how automatic would have quietly stopped existing.
  const [node, setNode] = useState(() => (embeddedNodeIsAutomatic() ? "" : embeddedNode()));
  const [tor, setTor] = useState(() => embeddedTor());
  const assigned = embeddedNode();
  const go = () => void onStart(node.trim(), tor);
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
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className={"chip" + (node.trim() === "" ? " on" : "")}
              disabled={!!busy}
              onClick={() => setNode("")}
            >
              {t("runOnPhoneOption.nodeAuto")}
            </button>
            {PUBLIC_EMBEDDED_NODES.map((n) => (
              <button
                key={n}
                type="button"
                className={"chip" + (node.trim() === n ? " on" : "")}
                disabled={!!busy}
                onClick={() => setNode(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="muted small">
            {node.trim() === ""
              ? t("runOnPhoneOption.nodeAutoDesc", { node: assigned })
              : t("runOnPhoneOption.nodePinnedDesc")}
          </span>
          <input
            value={node}
            onChange={(e) => setNode(e.target.value)}
            placeholder={assigned}
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
