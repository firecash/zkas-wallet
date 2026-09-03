// First-run connection choice for mobile & web (the desktop equivalent is
// FirstRunNode, which picks a *node* for the embedded daemon).
//
// PRIVACY-FIRST: the app contacts NO server before the user chooses one. On
// mobile the wallet used to mount straight onto the hosted daemon and poll it —
// so a fresh install's first act told the server "someone at this IP just opened
// a ZKas wallet". This screen is the gate: it renders with zero network activity
// and only touches a server when the user TAPS a choice.
//
// One tap connects. Public and Tor are single taps; "my own" reveals a field.
// It also carries the appearance choice (theme + accent) up front.

import { useState } from "react";
import { markNodeChoiceMade } from "./FirstRunNode";
import { findReachableDaemon, setBase, setWalletdBearer, normalizeDaemonInput, isNative } from "./api";
import { walletdProfiles } from "./connection-profiles";
import { ACCENTS, currentAccent, setAccent, type Accent } from "./theme";
import { ONION_WALLETD_URL } from "./lib/relay";
import { OrbotHelp } from "./OrbotHelp";
import { embeddedAvailable, setEmbeddedChosen, ensureEmbedded } from "./embedded";
import { RunOnPhoneOption } from "./RunOnPhoneOption";
import { showAccessTokenField } from "./lib/accesstoken";

export function FirstRunConnect({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState<null | "public" | "tor" | "custom" | "phone">(null);
  const [showCustom, setShowCustom] = useState(false);
  const [addr, setAddr] = useState("");
  const [bearer, setBearer] = useState("");
  const [err, setErr] = useState("");
  const [needTor, setNeedTor] = useState(false);

  // Accent, applied live (localStorage + CSS only — never a network call).
  const [accent, setAcc] = useState<Accent>(currentAccent());
  const chooseAccent = (a: Accent) => { setAccent(a); setAcc(a); };

  const finish = () => { markNodeChoiceMade(); onDone(); };

  // The default. Clearing the override resolves getBase() to the hosted daemon.
  // No request here — the wallet contacts it once it mounts, which IS proceeding.
  const connectPublic = () => {
    if (busy) return;
    setBase(""); setWalletdBearer(""); finish();
  };

  const connectPhone = async (node?: string, tor?: boolean) => {
    if (busy) return;
    setErr(""); setBusy("phone");
    try {
      const url = await ensureEmbedded(node, tor);
      setEmbeddedChosen(true);
      setBase(url); setWalletdBearer("");
      finish();
    } catch (e) {
      setEmbeddedChosen(false);
      setErr((e as Error).message || "The on-device engine could not start on this phone.");
      setBusy(null);
    }
  };
  const connectTor = async () => {
    if (busy) return;
    setErr(""); setNeedTor(false); setBusy("tor");
    try {
      const url = await findReachableDaemon(ONION_WALLETD_URL, "", 20_000);
      setBase(url); setWalletdBearer(""); finish();
    } catch {
      // The onion is only reachable when a Tor transport is up. Show the Orbot
      // steps instead of a raw fetch error.
      setNeedTor(true);
      setBusy(null);
    }
  };

  const connectCustom = async () => {
    if (busy) return;
    const entered = addr.trim();
    if (!entered) return setErr("Enter the address of your wallet service (host:port, or an .onion).");
    setErr(""); setBusy("custom");
    try {
      const url = await findReachableDaemon(entered, bearer);
      setBase(url); setWalletdBearer(bearer.trim());
      walletdProfiles.save(hostLabel(entered), url, bearer.trim() || undefined);
      finish();
    } catch (e) {
      setErr((e as Error).message || String(e));
      setBusy(null);
    }
  };

  return (
    <div className="lockwrap">
      <div className="card lockcard firstrun">
        <h2 style={{ marginTop: 0 }}>Set up your wallet</h2>
        <p className="muted small">
          Nothing leaves this device until you tap. Pick where your wallet connects.
        </p>

        <span className="eyebrow">Connect</span>
        <div className="connection-list firstrun-conn">
          {embeddedAvailable() && (
            <RunOnPhoneOption busy={!!busy} starting={busy === "phone"} onStart={(n, t) => connectPhone(n, t)} />
          )}
          <button className="connection-option" disabled={!!busy} onClick={connectPublic}>
            <span><b>Public wallet service</b><small>Fastest. Works instantly, nothing to install.</small></span>
            <span>{busy === "public" ? "…" : "Use"}</span>
          </button>

          <button className="connection-option" disabled={!!busy} onClick={() => void connectTor()}>
            <span><b>Connect over Tor</b><small>Hides your IP from the service. Needs Orbot (VPN) on Android.</small></span>
            <span>{busy === "tor" ? "Connecting…" : "Use"}</span>
          </button>

          <button className="connection-option" disabled={!!busy} onClick={() => { setShowCustom((v) => !v); setErr(""); }}>
            <span><b>My own wallet service</b><small>Most private. A <code>zkas-walletd</code> you run yourself.</small></span>
            <span>{showCustom ? "▲" : "▾"}</span>
          </button>

          {showCustom && (
            <div className="connection-add firstrun-custom">
              <input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder={isNative() ? "host:port, http://<lan-ip>:8501, or an .onion" : "https://your-walletd or an .onion"}
                disabled={busy === "custom"}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
              />
              {showAccessTokenField() && (
                <input
                  value={bearer}
                  onChange={(e) => setBearer(e.target.value)}
                  placeholder="Access token"
                  disabled={busy === "custom"}
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                />
              )}
              <button className="btn small" disabled={busy === "custom"} onClick={() => void connectCustom()}>
                {busy === "custom" ? "Connecting…" : "Connect"}
              </button>
            </div>
          )}
        </div>

        {err && <div className="msg err">{err}</div>}
        {needTor && <OrbotHelp />}

        <span className="eyebrow" style={{ marginTop: 14 }}>Accent color</span>
        <div className="swatches">
          {(Object.keys(ACCENTS) as Accent[]).map((opt) => (
            <button
              key={opt}
              type="button"
              className={"swatch" + (accent === opt ? " on" : "")}
              style={{ ["--sw" as string]: ACCENTS[opt].base }}
              onClick={() => chooseAccent(opt)}
              aria-label={ACCENTS[opt].label}
              aria-pressed={accent === opt}
              title={ACCENTS[opt].label}
              disabled={!!busy}
            >
              <span className="swatch-dot" />
            </button>
          ))}
        </div>

        <p className="muted small" style={{ marginTop: 12 }}>
          You can change any of this later in Settings, without touching your wallet or its balance.
        </p>
      </div>
    </div>
  );
}

/// A short, human name for a saved custom service, derived from its host.
function hostLabel(entered: string): string {
  try {
    const u = new URL(normalizeDaemonInput(entered) || entered);
    return u.hostname || "My service";
  } catch {
    return entered.split("/")[0]?.split(":")[0] || "My service";
  }
}
