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
use std::sync::{Mutex, MutexGuard};
use tauri::Manager;

/// Where the crash log lives: the app's data dir, computed WITHOUT the Tauri
/// runtime so the panic hook can reach it even if the app dies before (or
/// while) Tauri is up. Mirrors Tauri's identifier-based layout.
fn crash_log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    Some(base?.join("info.zkas.wallet"))
}

/// Append one line to crash.log. Best-effort by design: a desktop user reports
/// "it crashed" with nothing else — this file is the only witness, because the
/// Windows build has no console (`windows_subsystem = "windows"`).
fn log_crash(msg: &str) {
    if let Some(dir) = crash_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut f) =
            std::fs::OpenOptions::new().create(true).append(true).open(dir.join("crash.log"))
        {
            use std::io::Write;
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
    eprintln!("[zkas-desktop] {msg}");
}

/// Lock the engine, RECOVERING from poison. A panic anywhere while the lock was
/// held used to poison it and turn every later command into another panic — one
/// fault became "the app crashes from now on". The engine's state is plain data
/// that is safe to keep using; log it and carry on.
fn engine(m: &Mutex<Engine>) -> MutexGuard<'_, Engine> {
    m.lock().unwrap_or_else(|poisoned| {
        log_crash("engine lock was poisoned by an earlier panic; recovering");
        poisoned.into_inner()
    })
}

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
        // A bind failure (firewall software gone wild, loopback misconfigured)
        // must not panic the app: leave port 0 — the UI shows "cannot reach the
        // wallet daemon" and crash.log says why.
        let port = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(l) => match l.local_addr() {
                Ok(a) => a.port(),
                Err(e) => {
                    log_crash(&format!("cannot read loopback address for wallet engine: {e}"));
                    self.port = 0;
                    return;
                }
            },
            Err(e) => {
                log_crash(&format!("cannot bind a loopback port for wallet engine: {e}"));
                self.port = 0;
                return;
            }
        };
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
                // crash.log, not just stderr: the Windows build has no console.
                log_crash(&format!("embedded walletd stopped: {e}"));
            }
        });
        log_crash(&format!("embedded walletd on 127.0.0.1:{port} -> node {}", self.settings.rpc_addr()));
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
    config_of(&engine(&state))
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
    let e = engine(&state);
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
    let mut e = engine(&state);
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
    let mut e = engine(&state);
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
    engine(&state).lock();
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
    let e = engine(&state);
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
    let folder = engine(&state).backup_dir();
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
    let mut e = engine(&state);
    let json = std::fs::read_to_string(&path).map_err(|err| format!("cannot read {path}: {err}"))?;
    let dir = e.wallet_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("cannot create wallet folder: {err}"))?;
    zkas_walletd::import_backup(&dir, &e.token, &json, &backup_passphrase, &passphrase)?;
    e.secret = Some(passphrase);
    e.start_walletd();
    Ok(config_of(&e))
}

/// Forget the wallet on this device: stop the daemon, delete its wallet file and
/// scan checkpoint, then restart the daemon empty so the app offers onboarding.
///
/// Destructive and irreversible from this machine's point of view — the caller
/// MUST have warned that funds are unreachable afterwards without a backup or
/// seed phrase. The chain is untouched: the coins still exist, and restoring the
/// seed anywhere brings them back.
#[tauri::command]
fn forget_wallet(state: tauri::State<'_, Mutex<Engine>>, token: Option<String>) -> Result<WalletConfig, String> {
    let mut e = engine(&state);
    e.lock(); // stop the daemon so nothing rewrites the files we are removing
    let dir = e.wallet_dir();
    // Delete the wallet the UI is REMOVING, which is not necessarily this
    // shell's own. The device can hold several wallets and the app decides which
    // is active; using the shell's token here deleted wallet #1 whenever the
    // user removed any other one.
    let token = token.unwrap_or_else(|| e.token.clone());
    let _ = std::fs::remove_file(format!("{dir}/{token}.json"));
    let _ = std::fs::remove_file(format!("{dir}/{token}.scan"));
    let _ = std::fs::remove_file(format!("{dir}/{token}.scan.bak"));
    // Rotate the token as well. It is the wallet's identity everywhere — the
    // filename on disk AND the key every per-wallet cache in the UI hangs off
    // (status cache, device seed, contacts). Keeping it meant the NEXT wallet
    // inherited the removed one's cached identity and appeared to be the same
    // wallet coming back from the dead.
    // Only rotate the shell's own identity when it is the one being removed;
    // rotating it while deleting some other wallet would strand the shell's.
    if token == e.token {
        let _ = std::fs::remove_file(e.config_dir.join("wallet-token"));
        e.token = Engine::load_or_create_token(&e.config_dir);
    }
    e.secret = None;
    e.start_walletd();
    Ok(config_of(&e))
}

/// Backup files this app has written, newest first — so restore can offer a
/// list instead of asking a user to type a path.
#[tauri::command]
fn list_backups(state: tauri::State<'_, Mutex<Engine>>) -> Vec<String> {
    let dir = engine(&state).backup_dir();
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
    let mut e = engine(&state);
    if !matches!(mode.as_str(), "remote" | "custom" | "local") {
        return Err("mode must be remote | custom | local".into());
    }
    if let Some(a) = node_addr {
        // People paste URLs. The gRPC dialer wants bare host:port and prefixes
        // its own scheme, so "grpc://x" became "grpc://grpc://x" — which never
        // connects and never errors. Normalize, and refuse what can't work.
        let a = a.trim().trim_end_matches('/');
        let a = ["grpc://", "http://", "https://"]
            .iter()
            .find_map(|s| a.strip_prefix(s))
            .unwrap_or(a)
            .to_string();
        if mode == "custom" {
            let host_port_ok =
                a.rsplit_once(':').map(|(h, p)| !h.is_empty() && p.parse::<u16>().is_ok()).unwrap_or(false);
            if !host_port_ok {
                return Err(format!("node address must be host:port, e.g. 127.0.0.1:16110 (got \"{a}\")"));
            }
        }
        e.settings.node_addr = a;
    }
    e.settings.mode = mode;
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
    // Any panic, on any thread, leaves a trace in crash.log before the default
    // hook runs. Without this, a Windows crash is a window that just vanishes.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        log_crash(&format!("panic: {info}\n{bt}"));
        default_hook(info);
    }));
    log_crash(&format!("app start v{}", env!("CARGO_PKG_VERSION")));
    tauri::Builder::default()
        // Single instance MUST be first: a second launch (Windows double-click
        // races make this routine) would otherwise start a second embedded
        // walletd writing the same wallet and scan files as the first — a
        // corruption/crash factory. Instead, focus the window already open.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.webview_windows().values().next() {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
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
            // Start the engine unless there is an ENCRYPTED seed file that needs a
            // passphrase first. Everything else — no wallet yet, a legacy cleartext
            // wallet, or the watch-only default where the daemon holds only a
            // viewing key — needs no secret to run and must not be gated.
            //
            // This previously listed only Plaintext and WatchOnly, which left
            // `Missing` out and so BROKE EVERY FRESH INSTALL: with no wallet the
            // engine never started, the UI had nothing to talk to, and the app
            // showed "the wallet engine didn't start" with no way to reach
            // onboarding and create one. A device with no wallet has no secret to
            // protect and is exactly when the engine is needed most.
            if engine.vault() != zkas_walletd::VaultState::Encrypted {
                engine.start_walletd();
            }
            app.manage(Mutex::new(engine));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<Mutex<Engine>>() {
                    engine(&state).stop_local_node();
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
            read_backup_file,
            forget_wallet
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
