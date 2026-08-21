// One-time "what's new" for EXISTING users on update.
//
// Fresh installs learn about connection + privacy in the first-run screen. But an
// existing wallet skips first-run (it already chose a server long ago), so without
// this it would silently gain Tor, server choice and accent colors and never know.
// Shown once, gated by a version key; closing (or acting) sets the flag.

import { useState } from "react";

const SEEN_KEY = "whatsnew_seen_v1_0_17";

/** Whether to show the update notice: an existing wallet that hasn't seen it. A
 * fresh install has no wallet history yet and gets the first-run screen instead. */
export function shouldShowWhatsNew(hasWalletHistory: boolean): boolean {
  try {
    return hasWalletHistory && !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}

export function WhatsNew({ onClose }: { onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    onClose();
  };
  const openPrivacy = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    // Land in Settings; the Network privacy card is there.
    location.hash = "#/?tab=settings";
    onClose();
  };
  return (
    <div className="modalwrap" onClick={dismiss}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <span className="eyebrow">New in this version</span>
        <h2 style={{ margin: "6px 0 12px" }}>Private by choice</h2>
        <div className="whatsnew-list">
          <div><b>🧅 Connect over Tor</b><span className="muted small">Hide your IP from the wallet service. One tap in Network privacy (needs Orbot).</span></div>
          <div><b>🔌 Choose your server</b><span className="muted small">Public, your own, or Tor — and nothing is contacted until you pick.</span></div>
          <div><b>🎨 Accent colors</b><span className="muted small">Make it yours under Settings → Accent color.</span></div>
        </div>
        <div className="row" style={{ marginTop: 16, gap: 10 }}>
          <button className="btn ghost" onClick={dismiss}>Got it</button>
          <button className="btn" onClick={openPrivacy}>Network privacy</button>
        </div>
      </div>
    </div>
  );
}
