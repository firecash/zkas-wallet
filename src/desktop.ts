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
  /** The embedded daemon's recorded scan birthday for `token`; absent on older shells. */
  birthday?: number | null;
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

/// Point the app at the daemon it should be using after a shell operation.
///
/// The shell always reports the EMBEDDED daemon's address, so writing it blindly
/// (as unlock/set-passphrase/restore-backup all used to) silently dragged the user
/// back to the local daemon after they had deliberately chosen a remote one — Tor
/// included — while the UI still showed their choice. Unlocking the app was enough
/// to do it. A deliberate remote choice outranks the shell's default; only
/// `setNodeSource` clears it, because picking a node IS choosing the embedded one.
function applyDaemonBase(cfg: DesktopConfig): void {
  const remote = desktopRemoteBase();
  localStorage.setItem("walletd_base", remote || cfg.base);
  if (cfg.wallet_bearer) localStorage.setItem("walletd_bearer", cfg.wallet_bearer);
  else localStorage.removeItem("walletd_bearer");
  adoptShellBirthday(cfg);
}

/// The embedded daemon's wallet file is the one durable copy of the birthday a
/// desktop wallet has when the app's own record is missing (a wallet restored from
/// a backup through the shell, or created before birthdays were tracked). Without
/// it, switching to the public service or Tor re-registered the wallet there with
/// birthday 0 — a genesis scan of a wallet the desktop had fully synced. Written
/// under the SHELL's token (the first wallet, not necessarily the active one),
/// only when nothing is recorded yet, and never as 0. Kept out of lib/deviceseed
/// on purpose: api.ts imports this module, and deviceseed imports api.
function adoptShellBirthday(cfg: DesktopConfig): void {
  const birthday = Number(cfg.birthday ?? 0);
  if (!(Number.isFinite(birthday) && birthday > 0) || !cfg.token) return;
  try {
    const key = `birthday_${cfg.token}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, String(Math.floor(birthday)));
  } catch {
    /* best effort */
  }
}

export async function initDesktop(): Promise<DesktopConfig | null> {
  if (!isDesktop()) return null;
  const cfg = await invoke<DesktopConfig>("wallet_config");
  applyDaemonBase(cfg);
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
  applyDaemonBase(cfg);
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
  applyDaemonBase(cfg);
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
  applyDaemonBase(cfg);
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
  applyDaemonBase(cfg);
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

/// Where the desktop builds are published (the same repo `scripts/release.sh` tags).
const RELEASES_REPO = "firecash/zkas-wallet";

export interface DesktopUpdate {
  /// The newer release, e.g. "1.0.36".
  version: string;
  /// Its release page, with the downloads.
  url: string;
}

/// Is release `candidate` newer than `current`? Both are `x.y.z` or `x.y.z-suffix`
/// (release.sh tags `v1.0.36` and `v1.0.36-rc2`). A plain release outranks any
/// pre-release of the same triple; two pre-releases compare by their trailing
/// number. Anything unparsable is never "newer" — a banner must not appear over a
/// tag this rule cannot read.
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/);
    if (!m) return null;
    const pre = m[4] ? Number((m[4].match(/(\d+)$/) ?? ["", "0"])[1]) : null;
    return { triple: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.triple[i] !== b.triple[i]) return a.triple[i] > b.triple[i];
  }
  if (a.pre === null) return b.pre !== null;
  if (b.pre === null) return false;
  return a.pre > b.pre;
}

let updateCheck: Promise<DesktopUpdate | null> | null = null;

/**
 * A newer desktop release than this build, if GitHub lists one. Desktop only,
 * asked once per launch and remembered; the desktop app has no updater and no
 * other way of learning a version exists. Fetched from the WebView: GitHub's API
 * answers with `Access-Control-Allow-Origin: *` and the shell's CSP allows
 * `https:` connects, so no Rust relay is needed and nothing of the wallet's is
 * sent — a bare, anonymous GET. Any failure (offline, rate-limited) is "no
 * update", never an error on screen.
 */
export function checkForDesktopUpdate(currentVersion: string): Promise<DesktopUpdate | null> {
  if (!isDesktop()) return Promise.resolve(null);
  // A user who pointed the app at the Tor onion chose to show no IP to anyone; a
  // clearnet GET to GitHub from the WebView would undo that on every launch.
  if (desktopRemoteBase().toLowerCase().includes(".onion")) return Promise.resolve(null);
  if (!updateCheck) {
    updateCheck = (async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8_000);
        const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
          headers: { Accept: "application/vnd.github+json" },
          signal: ctl.signal,
        }).finally(() => clearTimeout(timer));
        if (!res.ok) return null;
        const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
        const tag = typeof data.tag_name === "string" ? data.tag_name : "";
        const version = tag.replace(/^v/, "");
        if (!version || !isNewerVersion(version, currentVersion)) return null;
        const url = typeof data.html_url === "string" && data.html_url.startsWith("https://github.com/")
          ? data.html_url
          : `https://github.com/${RELEASES_REPO}/releases/latest`;
        return { version, url };
      } catch {
        return null;
      }
    })();
  }
  return updateCheck;
}

/**
 * Delete this device's wallet (file + scan state) and restart the daemon empty.
 * Irreversible here; the coins remain on-chain and return with the seed or a
 * backup. Callers must warn before calling.
 */
export function forgetWallet(token?: string): Promise<DesktopConfig> {
  return invoke<DesktopConfig>("forget_wallet", { token: token ?? null });
}
