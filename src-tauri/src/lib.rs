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
        Self { rt, port: 0, token, settings, config_dir, data_dir, shutdown: None, node_child: None }
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
            wallet_secret: None,
        };
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown = Some(tx);
        self.rt.spawn(async move {
            if let Err(e) = zkas_walletd::serve(cfg, rx).await {
                log::error!("embedded walletd stopped: {e}");
            }
        });
        log::info!("embedded walletd on 127.0.0.1:{port} -> node {}", self.settings.rpc_addr());
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
            engine.start_walletd();
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
        .invoke_handler(tauri::generate_handler![wallet_config, set_node_source])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
