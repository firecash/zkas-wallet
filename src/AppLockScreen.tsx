// The unlock screen for a device whose seed is sealed behind a PIN/passphrase.
//
// Deliberately the whole screen with nothing behind it: while locked, the app
// holds no spending key at all (see applock.ts), so there is nothing to show and
// nothing to be tricked into revealing.

import { useEffect, useRef, useState } from "react";
import { lockKind, unlock } from "./applock";
import { enableBiometricUnlock, isBiometricAvailable, isBiometricConfigured, unlockWithBiometric } from "./biometric";
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
  // Whether to offer the fingerprint button (configured AND hardware present).
  const [bioReady, setBioReady] = useState(false);
  // Hardware is present but the user has not turned fingerprint on yet — drives the
  // one-tap "enable it now?" nudge shown to existing users right after they type the PIN.
  const [bioOfferable, setBioOfferable] = useState(false);
  // Showing that nudge (the app is already unlocked underneath — this just gates entry
  // for one screen while we ask). Holds the just-verified secret to bind without re-entry.
  const [showOffer, setShowOffer] = useState(false);
  const verifiedSecret = useRef<string | null>(null);
  const kind = lockKind();
  const label = kind === "pin" ? "PIN" : "Passphrase";

  const tryBiometric = async () => {
    setError("");
    setBusy(true);
    try {
      if (await unlockWithBiometric()) {
        onUnlocked();
      }
      // A cancel or failure is silent: the passphrase field is right there.
    } finally {
      setBusy(false);
    }
  };

  // On mount, figure out which biometric affordance applies:
  //   - configured + available -> auto-prompt once, and show the "Use fingerprint" button;
  //   - available but NOT configured -> arm the post-unlock enable nudge (unless dismissed).
  const autoPrompted = useRef(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!(await isBiometricAvailable())) return;
      if (!alive) return;
      if (isBiometricConfigured()) {
        setBioReady(true);
        if (!autoPrompted.current) {
          autoPrompted.current = true;
          void tryBiometric();
        }
      } else if (localStorage.getItem("bio_offer_dismissed") !== "1") {
        setBioOfferable(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (await unlock(secret)) {
        // Existing user, fingerprint-capable but not set up: offer it in one tap using
        // the secret they JUST proved, so upgrading costs no Settings trip and no
        // re-typing. Otherwise go straight in.
        if (bioOfferable) {
          verifiedSecret.current = secret;
          setSecret("");
          setShowOffer(true);
        } else {
          setSecret("");
          onUnlocked();
        }
      } else {
        // Deliberately not "wrong PIN, 3 tries left": there is no lockout to
        // count down to. The seal is the protection, and it does not weaken.
        setError(`That ${label.toLowerCase()} does not unlock this wallet.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const acceptOffer = async () => {
    setBusy(true);
    try {
      // Binds with a live fingerprint scan (see enableBiometricUnlock). If the scan is
      // cancelled it simply enters without enabling — the PIN unlock already succeeded.
      await enableBiometricUnlock(verifiedSecret.current ?? "");
    } finally {
      verifiedSecret.current = null;
      setBusy(false);
      onUnlocked();
    }
  };

  const declineOffer = () => {
    // Respect "not now" — don't nag on every open. Settings can still enable it later.
    localStorage.setItem("bio_offer_dismissed", "1");
    verifiedSecret.current = null;
    onUnlocked();
  };

  if (showOffer) {
    return (
      <div className="lockwrap">
        <div className="card lockcard">
          <h2 style={{ marginTop: 0 }}>Unlock faster next time?</h2>
          <p className="muted small">
            Use your fingerprint to open ZKas instead of typing your {label.toLowerCase()}. Your {label.toLowerCase()}{" "}
            still works and is what secures your keys — the fingerprint just unlocks the app on this device, and it never
            leaves the phone.
          </p>
          <button className="btn" onClick={acceptOffer} disabled={busy}>
            {busy ? "Setting up…" : "Enable fingerprint"}
          </button>
          <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={declineOffer} disabled={busy}>
            Not now
          </button>
        </div>
      </div>
    );
  }

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
        {bioReady && (
          <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={tryBiometric} disabled={busy}>
            Use fingerprint
          </button>
        )}
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
