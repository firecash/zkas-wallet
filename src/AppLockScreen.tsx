// The unlock screen for a device whose seed is sealed behind a PIN/passphrase.
//
// Deliberately the whole screen with nothing behind it: while locked, the app
// holds no spending key at all (see applock.ts), so there is nothing to show and
// nothing to be tricked into revealing.

import { useEffect, useRef, useState } from "react";
import { LanguageButton } from "./LanguagePicker";
import { useTranslation, Trans } from "react-i18next";
import { lockKind, unlock } from "./applock";
import { enableBiometricUnlock, isBiometricAvailable, isBiometricConfigured, unlockWithBiometric } from "./biometric";
import { listWallets } from "./wallets";
import { wipeWalletState } from "./walletstate";

export function AppLockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation();
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
  const label = kind === "pin" ? t("appLockScreen.pin") : t("appLockScreen.passphrase");
  // The in-sentence form ("pin" / "passphrase"): a separate catalogue entry rather
  // than label.toLowerCase(), which is not how every language derives it.
  const secretWord = kind === "pin" ? t("appLockScreen.pinLower") : t("appLockScreen.passphraseLower");

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
        setError(t("appLockScreen.wrongSecret", { secret: secretWord }));
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
      <LanguageButton compact />
        <div className="card lockcard">
          <h2 style={{ marginTop: 0 }}>{t("appLockScreen.offerTitle")}</h2>
          <p className="muted small">
            {t("appLockScreen.offerBody", { secret: secretWord })}
          </p>
          <button className="btn" onClick={acceptOffer} disabled={busy}>
            {busy ? t("appLockScreen.settingUp") : t("appLockScreen.enableFingerprint")}
          </button>
          <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={declineOffer} disabled={busy}>
            {t("appLockScreen.notNow")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lockwrap">
      <LanguageButton compact />
      <form className="card lockcard" onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>{t("appLockScreen.title")}</h2>
        <p className="muted small">
          {t("appLockScreen.intro", { secret: secretWord })}
        </p>
        <label>{label}</label>
        <input
          type="password"
          inputMode={kind === "pin" ? "numeric" : "text"}
          value={secret}
          autoFocus
          onChange={(e) => setSecret(e.target.value)}
          placeholder={kind === "pin" ? t("appLockScreen.yourPin") : t("appLockScreen.yourPassphrase")}
        />
        {error && <div className="msg err">{error}</div>}
        <button className="btn" type="submit" disabled={busy || !secret}>
          {busy ? t("appLockScreen.unlocking") : t("appLockScreen.unlock")}
        </button>
        {bioReady && (
          <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={tryBiometric} disabled={busy}>
            {t("appLockScreen.useFingerprint")}
          </button>
        )}
        <p className="muted small" style={{ marginTop: 12 }}>
          {t("appLockScreen.forgotten", { secret: secretWord })}
        </p>
        {!askWipe ? (
          <button type="button" className="linkbtn" style={{ marginTop: 6 }} onClick={() => setAskWipe(true)}>
            {t("appLockScreen.forgotLink", { secret: secretWord })}
          </button>
        ) : (
          <div className="msg warn" style={{ marginTop: 10 }}>
            <Trans i18nKey="appLockScreen.wipeWarning" components={{ b: <b /> }} />
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
                  // The master phrase, its plaintext-fallback flag, the wallet
                  // registry and the account counter are device-wide, not per
                  // wallet, so the per-wallet sweep above leaves them behind —
                  // and "erase this device" that keeps the recovery phrase is not
                  // an erase.
                  for (const k of ["device_mnemonic", "mnemonic_unsealed", "wallets_v1", "account_high_water"]) localStorage.removeItem(k);
                  location.reload();
                }}
              >
                {t("appLockScreen.eraseDevice")}
              </button>
              <button type="button" className="btn ghost small" onClick={() => setAskWipe(false)}>
                {t("appLockScreen.cancel")}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
