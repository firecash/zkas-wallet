// Shown when a "Connect over Tor" attempt can't reach the onion — almost always
// because no Tor transport is up on the device. We bundle no Tor client, so the
// wallet reaches the onion only when Orbot (or another Tor) is routing. Say that
// plainly, with the exact steps, rather than a bare connection error.

import { ORBOT_PLAY_URL } from "./lib/relay";

export function OrbotHelp() {
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
