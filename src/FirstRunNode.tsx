// First-run connection choice (desktop only).
//
// A wallet is only as private as the service it asks about its own coins: whoever
// serves the blocks sees which IP is asking for them, and a hosted wallet service
// sees the viewing key too. So the choice is put in front of the user once, at
// first launch, rather than buried in settings — with the engine on this
// computer preselected, because it is the one where nothing leaves the machine.
//
// The same four options as the in-app Chain-source dialog (App.tsx connectHosted
// / connectTor / switchDesktop): this screen used to offer only the two embedded-
// engine choices, and called the public-node one "works immediately" — which is
// what sent fresh installs to a wallet stuck on "Found 0 ZKAS so far" for the
// length of a first chain scan. The hosted service is the one that is ready at
// once, and it belongs here as much as on the phone's first-run screen.
//
// Shown once. The answer is remembered, and the same options stay available
// afterwards under Settings → node source.

import { useEffect, useRef, useState } from "react";
import { findReachableDaemon, setBase, setWalletdBearer } from "./api";
import { setDesktopRemoteBase, setNodeSource } from "./desktop";
import { HOSTED_WALLETD_URL, ONION_WALLETD_URL } from "./lib/relay";
import { OrbotHelp } from "./OrbotHelp";
import { MANAGED_ZKAS_RPC } from "./ports";

const CHOSEN_KEY = "node_choice_made";

/** True when the user has not yet been asked which node to use. */
/// Both guarded: they run on the boot path, and a browser with site storage
/// blocked throws from the accessor itself. No record then means "not asked".
export function needsNodeChoice(): boolean {
  try {
    return !localStorage.getItem(CHOSEN_KEY);
  } catch {
    return true;
  }
}

export function markNodeChoiceMade() {
  try {
    localStorage.setItem(CHOSEN_KEY, "1");
  } catch {
    /* storage unavailable — the question is asked again next launch */
  }
}

// How long the user watches "Connecting…" before we offer a way out. The happy
// path resolves in ~1-2s; this only ever shows on a slow/blocked path to the
// node or a node that is momentarily at its connection limit.
const SKIP_AFTER_MS = 12_000;

type Mode = "hosted" | "remote" | "tor" | "custom";

export function FirstRunNode({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>("remote");
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Tor fails almost only because no Tor transport is up, so on failure show the
  // Tor steps rather than a bare connection error.
  const [torFailed, setTorFailed] = useState(false);
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
    setTorFailed(false);
    if (mode === "custom" && !addr.trim()) return setErr("Enter the address of your node (host:port).");
    setBusy(true);
    try {
      if (mode === "hosted" || mode === "tor") {
        // Mirrors connectHosted/connectTor in App.tsx, minus their reload: the
        // router has not mounted yet, so proceed() opens the wallet against the
        // base just set. Recorded as the desktop remote choice so it survives a
        // restart (the shell rewrites walletd_base on every boot otherwise).
        // setNodeSource is NOT used here — it would clear that record and point
        // the app back at the embedded engine.
        const url = await findReachableDaemon(mode === "tor" ? ONION_WALLETD_URL : HOSTED_WALLETD_URL, "", 20_000);
        // "Continue without connecting" promised the engine on this computer;
        // a probe that lands after it must not quietly repoint the open wallet.
        if (settled.current) return;
        setDesktopRemoteBase(url);
        setBase(url);
        setWalletdBearer("");
      } else {
        await setNodeSource(mode, addr.trim() || undefined);
      }
      proceed();
    } catch (e2) {
      // Suppressed once the user has already chosen to continue: the pending
      // call can reject after we have moved on, and that is not an error to show.
      if (settled.current) return;
      if (mode === "tor") setTorFailed(true);
      else setErr(String(e2));
    } finally {
      if (!settled.current) setBusy(false);
    }
  };

  return (
    <div className="lockwrap">
      <form className="card lockcard" onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>Choose how to connect</h2>
        <p className="muted small">
          Your keys stay on this computer whichever you pick, and your payments stay shielded on the chain. What
          differs is who can see your activity, and how soon your balance shows.
        </p>

        <label className="choice">
          <input type="radio" checked={mode === "remote"} onChange={() => setMode("remote")} disabled={busy} />
          <span>
            <b>This computer · public node</b> — runs the wallet here; nothing about your wallet leaves this
            computer. First sync scans the chain and takes a while.
          </span>
        </label>

        <label className="choice">
          <input type="radio" checked={mode === "hosted"} onChange={() => setMode("hosted")} disabled={busy} />
          <span>
            <b>Public service</b> — ready at once. The wallet service can see your transactions, not your keys.
          </span>
        </label>

        <label className="choice">
          <input type="radio" checked={mode === "tor"} onChange={() => setMode("tor")} disabled={busy} />
          <span>
            <b>Over Tor</b> — the public service, with your IP hidden. It still sees your transactions. Needs Tor
            running on this computer.
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
        {torFailed && <OrbotHelp />}

        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Continue"}
        </button>

        {busy && showSkip && (
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <p className="muted small" style={{ marginBottom: 6 }}>
              Still connecting — it may be slow or busy right now.
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
              Your wallet opens now on the engine on this computer. You can change how it connects under Settings.
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
