// The "Run on this phone" choice, shared by every phone start-site (first run,
// the connection switcher, and Settings -> Network privacy) so the flow is
// identical everywhere.
//
// First tap reveals an editable node address, prefilled with the default public
// ZKas node, so the user syncs from whichever node they trust before the
// on-device engine starts - the same "default shown, override allowed" choice
// the desktop shell offers in FirstRunNode.

import { useState } from "react";
import type { ReactNode } from "react";
import { embeddedNode, DEFAULT_EMBEDDED_NODE } from "./embedded";

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
  onStart: (node: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [node, setNode] = useState(() => embeddedNode());
  const go = () => void onStart(node.trim() || DEFAULT_EMBEDDED_NODE);
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
          <small>Most private — no server ever sees your viewing key. Runs the wallet here; uses a bit more battery.</small>
        </span>
        {tag != null && <span>{tag}</span>}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 2px 4px" }}>
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
          <button type="button" className="btn" disabled={!!busy} onClick={go}>
            {starting ? "Starting…" : "Start on this phone"}
          </button>
        </div>
      )}
    </div>
  );
}
