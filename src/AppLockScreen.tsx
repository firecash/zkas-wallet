// The unlock screen for a device whose seed is sealed behind a PIN/passphrase.
//
// Deliberately the whole screen with nothing behind it: while locked, the app
// holds no spending key at all (see applock.ts), so there is nothing to show and
// nothing to be tricked into revealing.

import { useState } from "react";
import { lockKind, unlock } from "./applock";
import { listWallets } from "./wallets";
import { wipeWalletState } from "./walletstate";

export function AppLockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Forgotten-secret escape hatch: a guarded erase-and-restore flow. Without it
  // the lock screen was a hard dead end — the promised "restore from your seed"
  // path sat behind the very screen blocking the app.
  const [askWipe, setAskWipe] = useState(false);
  const kind = lockKind();
  const label = kind === "pin" ? "PIN" : "Passphrase";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (await unlock(secret)) {
        setSecret("");
        onUnlocked();
      } else {
        // Deliberately not "wrong PIN, 3 tries left": there is no lockout to
        // count down to. The seal is the protection, and it does not weaken.
        setError(`That ${label.toLowerCase()} does not unlock this wallet.`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lockwrap">
      <form className="card lockcard" onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>Unlock ZKas</h2>
        <p className="muted small">
          Your wallet key is encrypted on this device. Enter your {label.toLowerCase()} to use it.
        </p>
        <label>{label}</label>
        <input
          type="password"
          inputMode={kind === "pin" ? "numeric" : "text"}
          value={secret}
          autoFocus
          onChange={(e) => setSecret(e.target.value)}
          placeholder={kind === "pin" ? "Your PIN" : "Your passphrase"}
        />
        {error && <div className="msg err">{error}</div>}
        <button className="btn" type="submit" disabled={busy || !secret}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <p className="muted small" style={{ marginTop: 12 }}>
          Forgotten it? There is nothing to reset — the {label.toLowerCase()} is never stored or sent anywhere. The
          only way back is restoring each wallet from its seed or a backup file.
        </p>
        {!askWipe ? (
          <button type="button" className="linkbtn" style={{ marginTop: 6 }} onClick={() => setAskWipe(true)}>
            Forgot {label.toLowerCase()}?
          </button>
        ) : (
          <div className="msg warn" style={{ marginTop: 10 }}>
            This erases every wallet's data <b>from this device</b> — the coins stay on-chain, but each wallet comes
            back only from its seed or backup file.
            <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  for (const w of listWallets()) wipeWalletState(w.token);
                  wipeWalletState(null);
                  // The sealed record is unrecoverable without the secret — that is
                  // the point of the lock — so the way out is erasing it too.
                  localStorage.removeItem("app_lock_v2");
                  location.reload();
                }}
              >
                Erase this device &amp; start over
              </button>
              <button type="button" className="btn ghost small" onClick={() => setAskWipe(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
