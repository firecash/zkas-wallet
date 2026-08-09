// First-run node choice (desktop only).
//
// A wallet is only as private as the node it asks about its own coins: whoever
// serves the blocks sees which IP is asking for them. So the choice is put in
// front of the user once, at first launch, rather than buried in settings —
// with the public ZKas node preselected because it is the one that works with
// no setup at all.
//
// Shown once. The answer is remembered, and the same options stay available
// afterwards under Settings → node source.

import { useState } from "react";
import { setNodeSource } from "./desktop";
import { MANAGED_ZKAS_RPC } from "./ports";

const CHOSEN_KEY = "node_choice_made";

/** True when the user has not yet been asked which node to use. */
export function needsNodeChoice(): boolean {
  return !localStorage.getItem(CHOSEN_KEY);
}

export function markNodeChoiceMade() {
  localStorage.setItem(CHOSEN_KEY, "1");
}

export function FirstRunNode({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"remote" | "custom">("remote");
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (mode === "custom" && !addr.trim()) return setErr("Enter the address of your node (host:port).");
    setBusy(true);
    try {
      await setNodeSource(mode, addr.trim() || undefined);
      markNodeChoiceMade();
      onDone();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lockwrap">
      <form className="card lockcard" onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>Choose how to connect</h2>
        <p className="muted small">
          Your wallet asks a ZKas node about the chain. Whichever you pick, your balance and payments stay shielded —
          but the node you ask can see that <i>someone</i> at your address is asking.
        </p>

        <label className="choice">
          <input type="radio" checked={mode === "remote"} onChange={() => setMode("remote")} />
          <span>
            <b>ZKas public node</b> — recommended. Works immediately, nothing to install.
          </span>
        </label>

        <label className="choice">
          <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} />
          <span>
            <b>My own node</b> — a node you already run, anywhere on your network.
          </span>
        </label>
        {mode === "custom" && (
          <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={MANAGED_ZKAS_RPC} />
        )}

        {mode === "remote" && (
          <p className="muted small">You can install and switch to a fully managed local node from the Node page later.</p>
        )}

        {err && <div className="msg err">{err}</div>}

        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Continue"}
        </button>
        <p className="muted small" style={{ marginTop: 10 }}>
          You can change this at any time under Settings, without touching your wallet or its balance.
        </p>
      </form>
    </div>
  );
}
