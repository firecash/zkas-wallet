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
          <b>Run on this phone</b>
          <small>Complete privacy — the wallet runs here and trusts no server; no wallet service ever sees your viewing key. A bit more battery.</small>
        </span>
        {tag != null && <span>{tag}</span>}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 2px 4px" }}>
          <label className="fieldhint muted">Node to sync from — host:port. The default is the public ZKas node.</label>
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
              <b>Reach the node over Tor</b>
              <br />
              <span className="muted small">Hides your IP from the node. Requires the Orbot app (Tor) running on this phone.</span>
            </span>
          </label>
          <button type="button" className="btn" disabled={!!busy} onClick={go}>
            {starting ? "Starting…" : "Start on this phone"}
          </button>
        </div>
      )}
    </div>
  );
}
