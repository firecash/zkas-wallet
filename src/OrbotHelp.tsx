// Shown when "Connect over Tor" cannot reach the onion — which almost always
// means no Tor transport is running, not that anything is broken.
//
// The wallet bundles no Tor client, so what the user must do differs completely
// by platform. Telling a desktop user to install an Android app (as this once
// did) is worse than saying nothing: it reads as "this feature is not for you".

import { isNative } from "./api";
import { isDesktop } from "./desktop";
import { ONION_WALLETD_URL, ORBOT_PLAY_URL } from "./lib/relay";

/// The onion origin without the /daemon suffix — the address a Tor Browser user
/// can open directly to get the whole wallet over Tor.
const ONION_SITE = ONION_WALLETD_URL.replace(/\/daemon\/?$/, "");

export function OrbotHelp() {
  if (isNative()) {
    return (
      <div className="orbot-help">
        <b>Tor needs Orbot</b>
        <p className="muted small" style={{ margin: "4px 0 8px" }}>
          The wallet reaches the onion through Orbot, the free Tor app. It isn't running:
        </p>
        <ol className="orbot-steps">
          <li>Install Orbot.</li>
          <li>Open it and turn on <b>VPN mode</b>.</li>
          <li>Come back and tap <b>Connect over Tor</b> again.</li>
        </ol>
        <a className="btn small ghost" href={ORBOT_PLAY_URL} target="_blank" rel="noreferrer">Get Orbot</a>
      </div>
    );
  }

  if (isDesktop()) {
    return (
      <div className="orbot-help">
        <b>Tor isn't running on this computer</b>
        {/* This used to say the app had no Tor client and needed the SYSTEM to
            route through Tor — which is a far bigger ask than it needs to be, and
            wrong since the shell started speaking SOCKS itself. Running Tor
            Browser is enough, and is how most people on Windows and macOS have
            Tor at all. */}
        <p className="muted small" style={{ margin: "4px 0 8px" }}>
          The wallet connects through Tor's own SOCKS port, so nothing has to be
          routed system-wide — Tor just has to be running. Start the Tor service,
          or simply open Tor Browser and leave it open, then try again.
        </p>
        <p className="muted small" style={{ margin: "0 0 8px" }}>
          It looks on <code>127.0.0.1:9050</code> (Tor service) and{" "}
          <code>127.0.0.1:9150</code> (Tor Browser).
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          For privacy without Tor, run your own node from the <b>Node</b> page — then nobody else sees what you ask.
        </p>
      </div>
    );
  }

  // Plain browser: the realistic path is Tor Browser, and the whole wallet is
  // served on the onion, so they can just open it there.
  return (
    <div className="orbot-help">
      <b>Open this wallet in Tor Browser</b>
      <p className="muted small" style={{ margin: "4px 0 8px" }}>
        An ordinary browser cannot reach an <code>.onion</code> address. The whole wallet is served over Tor — open
        it in Tor Browser at:
      </p>
      <div className="addr" style={{ marginBottom: 8 }}>{ONION_SITE}</div>
      <p className="muted small" style={{ margin: 0 }}>Your keys stay on your device either way.</p>
    </div>
  );
}
