// First-run connection choice for mobile & web (the desktop equivalent is
// FirstRunNode, which picks a *node* for the embedded daemon).
//
// PRIVACY-FIRST: the app must contact NO server before the user has chosen one.
// On mobile/web the wallet used to mount straight onto the hosted daemon and
// start polling it immediately — so the very first thing a fresh install did was
// tell wallet.zkas.info "someone at this IP just opened a ZKas wallet", before
// the user agreed to anything. This screen is the gate: it renders with zero
// network activity and only touches a server when the user taps Continue on a
// choice they made. Until then, nothing leaves the device.
//
// It also carries the appearance choice (theme + accent), so personalization is
// offered up front rather than buried in Settings.

import { useState } from "react";
import { markNodeChoiceMade } from "./FirstRunNode";
import {
  findReachableDaemon,
  setBase,
  setWalletdBearer,
  normalizeDaemonInput,
  isNative,
} from "./api";
import { walletdProfiles } from "./connection-profiles";
import {
  ACCENTS,
  currentAccent,
  currentTheme,
  setAccent,
  setTheme,
  type Accent,
  type Theme,
} from "./theme";
import { PRIVATE_RELAY_URL } from "./lib/relay";

type ServerChoice = "hosted" | "relay" | "custom";

export function FirstRunConnect({ onDone }: { onDone: () => void }) {
  const [choice, setChoice] = useState<ServerChoice>("hosted");
  const [addr, setAddr] = useState("");
  const [bearer, setBearer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Appearance, applied live (localStorage + CSS only — never a network call).
  const [theme, setTh] = useState<Theme>(currentTheme());
  const [accent, setAcc] = useState<Accent>(currentAccent());
  const chooseTheme = (t: Theme) => { setTheme(t); setTh(t); };
  const chooseAccent = (a: Accent) => { setAccent(a); setAcc(a); };

  const relayConfigured = !!PRIVATE_RELAY_URL;

  const finish = () => {
    markNodeChoiceMade();
    onDone();
  };

  const proceed = async () => {
    setErr("");
    if (choice === "hosted") {
      // The default. Clearing any override makes getBase() resolve to the hosted
      // daemon. No request here: the wallet will contact it once it mounts —
      // which is the user proceeding, exactly as intended.
      setBase("");
      setWalletdBearer("");
      finish();
      return;
    }
    if (choice === "relay") {
      setBusy(true);
      try {
        const url = await findReachableDaemon(PRIVATE_RELAY_URL);
        setBase(url);
        setWalletdBearer("");
        finish();
      } catch (e) {
        setErr((e as Error).message || String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    // Custom: only now, on an explicit choice + tap, do we touch the network.
    const entered = addr.trim();
    if (!entered) return setErr("Enter the address of your wallet service (host:port).");
    setBusy(true);
    try {
      const url = await findReachableDaemon(entered, bearer);
      setBase(url);
      setWalletdBearer(bearer.trim());
      walletdProfiles.save(hostLabel(entered), url, bearer.trim() || undefined);
      finish();
    } catch (e) {
      setErr((e as Error).message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lockwrap">
      <form
        className="card lockcard firstrun"
        onSubmit={(e) => { e.preventDefault(); void proceed(); }}
      >
        <h2 style={{ marginTop: 0 }}>Set up your wallet</h2>
        <p className="muted small">
          Nothing has left this device yet. Choose where your wallet connects — the app contacts no server until you
          continue. Whatever you pick, your balance and payments stay shielded; the server you choose only sees that
          <i> someone</i> at your address is asking about the chain.
        </p>

        <span className="eyebrow">Connection</span>

        <label className="choice">
          <input type="radio" checked={choice === "hosted"} onChange={() => setChoice("hosted")} disabled={busy} />
          <span><b>Public wallet service</b> — recommended. Works instantly, nothing to install.</span>
        </label>

        {relayConfigured && (
          <label className="choice">
            <input type="radio" checked={choice === "relay"} onChange={() => setChoice("relay")} disabled={busy} />
            <span><b>Private relay</b> — routes through a relay so the wallet service never sees your IP address.</span>
          </label>
        )}

        <label className="choice">
          <input type="radio" checked={choice === "custom"} onChange={() => setChoice("custom")} disabled={busy} />
          <span><b>My own wallet service</b> — a <code>zkas-walletd</code> you run yourself. Most private.</span>
        </label>
        {choice === "custom" && (
          <>
            <input
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder={isNative() ? "host:port or http://<lan-ip>:8501" : "https://your-walletd"}
              disabled={busy}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <input
              value={bearer}
              onChange={(e) => setBearer(e.target.value)}
              placeholder="Access token (optional)"
              disabled={busy}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="muted small" style={{ marginTop: 6 }}>
              Tip: enter a <code>.onion</code> address to reach your service over Tor — the server never learns your
              IP. Needs a Tor transport on this device (Orbot's VPN on Android, or Tor running on desktop).
            </p>
          </>
        )}

        <span className="eyebrow" style={{ marginTop: 6 }}>Appearance</span>
        <div className="filterbar" style={{ marginBottom: 12 }}>
          {(["dark", "light", "system"] as Theme[]).map((opt) => (
            <button
              key={opt}
              type="button"
              className={"chip" + (theme === opt ? " on" : "")}
              onClick={() => chooseTheme(opt)}
              disabled={busy}
            >
              {opt === "dark" ? "Dark" : opt === "light" ? "Light" : "System"}
            </button>
          ))}
        </div>
        <div className="swatches" style={{ marginBottom: 4 }}>
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
              disabled={busy}
            >
              <span className="swatch-dot" />
            </button>
          ))}
        </div>

        {err && <div className="msg err">{err}</div>}

        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Continue"}
        </button>
        <p className="muted small" style={{ marginTop: 10 }}>
          You can change any of this later in Settings, without touching your wallet or its balance.
        </p>
      </form>
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
