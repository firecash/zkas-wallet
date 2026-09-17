// The desktop lock screen: the app's front door when the seed is encrypted.
//
// Why this exists: the wallet's spending key lives on this machine. Without a
// passphrase it sat on disk in cleartext, so a stolen laptop, a synced home
// directory, or any process running as the user could spend the funds. The seed
// is now encrypted (Argon2 + XChaCha20-Poly1305) and the embedded daemon does
// not even start until the passphrase decrypts it — so a locked wallet holds
// nothing spendable in memory or on disk.
//
// The passphrase is never persisted anywhere. Losing it means the seed phrase is
// the only way back in, which is exactly what the copy here has to say plainly.

import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { listBackups, restoreBackup, setPassphrase, unlockVault, vaultStatus, type VaultState } from "./desktop";

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<VaultState | null>(null);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    vaultStatus()
      .then((v) => setState(v.state))
      .catch((e) => setError(String(e)));
  }, []);

  // "encrypted" asks for the existing passphrase; everything else is setting one
  // for the first time (a fresh install, or a legacy cleartext wallet we are
  // about to encrypt in place).
  const unlocking = state === "encrypted";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!unlocking) {
      if (pass.length < 8) return setError(t("lockScreen.errMinLength"));
      if (pass !== confirm) return setError(t("lockScreen.errMismatch"));
    }
    setBusy(true);
    try {
      if (unlocking) await unlockVault(pass);
      else await setPassphrase(pass);
      setPass("");
      setConfirm("");
      onUnlocked();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // A device with no wallet can restore one from a backup file — the reason the
  // backup exists. Offered here (not buried in settings) because this screen is
  // exactly where someone lands on a new or reinstalled machine.
  if (restoring) return <RestoreFromBackup onDone={onUnlocked} onCancel={() => setRestoring(false)} />;

  if (state === null) {
    return (
      <div className="lockwrap">
        <div className="card lockcard">
          <p className="muted small">{t("lockScreen.starting")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lockwrap">
      <form className="card lockcard" onSubmit={submit}>
        <h2>{unlocking ? t("lockScreen.unlockTitle") : t("lockScreen.protectTitle")}</h2>

        {unlocking ? (
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("lockScreen.unlockIntro")}
          </p>
        ) : state === "plaintext" ? (
          <p className="muted small" style={{ marginTop: 0 }}>
            <Trans i18nKey="lockScreen.plaintextIntro" components={{ b: <b /> }} />
          </p>
        ) : (
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("lockScreen.chooseIntro")}
          </p>
        )}

        <label>{t("lockScreen.passphraseLabel")}</label>
        <input
          type="password"
          value={pass}
          autoFocus
          onChange={(e) => setPass(e.target.value)}
          placeholder={unlocking ? t("lockScreen.yourPassphrase") : t("lockScreen.atLeast8")}
        />

        {!unlocking && (
          <>
            <label>{t("lockScreen.confirmLabel")}</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={t("lockScreen.typeAgain")} />
          </>
        )}

        {error && <div className="msg err">{error}</div>}

        <button className="btn" type="submit" disabled={busy || !pass}>
          {busy ? (unlocking ? t("lockScreen.unlocking") : t("lockScreen.encrypting")) : unlocking ? t("lockScreen.unlock") : t("lockScreen.setPassphrase")}
        </button>

        {!unlocking && (
          <p className="muted small" style={{ marginTop: 12 }}>
            {t("lockScreen.noReset")}
          </p>
        )}

        {state === "missing" && (
          <p className="muted small" style={{ marginTop: 12 }}>
            <Trans
              i18nKey="lockScreen.haveBackup"
              components={{
                a: (
                  <a
                    href="#"
                    onClick={(ev) => {
                      ev.preventDefault();
                      setRestoring(true);
                    }}
                  />
                ),
              }}
            />
          </p>
        )}
      </form>
    </div>
  );
}

/// Restore a wallet from an encrypted backup file: the file's passphrase to open
/// it, then a passphrase for this device going forward. The two are separate on
/// purpose — see `BackupWallet`.
function RestoreFromBackup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [found, setFound] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [filePass, setFilePass] = useState("");
  const [devicePass, setDevicePass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listBackups()
      .then((b) => {
        setFound(b);
        if (b.length > 0) setPath(b[0]);
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!path.trim()) return setError(t("restoreFromBackup.errChooseFile"));
    if (devicePass.length < 8) return setError(t("restoreFromBackup.errDeviceMin"));
    if (devicePass !== confirm) return setError(t("restoreFromBackup.errDeviceMismatch"));
    setBusy(true);
    try {
      await restoreBackup(path.trim(), filePass, devicePass);
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lockwrap">
      <form className="card lockcard" onSubmit={submit}>
        <h2>{t("restoreFromBackup.title")}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("restoreFromBackup.intro")}
        </p>

        {found.length > 0 && (
          <>
            <label>{t("restoreFromBackup.foundLabel")}</label>
            <select value={path} onChange={(e) => setPath(e.target.value)}>
              {found.map((f) => (
                <option key={f} value={f}>
                  {f.split(/[/\\]/).pop()}
                </option>
              ))}
            </select>
          </>
        )}

        <label>{found.length > 0 ? t("restoreFromBackup.orPastePath") : t("restoreFromBackup.pathLabel")}</label>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t("restoreFromBackup.pathPlaceholder")} />

        <label>{t("restoreFromBackup.filePassLabel")}</label>
        <input type="password" value={filePass} onChange={(e) => setFilePass(e.target.value)} placeholder={t("restoreFromBackup.filePassPlaceholder")} />

        <label>{t("restoreFromBackup.devicePassLabel")}</label>
        <input type="password" value={devicePass} onChange={(e) => setDevicePass(e.target.value)} placeholder={t("restoreFromBackup.atLeast8")} />
        <label>{t("restoreFromBackup.confirmLabel")}</label>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={t("restoreFromBackup.typeAgain")} />

        {error && <div className="msg err">{error}</div>}

        <button className="btn" type="submit" disabled={busy}>
          {busy ? t("restoreFromBackup.restoring") : t("restoreFromBackup.restoreWallet")}
        </button>
        <button className="btn ghost small" type="button" style={{ marginTop: 8 }} onClick={onCancel} disabled={busy}>
          {t("restoreFromBackup.back")}
        </button>
        <p className="muted small" style={{ marginTop: 12 }}>
          {t("restoreFromBackup.rebuildNote")}
        </p>
      </form>
    </div>
  );
}
