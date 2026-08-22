// One-time "what's new" for EXISTING users on update.
//
// Fresh installs learn about phrases and connection choices in the first-run
// screens. An existing wallet skips all of that, so without this it would silently
// gain recovery phrases, accounts and Tor and the user would never know. Shown
// once per release that needs it, gated by the version key below.

const SEEN_KEY = "whatsnew_seen_v1_0_17";

/** Whether to show the update notice: an existing wallet that hasn't seen it. */
export function shouldShowWhatsNew(hasWalletHistory: boolean): boolean {
  try {
    return hasWalletHistory && !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}

export function WhatsNew({ onClose }: { onClose: () => void }) {
  const dismiss = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    onClose();
  };
  const openSettings = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    location.hash = "#/?tab=settings";
    onClose();
  };
  return (
    <div className="modalwrap" onClick={dismiss}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <span className="eyebrow">New in 1.0.17</span>
        <h2 style={{ margin: "6px 0 12px" }}>Recovery phrases</h2>
        <div className="whatsnew-list">
          <div>
            <b>🔑 12-word phrase (BIP-39)</b>
            <span className="muted small">New wallets use a standard BIP-39 phrase instead of a 64-character seed. Your existing seed keeps working.</span>
          </div>
          <div>
            <b>🗂 Accounts</b>
            <span className="muted small">Add accounts from one phrase — one backup covers them all.</span>
          </div>
          <div>
            <b>🧅 Tor</b>
            <span className="muted small">Connect over an onion so the service never sees your IP.</span>
          </div>
        </div>
        <div className="row" style={{ marginTop: 16, gap: 10 }}>
          <button className="btn ghost" onClick={dismiss}>Got it</button>
          <button className="btn" onClick={openSettings}>Open settings</button>
        </div>
      </div>
    </div>
  );
}
