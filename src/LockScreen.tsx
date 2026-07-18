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
import { listBackups, restoreBackup, setPassphrase, unlockVault, vaultStatus, type VaultState } from "./desktop";

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
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
      if (pass.length < 8) return setError("Use at least 8 characters.");
      if (pass !== confirm) return setError("The two passphrases do not match.");
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
          <p className="muted small">Starting…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lockwrap">
      <form className="card lockcard" onSubmit={submit}>
        <h2>{unlocking ? "Unlock your wallet" : "Protect your wallet"}</h2>

        {unlocking ? (
          <p className="muted small" style={{ marginTop: 0 }}>
            Your seed is encrypted on this device. Enter your passphrase to unlock it.
          </p>
        ) : state === "plaintext" ? (
          <p className="muted small" style={{ marginTop: 0 }}>
            This wallet's seed is currently stored <b>unencrypted</b> on this computer — anyone with access to the file
            could spend your funds. Set a passphrase now and it will be encrypted in place. Your balance and history are
            not affected.
          </p>
        ) : (
          <p className="muted small" style={{ marginTop: 0 }}>
            Choose a passphrase. It encrypts your wallet's seed on this computer, so the files left on disk are useless
            to anyone who copies them.
          </p>
        )}

        <label>Passphrase</label>
        <input
          type="password"
          value={pass}
          autoFocus
          onChange={(e) => setPass(e.target.value)}
          placeholder={unlocking ? "Your passphrase" : "At least 8 characters"}
        />

        {!unlocking && (
          <>
            <label>Confirm passphrase</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type it again" />
          </>
        )}

        {error && <div className="msg err">{error}</div>}

        <button className="btn" type="submit" disabled={busy || !pass}>
          {busy ? (unlocking ? "Unlocking…" : "Encrypting…") : unlocking ? "Unlock" : "Set passphrase"}
        </button>

        {!unlocking && (
          <p className="muted small" style={{ marginTop: 12 }}>
            There is no way to reset this passphrase — it is never sent anywhere and never stored. If you forget it, the
            only way back into this wallet is your seed phrase or a backup file, so keep one of those safe.
          </p>
        )}

        {state === "missing" && (
          <p className="muted small" style={{ marginTop: 12 }}>
            Already have a backup file?{" "}
            <a
              href="#"
              onClick={(ev) => {
                ev.preventDefault();
                setRestoring(true);
              }}
            >
              Restore from backup
            </a>
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
    if (!path.trim()) return setError("Choose a backup file.");
    if (devicePass.length < 8) return setError("The device passphrase needs at least 8 characters.");
    if (devicePass !== confirm) return setError("The two device passphrases do not match.");
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
        <h2>Restore from backup</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Open an encrypted backup file and set it up on this computer.
        </p>

        {found.length > 0 && (
          <>
            <label>Backups found on this computer</label>
            <select value={path} onChange={(e) => setPath(e.target.value)}>
              {found.map((f) => (
                <option key={f} value={f}>
                  {f.split(/[/\\]/).pop()}
                </option>
              ))}
            </select>
          </>
        )}

        <label>{found.length > 0 ? "…or paste a path" : "Path to your backup file"}</label>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/zkas-wallet-backup-….json" />

        <label>Backup file passphrase</label>
        <input type="password" value={filePass} onChange={(e) => setFilePass(e.target.value)} placeholder="The passphrase you gave the file" />

        <label>New passphrase for this computer</label>
        <input type="password" value={devicePass} onChange={(e) => setDevicePass(e.target.value)} placeholder="At least 8 characters" />
        <label>Confirm</label>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type it again" />

        {error && <div className="msg err">{error}</div>}

        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Restoring…" : "Restore wallet"}
        </button>
        <button className="btn ghost small" type="button" style={{ marginTop: 8 }} onClick={onCancel} disabled={busy}>
          Back
        </button>
        <p className="muted small" style={{ marginTop: 12 }}>
          Your balance rebuilds from the chain after restoring — this takes a minute or two.
        </p>
      </form>
    </div>
  );
}
