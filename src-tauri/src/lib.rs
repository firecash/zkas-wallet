//! ZKas desktop wallet shell.
//!
//! Embeds `zkas-walletd` (the same shielded engine behind wallet.zkas.info) as an
//! in-process library, bound to a random loopback port with a per-install token —
//! fully non-custodial: seed files live in this machine's app-data dir and never
//! leave it. The React wallet UI (the `dist/` bundle) talks to it over HTTP
//! exactly as the hosted wallet does, so one UI serves web, mobile and desktop.
//!
//! Node connectivity is a user choice (see [`Settings`]):
//! - `remote` (default): ZKas's public node — lightweight, no local chain.
//! - `custom`: any reachable node's gRPC (host:port), e.g. one on the LAN.
//! - `local`: a node binary this app spawns and supervises (`node_binary`).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// ZKas's public node gRPC (VPS1, exposed via socat). The default for the
/// lightweight install: no local chain, wallet scans through this node.
const DEFAULT_REMOTE_NODE: &str = "185.147.157.125:16110";
/// Our public P2P entry — handed to a spawned local node so it can join the
/// network (release binaries ship with no DNS seeders).
const PUBLIC_PEER: &str = "185.147.157.125:16111";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "remote" | "custom" | "local"
    pub mode: String,
    /// gRPC host:port used in `custom` mode.
    pub node_addr: String,
    /// Path to a `zkas-node` binary used in `local` mode.
    pub node_binary: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { mode: "remote".into(), node_addr: DEFAULT_REMOTE_NODE.into(), node_binary: None }
    }
}

impl Settings {
    fn rpc_addr(&self) -> String {
        match self.mode.as_str() {
            "custom" => self.node_addr.clone(),
            "local" => "127.0.0.1:16110".into(),
            _ => DEFAULT_REMOTE_NODE.into(),
        }
    }
}

/// The embedded daemon plus the optional supervised local node.
struct Engine {
    /// Tokio runtime the daemon lives on (tauri's own async runtime is not ours
    /// to block; the walletd sync loops want a real multi-thread runtime).
    rt: tokio::runtime::Runtime,
    port: u16,
    token: String,
    settings: Settings,
    config_dir: PathBuf,
    data_dir: PathBuf,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    node_child: Option<std::process::Child>,
    /// The wallet passphrase, held in memory ONLY between unlock and lock. It is
    /// never written anywhere: the daemon uses it to decrypt the seed at load,
    /// and `lock()` drops it and stops the daemon. Nothing on disk can be turned
    /// back into a spending key without the user typing this again.
    secret: Option<String>,
}

/// The user's Documents folder, without pulling in a `dirs` dependency for one
/// lookup. Falls back to `None` when the platform gives us nothing usable, and
/// the caller then writes into the app data dir instead.
fn dirs_documents() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Documents"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        // XDG first (a localized or relocated Documents dir), then the common default.
        if let Some(d) = std::env::var_os("XDG_DOCUMENTS_DIR") {
            return Some(PathBuf::from(d));
        }
        let home = PathBuf::from(std::env::var_os("HOME")?);
        let docs = home.join("Documents");
        Some(if docs.is_dir() { docs } else { home })
    }
}

impl Engine {
    fn new(config_dir: PathBuf, data_dir: PathBuf) -> Self {
        let settings = std::fs::read(config_dir.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let token = Self::load_or_create_token(&config_dir);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(8) // see zkas-walletd: oversubscribed so HTTP never starves behind scans
            .enable_all()
            .build()
            .expect("tokio runtime");
        Self { rt, port: 0, token, settings, config_dir, data_dir, shutdown: None, node_child: None, secret: None }
    }

    /// The wallet token doubles as the wallet FILENAME on disk, so it must be
    /// stable across launches — persist it beside the settings.
    fn load_or_create_token(config_dir: &PathBuf) -> String {
        let path = config_dir.join("wallet-token");
        if let Ok(t) = std::fs::read_to_string(&path) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
        use rand::Rng;
        let token: String =
            rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(32).map(char::from).collect();
        let _ = std::fs::create_dir_all(config_dir);
        let _ = std::fs::write(&path, &token);
        token
    }

    fn save_settings(&self) {
        let _ = std::fs::create_dir_all(&self.config_dir);
        let _ = std::fs::write(self.config_dir.join("settings.json"), serde_json::to_vec_pretty(&self.settings).unwrap());
    }

    /// Start (or restart) the embedded walletd against the current node source.
    fn start_walletd(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(()); // graceful: serve() aborts its loops and returns
        }
        // A fresh loopback port each (re)start avoids TIME_WAIT collisions.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        self.port = port;

        let cfg = zkas_walletd::Config {
            rpc_server: self.settings.rpc_addr(),
            listen: format!("127.0.0.1:{port}").parse().unwrap(),
            wallet_dir: self.data_dir.join("wallets").to_string_lossy().into_owned(),
            network: "mainnet".into(),
            // The webview's origin is not 127.0.0.1, so CORS must admit it.
            allow_origin: vec![
                "tauri://localhost".into(),
                "http://tauri.localhost".into(),
                "https://tauri.localhost".into(),
            ],
            allow_default_token: false,
            // The passphrase the user unlocked with. `None` only in the
            // pre-passphrase (plaintext) case, which the UI pushes users off.
            wallet_secret: self.secret.clone(),
        };
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown = Some(tx);
        self.rt.spawn(async move {
            if let Err(e) = zkas_walletd::serve(cfg, rx).await {
                // eprintln (not just log): must be visible even if no logger is up.
                eprintln!("[zkas-desktop] embedded walletd stopped: {e}");
            }
        });
        eprintln!("[zkas-desktop] embedded walletd on 127.0.0.1:{port} -> node {}", self.settings.rpc_addr());
    }

    /// Spawn the user-provided node binary (`local` mode) and supervise it for
    /// the app's lifetime. The chain lives under the app's data dir.
    fn start_local_node(&mut self) -> Result<(), String> {
        if self.node_child.is_some() {
            return Ok(());
        }
        let bin = self.settings.node_binary.clone().ok_or("no node binary configured")?;
        if !std::path::Path::new(&bin).exists() {
            return Err(format!("node binary not found at {bin}"));
        }
        let appdir = self.data_dir.join("node");
        let child = std::process::Command::new(&bin)
            .arg(format!("--appdir={}", appdir.to_string_lossy()))
            .arg("--rpclisten=127.0.0.1:16110")
            .arg("--utxoindex")
            .arg(format!("--addpeer={PUBLIC_PEER}"))
            .spawn()
            .map_err(|e| format!("failed to start node: {e}"))?;
        self.node_child = Some(child);
        Ok(())
    }

    fn stop_local_node(&mut self) {
        if let Some(mut c) = self.node_child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    fn wallet_dir(&self) -> String {
        self.data_dir.join("wallets").to_string_lossy().into_owned()
    }

    /// Where backups are written: the user's Documents folder when there is one
    /// (somewhere they can actually find and copy to a USB stick), else the app
    /// data dir as a fallback.
    fn backup_dir(&self) -> PathBuf {
        dirs_documents().unwrap_or_else(|| self.data_dir.clone()).join("ZKas Wallet Backups")
    }

    fn vault(&self) -> zkas_walletd::VaultState {
        zkas_walletd::vault_state(&self.wallet_dir(), &self.token)
    }

    /// Stop the daemon and forget the passphrase. After this the on-disk seed is
    /// ciphertext and this process holds nothing that can spend.
    fn lock(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        self.secret = None;
        self.port = 0;
    }
}

#[derive(Serialize)]
struct WalletConfig {
    /// Where the UI reaches the embedded daemon.
    base: String,
    /// The per-install wallet token (X-Wallet-Token header).
    token: String,
    network: String,
    mode: String,
    node_addr: String,
    node_binary: Option<String>,
    node_running: bool,
}

fn config_of(e: &Engine) -> WalletConfig {
    WalletConfig {
        base: format!("http://127.0.0.1:{}", e.port),
        token: e.token.clone(),
        network: "mainnet".into(),
        mode: e.settings.mode.clone(),
        node_addr: e.settings.node_addr.clone(),
        node_binary: e.settings.node_binary.clone(),
        node_running: e.node_child.is_some(),
    }
}

#[tauri::command]
fn wallet_config(state: tauri::State<'_, Mutex<Engine>>) -> WalletConfig {
    config_of(&state.lock().unwrap())
}

/// What the lock screen must render: whether a wallet exists, whether its seed
/// is encrypted, and whether this session is currently unlocked.
#[derive(Serialize)]
struct VaultStatus {
    /// "missing" | "plaintext" | "encrypted" | "watchonly"
    state: zkas_walletd::VaultState,
    /// Daemon running with a passphrase in hand.
    unlocked: bool,
}

#[tauri::command]
fn vault_status(state: tauri::State<'_, Mutex<Engine>>) -> VaultStatus {
    let e = state.lock().unwrap();
    VaultStatus { state: e.vault(), unlocked: e.port != 0 }
}

/// Unlock with `passphrase` and start the daemon.
///
/// The passphrase is verified against the stored ciphertext BEFORE the daemon
/// starts, so a wrong one is a clean error rather than a daemon that comes up
/// unable to load the wallet and reports an empty balance — which would read
/// exactly like "my money is gone".
#[tauri::command]
fn unlock(state: tauri::State<'_, Mutex<Engine>>, passphrase: String) -> Result<WalletConfig, String> {
    let mut e = state.lock().unwrap();
    let dir = e.wallet_dir();
    match e.vault() {
        zkas_walletd::VaultState::Missing => return Err("no wallet on this device yet".into()),
        zkas_walletd::VaultState::Encrypted => {
            if !zkas_walletd::verify_wallet_secret(&dir, &e.token, &passphrase) {
                return Err("wrong passphrase".into());
            }
        }
        // Nothing to verify against; the daemon just runs with the secret so any
        // wallet CREATED from here on is written encrypted.
        zkas_walletd::VaultState::Plaintext | zkas_walletd::VaultState::WatchOnly => {}
    }
    e.secret = Some(passphrase);
    e.start_walletd();
    Ok(config_of(&e))
}

/// Set the passphrase for a device that has none yet: encrypt an existing
/// cleartext wallet in place, or simply arm the daemon so a wallet created next
/// is written encrypted. Idempotent for an already-encrypted wallet.
#[tauri::command]
fn set_passphrase(state: tauri::State<'_, Mutex<Engine>>, passphrase: String) -> Result<WalletConfig, String> {
    if passphrase.chars().count() < 8 {
        return Err("passphrase must be at least 8 characters".into());
    }
    let mut e = state.lock().unwrap();
    let dir = e.wallet_dir();
    if e.vault() == zkas_walletd::VaultState::Plaintext {
        // Stop the daemon first: it holds this wallet open, and the rewrite must
        // not race a checkpoint write.
        e.lock();
        zkas_walletd::encrypt_wallet_in_place(&dir, &e.token, &passphrase)?;
    }
    e.secret = Some(passphrase);
    e.start_walletd();
    Ok(config_of(&e))
}

/// Drop the passphrase and stop the daemon — the wallet is ciphertext again.
#[tauri::command]
fn lock_wallet(state: tauri::State<'_, Mutex<Engine>>) {
    state.lock().unwrap().lock();
}

/// Open a folder in the OS file manager, so "your backup is at …" can be a
/// button rather than a path the user has to go hunting for.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(cmd).arg(&path).spawn().map_err(|e| format!("cannot open {path}: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
struct BackupInfo {
    path: String,
    /// The containing folder, so the UI can offer to open it.
    folder: String,
}

/// Write an encrypted backup of the seed to the user's Documents folder (or the
/// app data dir if there is none), under a passphrase chosen for the FILE.
///
/// A separate backup passphrase is deliberate: the file is meant to leave this
/// machine — USB stick, cloud drive, password manager — and reusing the daily
/// unlock secret for something that travels is how one compromise becomes two.
#[tauri::command]
fn backup_wallet(state: tauri::State<'_, Mutex<Engine>>, backup_passphrase: String) -> Result<BackupInfo, String> {
    let e = state.lock().unwrap();
    let json = zkas_walletd::export_backup(&e.wallet_dir(), &e.token, e.secret.as_deref(), &backup_passphrase)?;
    let folder = e.backup_dir();
    std::fs::create_dir_all(&folder).map_err(|err| format!("cannot create backup folder: {err}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = folder.join(format!("zkas-wallet-backup-{stamp}.json"));
    std::fs::write(&path, json).map_err(|err| format!("cannot write backup: {err}"))?;
    // Owner-only: the file is encrypted, but there is no reason to leave it
    // world-readable in a shared home directory either.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(BackupInfo { path: path.to_string_lossy().into_owned(), folder: folder.to_string_lossy().into_owned() })
}

/// Write a backup document produced by the APP (client-side encryption of the
/// seed this device holds) into the backup folder.
///
/// The daemon-side `backup_wallet` above covers wallets whose seed walletd
/// holds; this covers the non-custodial case, which is the default — the seed
/// lives in the webview, so only the app can encrypt it.
#[tauri::command]
fn write_backup(state: tauri::State<'_, Mutex<Engine>>, contents: String) -> Result<BackupInfo, String> {
    let folder = state.lock().unwrap().backup_dir();
    std::fs::create_dir_all(&folder).map_err(|e| format!("cannot create backup folder: {e}"))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = folder.join(format!("zkas-wallet-backup-{stamp}.json"));
    std::fs::write(&path, contents).map_err(|e| format!("cannot write backup: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(BackupInfo { path: path.to_string_lossy().into_owned(), folder: folder.to_string_lossy().into_owned() })
}

/// Read a backup file back (the app decrypts it — the shell never sees a key).
#[tauri::command]
fn read_backup_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))
}

/// Restore a wallet from a backup file, then unlock with the new device
/// passphrase. Only possible when this device has no wallet — the library
/// refuses to clobber one.
#[tauri::command]
fn restore_backup(
    state: tauri::State<'_, Mutex<Engine>>,
    path: String,
    backup_passphrase: String,
    passphrase: String,
) -> Result<WalletConfig, String> {
    let mut e = state.lock().unwrap();
    let json = std::fs::read_to_string(&path).map_err(|err| format!("cannot read {path}: {err}"))?;
    let dir = e.wallet_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("cannot create wallet folder: {err}"))?;
    zkas_walletd::import_backup(&dir, &e.token, &json, &backup_passphrase, &passphrase)?;
    e.secret = Some(passphrase);
    e.start_walletd();
    Ok(config_of(&e))
}

/// Backup files this app has written, newest first — so restore can offer a
/// list instead of asking a user to type a path.
#[tauri::command]
fn list_backups(state: tauri::State<'_, Mutex<Engine>>) -> Vec<String> {
    let dir = state.lock().unwrap().backup_dir();
    let mut found: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("zkas-wallet-backup-") && n.ends_with(".json"))
        })
        .collect();
    found.sort();
    found.reverse();
    found.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Switch the node source. Restarts the embedded daemon against the new node;
/// wallet files and scan checkpoints are untouched (they key off the token).
#[tauri::command]
fn set_node_source(
    state: tauri::State<'_, Mutex<Engine>>,
    mode: String,
    node_addr: Option<String>,
    node_binary: Option<String>,
) -> Result<WalletConfig, String> {
    let mut e = state.lock().unwrap();
    if !matches!(mode.as_str(), "remote" | "custom" | "local") {
        return Err("mode must be remote | custom | local".into());
    }
    e.settings.mode = mode;
    if let Some(a) = node_addr {
        e.settings.node_addr = a;
    }
    if let Some(b) = node_binary {
        e.settings.node_binary = if b.trim().is_empty() { None } else { Some(b) };
    }
    e.save_settings();
    if e.settings.mode == "local" {
        e.start_local_node()?;
    } else {
        e.stop_local_node();
    }
    e.start_walletd();
    Ok(config_of(&e))
}

pub fn run() {
    kaspa_core::log::try_init_logger("info");
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir().expect("app config dir");
            let data_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&config_dir).ok();
            std::fs::create_dir_all(&data_dir).ok();
            let mut engine = Engine::new(config_dir, data_dir);
            if engine.settings.mode == "local" {
                // Best effort at launch; surfaced in the UI via node_running.
                if let Err(e) = engine.start_local_node() {
                    log::warn!("local node not started: {e}");
                }
            }
            // NB: the daemon is NOT started here. It only runs once the user has
            // supplied the passphrase (`unlock` / `set_passphrase`), because it
            // cannot decrypt the seed without one — and a wallet that boots
            // straight into a spendable state is a wallet a stolen laptop spends.
            // The one exception is a legacy cleartext wallet, which the UI
            // unlocks with an empty passphrase and then prompts to encrypt.
            // Start now for the states that need no passphrase to load a wallet:
            // a legacy cleartext wallet, and a WATCH-ONLY one (the non-custodial
            // default — the daemon holds only a viewing key, the seed lives in
            // the app). Only an encrypted seed file must wait for `unlock`.
            if matches!(engine.vault(), zkas_walletd::VaultState::Plaintext | zkas_walletd::VaultState::WatchOnly) {
                engine.start_walletd();
            }
            app.manage(Mutex::new(engine));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<Mutex<Engine>>() {
                    state.lock().unwrap().stop_local_node();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            wallet_config,
            set_node_source,
            vault_status,
            unlock,
            set_passphrase,
            lock_wallet,
            backup_wallet,
            restore_backup,
            list_backups,
            reveal_path,
            write_backup,
            read_backup_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
