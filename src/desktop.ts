// Desktop (Tauri) bootstrap: point the SPA at the EMBEDDED walletd.
//
// The desktop shell runs zkas-walletd in-process on a random loopback port with
// a per-install token. Before the app renders, fetch that config and install it
// where the SPA already looks (localStorage walletd_base / wallet_token) — the
// rest of the UI then needs zero desktop-specific code.

export interface DesktopConfig {
  base: string;
  token: string;
  wallet_bearer: string | null;
  network: string;
  mode: string; // "remote" | "custom" | "local"
  node_addr: string;
  node_binary: string | null;
  node_running: boolean;
}

/** True when running inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Fetch the embedded daemon's address+token and install them for the SPA. */
/// A wallet service the user deliberately chose INSTEAD of the embedded daemon —
/// today that means the Tor onion service.
///
/// It needs its own key because `initDesktop()` rewrites `walletd_base` from the
/// Tauri shell on every boot: without a persistent record of the user's choice,
/// connecting over Tor would work until the next restart and then silently snap
/// back to the embedded daemon — the worst kind of privacy failure, because the UI
/// would still be showing what the user picked.
const REMOTE_KEY = "desktop_remote_base";

export function desktopRemoteBase(): string {
  try {
    return localStorage.getItem(REMOTE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setDesktopRemoteBase(url: string): void {
  try {
    if (url.trim()) localStorage.setItem(REMOTE_KEY, url.trim().replace(/\/$/, ""));
    else localStorage.removeItem(REMOTE_KEY);
  } catch {
    /* best effort */
  }
}

export async function initDesktop(): Promise<DesktopConfig | null> {
  if (!isDesktop()) return null;
  const cfg = await invoke<DesktopConfig>("wallet_config");
  // Honour a deliberate remote choice (Tor) over the embedded daemon's address.
  const remote = desktopRemoteBase();
  localStorage.setItem("walletd_base", remote || cfg.base);
  if (cfg.wallet_bearer) localStorage.setItem("walletd_bearer", cfg.wallet_bearer);
  else localStorage.removeItem("walletd_bearer");
  // The shell's token is the FIRST wallet, not the only one. Writing it on every
  // boot clobbered whichever wallet the user had switched to — the embedded
  // daemon serves any token, so the app's choice is the one that counts.
  if (!localStorage.getItem("wallet_token")) localStorage.setItem("wallet_token", cfg.token);
  return cfg;
}

/** Switch node source (restarts the embedded daemon; wallet data is untouched). */
/// Picking a node means using the embedded daemon again, so any remote (Tor)
/// override must be dropped — otherwise the app would keep talking to the onion
/// while the UI showed a node selection.
export async function setNodeSource(
  mode: "remote" | "custom" | "local",
  nodeAddr?: string,
  nodeBinary?: string,
): Promise<DesktopConfig> {
  const cfg = await invoke<DesktopConfig>("set_node_source", {
    mode,
    nodeAddr: nodeAddr ?? null,
    nodeBinary: nodeBinary ?? null,
  });
  setDesktopRemoteBase("");
  localStorage.setItem("walletd_base", cfg.base);
  if (cfg.wallet_bearer) localStorage.setItem("walletd_bearer", cfg.wallet_bearer);
  else localStorage.removeItem("walletd_bearer");
  return cfg;
}

// ---------------------------------------------------------------------------
// Vault: the seed is encrypted at rest with a passphrase the app never stores.
//
// The embedded daemon does not run until the user unlocks — it cannot decrypt
// the seed without the passphrase, and a wallet that boots straight into a
// spendable state is a wallet a stolen laptop spends.

export type VaultState = "missing" | "plaintext" | "encrypted" | "watchonly";

export interface VaultStatus {
  state: VaultState;
  unlocked: boolean;
}

export function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>("vault_status");
}

/** Unlock an existing wallet and start the daemon. Rejects a wrong passphrase. */
export async function unlockVault(passphrase: string): Promise<DesktopConfig> {
  const cfg = await invoke<DesktopConfig>("unlock", { passphrase });
  localStorage.setItem("walletd_base", cfg.base);
  if (cfg.wallet_bearer) localStorage.setItem("walletd_bearer", cfg.wallet_bearer);
  else localStorage.removeItem("walletd_bearer");
  // Same rule as initDesktop: the shell token is the FIRST wallet, not the only
  // one. Unlocking restarted the daemon but changed nothing about which wallet
  // the user had selected — writing it here switched them back to wallet #1 on
  // every unlock.
  if (!localStorage.getItem("wallet_token")) localStorage.setItem("wallet_token", cfg.token);
  return cfg;
}

/** Set the passphrase: encrypts an existing cleartext wallet in place. */
export async function setPassphrase(passphrase: string): Promise<DesktopConfig> {
  const cfg = await invoke<DesktopConfig>("set_passphrase", { passphrase });
  localStorage.setItem("walletd_base", cfg.base);
  if (cfg.wallet_bearer) localStorage.setItem("walletd_bearer", cfg.wallet_bearer);
  else localStorage.removeItem("walletd_bearer");
  // Preserve the active wallet, exactly like unlockVault — encrypting at rest is
  // not a wallet switch.
  if (!localStorage.getItem("wallet_token")) localStorage.setItem("wallet_token", cfg.token);
  return cfg;
}

/** Forget the passphrase and stop the daemon. */
export function lockVault(): Promise<void> {
  return invoke<void>("lock_wallet");
}

export interface BackupInfo {
  path: string;
  folder: string;
}

/**
 * Write an encrypted backup of the seed, under a passphrase chosen for the FILE
 * (not the device unlock passphrase — this file is meant to travel).
 */
export function backupWallet(backupPassphrase: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("backup_wallet", { backupPassphrase });
}

/** Restore from a backup file and unlock with the new device passphrase. */
export async function restoreBackup(
  path: string,
  backupPassphrase: string,
  passphrase: string,
): Promise<DesktopConfig> {
  const cfg = await invoke<DesktopConfig>("restore_backup", { path, backupPassphrase, passphrase });
  localStorage.setItem("walletd_base", cfg.base);
  if (cfg.wallet_bearer) localStorage.setItem("walletd_bearer", cfg.wallet_bearer);
  else localStorage.removeItem("walletd_bearer");
  localStorage.setItem("wallet_token", cfg.token);
  return cfg;
}

/** Backup files this app has written, newest first. */
export function listBackups(): Promise<string[]> {
  return invoke<string[]>("list_backups");
}

/** Reveal a folder in the OS file manager (handled shell-side). */
export function openPath(path: string): Promise<void> {
  return invoke<void>("reveal_path", { path });
}

/** Write an app-encrypted backup document to the backup folder (desktop only). */
export function writeBackupFile(contents: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("write_backup", { contents });
}

/** Read a backup file's raw contents; the app decrypts it. */
export function readBackupFile(path: string): Promise<string> {
  return invoke<string>("read_backup_file", { path });
}

/**
 * Delete this device's wallet (file + scan state) and restart the daemon empty.
 * Irreversible here; the coins remain on-chain and return with the seed or a
 * backup. Callers must warn before calling.
 */
export function forgetWallet(token?: string): Promise<DesktopConfig> {
  return invoke<DesktopConfig>("forget_wallet", { token: token ?? null });
}
