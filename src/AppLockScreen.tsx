// The unlock screen for a device whose seed is sealed behind a PIN/passphrase.
//
// Deliberately the whole screen with nothing behind it: while locked, the app
// holds no spending key at all (see applock.ts), so there is nothing to show and
// nothing to be tricked into revealing.

import { useState } from "react";
import { lockKind, unlock } from "./applock";

export function AppLockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
          Forgotten it? There is nothing to reset — the {label.toLowerCase()} is never stored or sent anywhere. Restore
          this wallet from its seed phrase or a backup file instead.
        </p>
      </form>
    </div>
  );
}
