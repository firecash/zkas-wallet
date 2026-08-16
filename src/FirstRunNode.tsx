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

import { useEffect, useRef, useState } from "react";
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

// How long the user watches "Connecting…" before we offer a way out. The happy
// path resolves in ~1-2s; this only ever shows on a slow/blocked path to the
// node or a node that is momentarily at its connection limit.
const SKIP_AFTER_MS = 12_000;

export function FirstRunNode({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"remote" | "custom">("remote");
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showSkip, setShowSkip] = useState(false);
  // The wallet is only ever opened once from here, whether the connection
  // succeeded or the user chose to proceed without waiting. Guards against
  // onDone firing twice (skip, then a late-resolving setNodeSource).
  const settled = useRef(false);

  // Never trap the user on this modal. If connecting drags on, reveal an escape
  // that opens the wallet anyway: walletd keeps retrying the node in the
  // background, the app shows reachability as a live status, and the node
  // source can be changed at any time under Settings.
  useEffect(() => {
    if (!busy) {
      setShowSkip(false);
      return;
    }
    const t = setTimeout(() => setShowSkip(true), SKIP_AFTER_MS);
    return () => clearTimeout(t);
  }, [busy]);

  const proceed = () => {
    if (settled.current) return;
    settled.current = true;
    markNodeChoiceMade();
    onDone();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (mode === "custom" && !addr.trim()) return setErr("Enter the address of your node (host:port).");
    setBusy(true);
    try {
      await setNodeSource(mode, addr.trim() || undefined);
      proceed();
    } catch (e2) {
      // Suppressed once the user has already chosen to continue: the pending
      // call can reject after we have moved on, and that is not an error to show.
      if (!settled.current) setErr(String(e2));
    } finally {
      if (!settled.current) setBusy(false);
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
          <input type="radio" checked={mode === "remote"} onChange={() => setMode("remote")} disabled={busy} />
          <span>
            <b>ZKas public node</b> — recommended. Works immediately, nothing to install.
          </span>
        </label>

        <label className="choice">
          <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} disabled={busy} />
          <span>
            <b>My own node</b> — a node you already run, anywhere on your network.
          </span>
        </label>
        {mode === "custom" && (
          <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={MANAGED_ZKAS_RPC} disabled={busy} />
        )}

        {mode === "remote" && !busy && (
          <p className="muted small">You can install and switch to a fully managed local node from the Node page later.</p>
        )}

        {err && <div className="msg err">{err}</div>}

        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Continue"}
        </button>

        {busy && showSkip && (
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <p className="muted small" style={{ marginBottom: 6 }}>
              Still reaching the node — it may be slow or busy right now.
            </p>
            <button
              type="button"
              onClick={proceed}
              style={{
                background: "none",
                border: "none",
                color: "var(--ember)",
                textDecoration: "underline",
                cursor: "pointer",
                font: "inherit",
                padding: 0,
              }}
            >
              Continue without connecting
            </button>
            <p className="muted small" style={{ marginTop: 6 }}>
              Your wallet opens now and keeps trying in the background. You can change the node under Settings.
            </p>
          </div>
        )}

        <p className="muted small" style={{ marginTop: 10 }}>
          You can change this at any time under Settings, without touching your wallet or its balance.
        </p>
      </form>
    </div>
  );
}
