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
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tauri::Manager;
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::ManagerExt;

mod services;
use services::{InstallSelection, InstalledComponents, ProcessSpec, ServiceLog, ServiceManager};

/// Where the crash log lives: the app's data dir, computed WITHOUT the Tauri
/// runtime so the panic hook can reach it even if the app dies before (or
/// while) Tauri is up. Mirrors Tauri's identifier-based layout.
fn crash_log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base =
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
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
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("crash.log"))
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
/// The managed explorer API's fixed loopback port. It serves `/info/...`, `/blocks/...`
/// and so on — there is deliberately no page at the root, so a browser pointed at `/`
/// gets a 404 from a perfectly healthy service.
const EXPLORER_API_PORT: u16 = 8500;

const DEFAULT_REMOTE_NODE: &str = "185.147.157.125:16110";

/// Where a local Tor daemon listens for SOCKS connections. `socks5h` so the
/// PROXY resolves the hostname — a .onion has no DNS entry, so resolving it here
/// would fail, and resolving it locally would also leak the lookup.
const TOR_SOCKS_PROXY: &str = "socks5h://127.0.0.1:9050";

/// An HTTP client that reaches .onion services through the local Tor daemon.
///
/// The WebView cannot do this itself — it has no SOCKS support — which is why a
/// desktop user who chose Tor previously had every call answered by the LOCAL
/// engine while the UI showed Tor as connected. Built once and reused.
fn tor_client() -> Result<reqwest::Client, String> {
    static TOR: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    TOR.get_or_init(|| {
        let proxy = reqwest::Proxy::all(TOR_SOCKS_PROXY)
            .map_err(|e| format!("cannot use the Tor proxy at {TOR_SOCKS_PROXY}: {e}"))?;
        reqwest::Client::builder()
            .proxy(proxy)
            .build()
            .map_err(|e| format!("cannot build the Tor client: {e}"))
    })
    .clone()
}

/// Where a chosen remote wallet service lives, and how to reach it.
enum RemoteTarget {
    /// A .onion, which only the Tor SOCKS proxy can resolve.
    Tor(String),
    /// An ordinary HTTPS service, reached directly.
    Direct(String),
}

/// Resolve a remote wallet service address, refusing anything else.
///
/// Deliberately narrow, because this command is reachable from page script:
/// allowing an arbitrary base would turn the shell into a request forwarder
/// aimed at anything it can see, loopback and LAN included. HTTPS is allowed
/// anywhere because TLS authenticates the far end; plain HTTP only for .onion,
/// where Tor provides the same guarantee itself.
fn remote_target(base: &str, path: &str) -> Result<RemoteTarget, String> {
    let base = base.trim().trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("http://") {
        let host = rest.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
        if !host.ends_with(".onion") {
            return Err("a plain http:// wallet service is only allowed for .onion addresses".into());
        }
        return Ok(RemoteTarget::Tor(format!("{base}{path}")));
    }
    if base.starts_with("https://") {
        return Ok(RemoteTarget::Direct(format!("{base}{path}")));
    }
    Err("a wallet service must be an https:// address or a .onion service".into())
}
/// Our public P2P entry — handed to a spawned local node so it can join the
/// network (release binaries ship with no DNS seeders).
const PUBLIC_PEERS: [&str; 2] = ["185.147.157.125:16111", "160.187.211.153:16111"];
/// Managed nodes use the upstream defaults. Keeping ZKas on 16810 is also what
/// lets a local Kaspa parent use its normal 16110 port in dual-mining mode.
const LOCAL_ZKAS_RPC: &str = "127.0.0.1:16810";
const LOCAL_ZKAS_RPC_LAN: &str = "0.0.0.0:16810";
const LOCAL_ZKAS_P2P: &str = "0.0.0.0:16811";
const LOCAL_ZKAS_P2P_PRIVATE: &str = "127.0.0.1:16811";
const LOCAL_KASPA_RPC: &str = "127.0.0.1:16110";
const LOCAL_KASPA_P2P: &str = "0.0.0.0:16111";
const LOCAL_KASPA_P2P_PRIVATE: &str = "127.0.0.1:16111";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "remote" | "custom" | "local"
    pub mode: String,
    /// gRPC host:port used in `custom` mode.
    pub node_addr: String,
    /// Path to a `zkas-node` binary used in `local` mode.
    pub node_binary: Option<String>,
    /// Verified release installed by this app. Older settings have no marker,
    /// which intentionally makes the next desktop build offer an upgrade.
    pub node_release: Option<String>,
    /// `shielded` (pruned bodies + complete wallet history), `archival` (all
    /// bodies + complete history), or `mining` (pruned, no historical notes).
    pub node_preset: String,
    /// Accept inbound ZKas P2P connections.
    pub node_public_p2p: bool,
    /// Allow trusted LAN devices to use the managed node's unauthenticated gRPC.
    /// Internet RPC is never offered; public node access uses P2P instead.
    pub node_lan_rpc: bool,
    /// The managed process is independent of the wallet's selected RPC. This
    /// lets a node sync/mine while the wallet safely keeps using a public node.
    pub node_auto_start: bool,
    /// Installed direct-payout bridge and optional diagnostic CPU miner.
    pub bridge_binary: Option<String>,
    /// Verified solo-dual-mode release installed by this app. Missing markers
    /// are treated as legacy installs and upgraded before mining starts.
    pub bridge_release: Option<String>,
    pub miner_binary: Option<String>,
    /// Explorer REST backend shipped in the same verified ZKas release archive.
    pub explorer_binary: Option<String>,
    /// "disabled" | "local" | "custom" for the Kaspa parent in dual mode.
    pub kaspa_mode: String,
    pub kaspa_node_addr: String,
    pub kaspa_node_binary: Option<String>,
    pub kaspa_public_p2p: bool,
    pub kaspa_payout: String,
    /// ZKas work source for the Stratum bridge, independent of wallet RPC.
    pub mining_node_mode: String,
    pub mining_node_addr: String,
    pub stratum_port: u16,
    pub min_share_diff: f64,
    /// Resume mining when the app next launches. Set when mining starts, cleared when
    /// the user stops it, so it records INTENT: a machine that loses power comes back
    /// mining, one the user deliberately stopped does not.
    pub mining_auto_start: bool,
    /// Last direct-mining mode, used only when mining_auto_start is enabled.
    pub mining_mode: String,
    /// ZKAS address the last mining session paid to, needed to resume it. Only
    /// `kaspa_payout` was persisted, so a solo session had no address to come back to.
    pub mining_payout: String,
    /// "device" | "lan" | "wan". LAN/WAN bind the authenticated wallet API
    /// to all interfaces; WAN additionally requires an operator-supplied HTTPS
    /// URL because raw wallet traffic must never cross the internet.
    pub wallet_access: String,
    pub wallet_access_port: u16,
    pub wallet_public_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: "remote".into(),
            node_addr: DEFAULT_REMOTE_NODE.into(),
            node_binary: None,
            node_release: None,
            node_preset: "shielded".into(),
            node_public_p2p: false,
            node_lan_rpc: false,
            node_auto_start: false,
            bridge_binary: None,
            bridge_release: None,
            miner_binary: None,
            explorer_binary: None,
            kaspa_mode: "disabled".into(),
            kaspa_node_addr: LOCAL_KASPA_RPC.into(),
            kaspa_node_binary: None,
            kaspa_public_p2p: false,
            kaspa_payout: String::new(),
            mining_node_mode: "local".into(),
            mining_node_addr: LOCAL_ZKAS_RPC.into(),
            stratum_port: 5555,
            min_share_diff: 8192.0,
            mining_auto_start: false,
            mining_payout: String::new(),
            mining_mode: "solo".into(),
            wallet_access: "device".into(),
            wallet_access_port: 8501,
            wallet_public_url: String::new(),
        }
    }
}

impl Settings {
    fn normalize(&mut self) {
        if !matches!(self.mode.as_str(), "remote" | "custom" | "local") {
            self.mode = "remote".into();
        }
        if self.node_addr.trim().is_empty() {
            self.node_addr = DEFAULT_REMOTE_NODE.into();
        }
        // `standard` was the old pruned preset. It was unsafe as a wallet
        // source because it omitted the shielded archive; migrate it to the
        // equally compact but wallet-complete preset.
        if self.node_preset == "standard" {
            self.node_preset = "shielded".into();
        }
        if !matches!(
            self.node_preset.as_str(),
            "shielded" | "archival" | "mining"
        ) {
            self.node_preset = "shielded".into();
        }
        if self.node_preset == "mining" && self.mode == "local" {
            self.mode = "remote".into();
        }
        if !matches!(self.kaspa_mode.as_str(), "disabled" | "local" | "custom") {
            self.kaspa_mode = "disabled".into();
        }
        if !matches!(self.mining_node_mode.as_str(), "local" | "custom") {
            self.mining_node_mode = "local".into();
        }
        if self.mining_node_addr.trim().is_empty() {
            self.mining_node_addr = LOCAL_ZKAS_RPC.into();
        }
        if !matches!(self.mining_mode.as_str(), "solo" | "dual") {
            self.mining_mode = "solo".into();
        }
        if self.stratum_port < 1024 {
            self.stratum_port = 5555;
        }
        if !self.min_share_diff.is_finite() || self.min_share_diff <= 0.0 {
            self.min_share_diff = 8192.0;
        }
        if !matches!(self.wallet_access.as_str(), "device" | "lan" | "wan") {
            self.wallet_access = "device".into();
        }
        if self.wallet_access_port < 1024 {
            self.wallet_access_port = 8501;
        }
        self.wallet_public_url = self
            .wallet_public_url
            .trim()
            .trim_end_matches('/')
            .to_string();
    }

    fn rpc_addr(&self) -> String {
        match self.mode.as_str() {
            "custom" => self.node_addr.clone(),
            "local" => LOCAL_ZKAS_RPC.into(),
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
    wallet_access_token: String,
    settings: Settings,
    config_dir: PathBuf,
    data_dir: PathBuf,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    /// Kept so a restart can wait until the previous daemon has stopped its
    /// scan loops and flushed checkpoints. Dropping only the shutdown sender
    /// allowed two daemons to write the same wallet files concurrently.
    walletd_task: Option<tokio::task::JoinHandle<()>>,
    walletd_error: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// Reused for the shell's loopback API probes/proxy. A fresh client per
    /// one-second status poll discards keep-alive and needlessly churns sockets.
    http: reqwest::Client,
    services: ServiceManager,
    node_disk_bytes: u64,
    node_disk_checked: Option<std::time::Instant>,
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

/// Render the bridge configuration without Rust's `\` line-continuation
/// whitespace stripping. The indentation below is part of the YAML schema:
/// every mining parameter after `- stratum_port` belongs to that instance.
fn bridge_config_yaml(
    zkas_rpc: &str,
    kaspa_rpc: &str,
    kaspa_pay: &str,
    stratum_port: u16,
    min_share_diff: f64,
) -> String {
    // All interpolated values are validated address/host:port/port values by
    // the command boundary, so none can inject another YAML key.
    format!(
        r#"kaspad_address: "{zkas_rpc}"
block_wait_time: 1000
print_stats: false
log_to_file: false
health_check_port: "127.0.0.1:18080"
web_dashboard_port: ""
var_diff: true
shares_per_min: 20
var_diff_stats: false
pow2_clamp: true
extranonce_size: 2
coinbase_tag_suffix: "zkas-desktop"
merged_kaspa_address: "{kaspa_rpc}"
merged_kaspa_pay_address: "{kaspa_pay}"
instances:
  - stratum_port: "0.0.0.0:{stratum_port}"
    min_share_diff: {min_share_diff}
    prom_port: "127.0.0.1:18114"
    var_diff: true
    shares_per_min: 20
    pow2_clamp: true
    log_to_file: false
"#,
    )
}

/// A listening socket is not proof that walletd started: another process may
/// own the port, or walletd may accept TCP and fail before routing requests.
/// Require its public health endpoint to return HTTP 200 before a node switch
/// is committed or the UI is pointed at the new engine.
fn walletd_health_ready(address: std::net::SocketAddr) -> bool {
    let timeout = std::time::Duration::from_millis(500);
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0u8; 256];
    let Ok(read) = stream.read(&mut response) else {
        return false;
    };
    let status = String::from_utf8_lossy(&response[..read]);
    status.starts_with("HTTP/1.1 200 ") || status.starts_with("HTTP/1.0 200 ")
}

/// The route the wallet actually uses must work with the current auth policy;
/// `/health` alone proves only that some HTTP router owns the port. This catches
/// exactly the "health is 200, wallet says engine down" class before a restart
/// or Host access change is committed.
fn walletd_api_ready(
    address: std::net::SocketAddr,
    wallet_token: &str,
    bearer: Option<&str>,
) -> bool {
    let timeout = std::time::Duration::from_millis(500);
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let authorization = bearer
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Wallet-Token: {wallet_token}\r\n{authorization}Connection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0u8; 256];
    let Ok(read) = stream.read(&mut response) else {
        return false;
    };
    let status = String::from_utf8_lossy(&response[..read]);
    status.starts_with("HTTP/1.1 200 ") || status.starts_with("HTTP/1.0 200 ")
}

impl Engine {
    fn write_private(path: &std::path::Path, contents: &[u8]) {
        if std::fs::write(path, contents).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }

    fn new(config_dir: PathBuf, data_dir: PathBuf) -> Self {
        let mut settings: Settings = std::fs::read(config_dir.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        settings.normalize();
        let token = Self::load_or_create_token(&config_dir);
        let wallet_access_token = Self::load_or_create_access_token(&config_dir);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(8) // see zkas-walletd: oversubscribed so HTTP never starves behind scans
            .enable_all()
            .build()
            .expect("tokio runtime");
        services::set_log_path(data_dir.join("logs/services.log"));
        Self {
            rt,
            port: 0,
            token,
            wallet_access_token,
            settings,
            config_dir,
            data_dir,
            shutdown: None,
            walletd_task: None,
            walletd_error: std::sync::Arc::new(std::sync::Mutex::new(None)),
            http: reqwest::Client::new(),
            services: ServiceManager::default(),
            node_disk_bytes: 0,
            node_disk_checked: None,
            secret: None,
        }
    }

    /// The wallet token doubles as the wallet FILENAME on disk, so it must be
    /// stable across launches — persist it beside the settings.
    fn load_or_create_token(config_dir: &PathBuf) -> String {
        let path = config_dir.join("wallet-token");
        if let Ok(t) = std::fs::read_to_string(&path) {
            let t = t.trim().to_string();
            if valid_wallet_token(&t) {
                return t;
            }
            log_crash("ignored an invalid persisted wallet token");
        }
        use rand::Rng;
        let token: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(32)
            .map(char::from)
            .collect();
        let _ = std::fs::create_dir_all(config_dir);
        Self::write_private(&path, token.as_bytes());
        token
    }

    /// Authentication for LAN/WAN wallet-service clients. It is deliberately
    /// distinct from the X-Wallet-Token that identifies the desktop wallet.
    fn load_or_create_access_token(config_dir: &PathBuf) -> String {
        let path = config_dir.join("wallet-access-token");
        if let Ok(value) = std::fs::read_to_string(&path) {
            let value = value.trim().to_string();
            if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return value;
            }
        }
        use rand::RngCore;
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        let _ = std::fs::create_dir_all(config_dir);
        Self::write_private(&path, format!("{token}\n").as_bytes());
        token
    }

    fn save_settings(&self) {
        let _ = std::fs::create_dir_all(&self.config_dir);
        let _ = std::fs::write(
            self.config_dir.join("settings.json"),
            serde_json::to_vec_pretty(&self.settings).unwrap(),
        );
    }

    /// Stop walletd and WAIT for its scan loops to stop and checkpoints to
    /// flush. A node switch is not complete until this returns.
    fn stop_walletd(&mut self) {
        let logger = self.services.logger("wallet-engine");
        let was_running = self.shutdown.is_some() || self.walletd_task.is_some();
        if was_running {
            logger.record("app", "stopping wallet engine");
        }
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(mut task) = self.walletd_task.take() {
            let stopped = self.rt.block_on(async {
                tokio::time::timeout(std::time::Duration::from_secs(30), &mut task).await
            });
            if stopped.is_err() {
                log_crash("embedded walletd did not stop within 30s; aborting its task");
                logger.record(
                    "stderr",
                    "shutdown exceeded 30 seconds; aborting wallet engine task",
                );
                task.abort();
                let _ = self.rt.block_on(task);
            }
        }
        self.port = 0;
        if was_running {
            logger.record("app", "wallet engine stopped");
        }
    }

    /// Start (or restart) the embedded walletd against the current node source.
    fn start_walletd(&mut self) {
        self.stop_walletd();
        let logger = self.services.logger("wallet-engine");
        *self.walletd_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
        // Device-only uses a fresh loopback port. LAN/WAN uses the stable,
        // user-selected port and a separate bearer gate; the desktop webview
        // still connects through 127.0.0.1, never through its external address.
        let exposed = self.settings.wallet_access != "device";
        let requested_port = if exposed {
            self.settings.wallet_access_port
        } else {
            0
        };
        let mut bind_host = if exposed { "0.0.0.0" } else { "127.0.0.1" };
        // A fixed port is not always free the instant we want it. Restarting the engine
        // — switching nodes, toggling LAN access, relaunching the app over a previous
        // instance still draining — leaves 8501 held for a moment by the socket that is
        // going away. A single attempt turned that ordinary timing into "THE WALLET
        // ENGINE DIDN'T START", with the app then failing every call to
        // http://127.0.0.1:8501 because `self.port` had already been set to a port
        // nothing was listening on. Retry briefly, then degrade to a working wallet.
        let mut port = 0u16;
        let mut last_err = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match std::net::TcpListener::bind((bind_host, requested_port)) {
                Ok(l) => match l.local_addr() {
                    Ok(a) => {
                        port = a.port();
                        break;
                    }
                    Err(e) => last_err = format!("cannot read the wallet engine's address: {e}"),
                },
                Err(e) => last_err = format!("cannot bind {bind_host}:{requested_port}: {e}"),
            }
            if requested_port == 0 || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }

        // Still taken after the grace period: something else owns that port. Falling back
        // to a private loopback port keeps the WALLET working — the user's own funds and
        // UI are not hostage to a port conflict — and only LAN/WAN sharing is lost, which
        // is what the message says. Reporting "didn't start" here was doubly wrong: the
        // engine could have started, and the advice it offered (switch node source) had
        // nothing to do with the actual cause.
        if port == 0 && requested_port != 0 {
            match std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()) {
                Ok(a) => {
                    port = a.port();
                    bind_host = "127.0.0.1";
                    let message = format!(
                        "port {requested_port} is in use ({last_err}), so wallet sharing over the network is off; \
                         the wallet is running privately on this device. Pick a different port in Host to share it."
                    );
                    log_crash(&message);
                    logger.record("stderr", message);
                }
                Err(e) => last_err = format!("{last_err}; loopback fallback also failed: {e}"),
            }
        }

        if port == 0 {
            let message = format!("cannot start the wallet engine: {last_err}");
            log_crash(&message);
            logger.record("stderr", message.clone());
            *self.walletd_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(message);
            self.port = 0;
            return;
        }
        self.port = port;

        let node_rpc = self.settings.rpc_addr();
        logger.record(
            "app",
            format!("starting wallet engine on {bind_host}:{port}; node {node_rpc}"),
        );
        let cfg = zkas_walletd::Config {
            rpc_server: node_rpc.clone(),
            listen: format!("{bind_host}:{port}").parse().unwrap(),
            wallet_dir: self.data_dir.join("wallets").to_string_lossy().into_owned(),
            network: "mainnet".into(),
            // The webview's origin is not 127.0.0.1, so CORS must admit it.
            allow_origin: vec![
                "tauri://localhost".into(),
                "http://tauri.localhost".into(),
                "https://tauri.localhost".into(),
                "capacitor://localhost".into(),
                "http://localhost".into(),
                // Capacitor's Android WebView uses this origin with
                // androidScheme=https. Without it /health still opens as a page,
                // but the authenticated API preflight fails as "Failed to fetch".
                "https://localhost".into(),
                "https://wallet.zkas.info".into(),
            ],
            allow_default_token: false,
            // The passphrase the user unlocked with. `None` only in the
            // pre-passphrase (plaintext) case, which the UI pushes users off.
            wallet_secret: self.secret.clone(),
            // Embedded daemon is loopback-only: no HTTPS, no bearer gate.
            tls: None,
            require_bearer: exposed.then(|| self.wallet_access_token.clone()),
            // This is a single-user loopback daemon. The desktop shell keeps the
            // encrypted seed locally and is explicitly allowed to spend it.
            allow_custodial: true,
            max_concurrent_proves: zkas_walletd::default_max_concurrent_proves(),
            // Merge small notes in the background, at the daemon's own default
            // ceiling. Proving costs ~2.4 core-seconds PER NOTE SPENT, so a
            // wallet that accumulates hundreds of small notes — a miner paid per
            // block, say — gets slower to send from every day unless something
            // consolidates them. `None` would disable that silently.
            auto_consolidate: Some(zkas_walletd::AUTO_CONSOLIDATE_DEFAULT),
            resources: zkas_walletd::ResourceLimits::default(),
            // The wallet UI IS this daemon's client, and it is the process hosting it.
            // An idle bound belongs to a daemon somebody exposed and walked away from,
            // not to one whose window is open in front of them — here it would stop
            // the engine under the app while the user was still looking at it. The
            // shell already stops the engine when it locks or quits.
            idle_timeout: None,
        };
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown = Some(tx);
        let walletd_error = self.walletd_error.clone();
        let task_logger = logger.clone();
        self.walletd_task = Some(self.rt.spawn(async move {
            match zkas_walletd::serve(cfg, rx).await {
                Err(e) => {
                    // crash.log, not just stderr: the Windows build has no console.
                    let message = format!("embedded walletd stopped: {e}");
                    log_crash(&message);
                    task_logger.record("stderr", message.clone());
                    *walletd_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(message);
                }
                Ok(()) => task_logger.record("app", "wallet engine exited cleanly"),
            }
        }));
        log_crash(&format!(
            "embedded walletd on 127.0.0.1:{port} -> node {}",
            node_rpc
        ));
    }

    fn wait_walletd_ready(&self, timeout: std::time::Duration) -> Result<(), String> {
        if self.port == 0 {
            return Err(self
                .walletd_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
                .unwrap_or_else(|| "wallet engine has no listening port".into()));
        }
        let deadline = std::time::Instant::now() + timeout;
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], self.port));
        while std::time::Instant::now() < deadline {
            if self
                .walletd_task
                .as_ref()
                .is_some_and(tokio::task::JoinHandle::is_finished)
            {
                return Err(self
                    .walletd_error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .unwrap_or_else(|| "wallet engine stopped during startup".into()));
            }
            let bearer = (self.settings.wallet_access != "device")
                .then_some(self.wallet_access_token.as_str());
            if walletd_api_ready(address, &self.token, bearer) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(self
            .walletd_error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_else(|| {
                format!(
                    "wallet engine did not answer authenticated /api/status within {} seconds",
                    timeout.as_secs()
                )
            }))
    }

    /// Spawn the user-provided node binary (`local` mode) and supervise it for
    /// the app's lifetime. The chain lives under the app's data dir.
    fn start_local_node(&mut self, app: &tauri::AppHandle) -> Result<u32, String> {
        let bin = self
            .settings
            .node_binary
            .clone()
            .ok_or("no node binary configured")?;
        if !std::path::Path::new(&bin).exists() {
            return Err(format!("node binary not found at {bin}"));
        }
        let appdir = self.data_dir.join("node");
        if !self.services.zkas_node.running() {
            let recovered =
                services::stop_orphaned_node_processes(std::path::Path::new(&bin), &appdir)?;
            if !recovered.is_empty() {
                log_crash(&format!(
                    "recovered orphaned ZKas node process(es): {}",
                    recovered
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            } else if probe_node(LOCAL_ZKAS_RPC).is_ok() {
                return Err(format!(
                    "another node is already using {LOCAL_ZKAS_RPC}; stop it or choose Existing node"
                ));
            }
        }
        let mut args = vec![
            format!("--appdir={}", appdir.to_string_lossy()),
            format!(
                "--rpclisten={}",
                if self.settings.node_lan_rpc {
                    LOCAL_ZKAS_RPC_LAN
                } else {
                    LOCAL_ZKAS_RPC
                }
            ),
            "--utxoindex".into(),
            "--disable-upnp".into(),
            "--yes".into(),
            "--nologfiles".into(),
        ];
        for peer in PUBLIC_PEERS {
            args.push(format!("--addpeer={peer}"));
        }
        if self.settings.node_public_p2p {
            args.push(format!("--listen={LOCAL_ZKAS_P2P}"));
        } else {
            // There is no `--nolisten` flag in the release node. Loopback keeps
            // the P2P listener private without disabling outbound peer sync.
            args.push(format!("--listen={LOCAL_ZKAS_P2P_PRIVATE}"));
        }
        match self.settings.node_preset.as_str() {
            // Complete wallet note history without retaining old full bodies.
            "shielded" => args.push("--shielded-history=on".into()),
            // Archival already implies shielded history, but spelling it out
            // keeps the generated command self-documenting across releases.
            "archival" => {
                args.push("--archival".into());
                args.push("--shielded-history=on".into());
            }
            // Deliberately has no shielded history. Safe for validation/mining,
            // never safe as the wallet's history source.
            "mining" => {}
            _ => return Err("invalid ZKas node preset".into()),
        }
        let cwd = self.data_dir.join("run/zkas-node");
        self.services.start_zkas_node(
            app,
            ProcessSpec {
                service: "zkas-node",
                binary: PathBuf::from(bin),
                args,
                env: vec![],
                cwd,
            },
        )
    }

    fn stop_local_node(&mut self, app: &tauri::AppHandle) {
        self.services.stop_zkas_node(app);
    }

    fn start_local_kaspa_node(&mut self, app: &tauri::AppHandle) -> Result<u32, String> {
        let bin = self
            .settings
            .kaspa_node_binary
            .clone()
            .ok_or("Kaspa node is not installed")?;
        let appdir = self.data_dir.join("kaspa-node");
        if !self.services.kaspa_node.running() {
            let recovered =
                services::stop_orphaned_node_processes(std::path::Path::new(&bin), &appdir)?;
            if !recovered.is_empty() {
                log_crash(&format!(
                    "recovered orphaned Kaspa node process(es): {}",
                    recovered
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            } else if probe_node(LOCAL_KASPA_RPC).is_ok() {
                return Err(format!(
                    "another node is already using {LOCAL_KASPA_RPC}; stop it or choose Existing node"
                ));
            }
        }
        let mut args = vec![
            format!("--appdir={}", appdir.to_string_lossy()),
            format!("--rpclisten={LOCAL_KASPA_RPC}"),
            "--disable-upnp".into(),
            "--yes".into(),
            "--nologfiles".into(),
        ];
        if self.settings.kaspa_public_p2p {
            args.push(format!("--listen={LOCAL_KASPA_P2P}"));
        } else {
            args.push(format!("--listen={LOCAL_KASPA_P2P_PRIVATE}"));
        }
        self.services.start_kaspa_node(
            app,
            ProcessSpec {
                service: "kaspa-node",
                binary: PathBuf::from(bin),
                args,
                env: vec![],
                cwd: self.data_dir.join("run/kaspa-node"),
            },
        )
    }

    fn start_explorer_api(&mut self, app: &tauri::AppHandle) -> Result<u32, String> {
        let binary = self
            .settings
            .explorer_binary
            .clone()
            .ok_or("explorer backend is not installed")?;
        let state_dir = self.data_dir.join("explorer");
        std::fs::create_dir_all(&state_dir)
            .map_err(|e| format!("cannot create explorer data directory: {e}"))?;
        // The explorer's port is fixed, so a leftover copy — one this app started before
        // and did not reap, or a separately-run zkas-api — silently owns it. Spawning
        // anyway produced a process that died instantly and a card reading only
        // "exited with exit status: 1", while the browser still got an answer on 8500
        // from the copy that was already there. That combination is unreadable: it looks
        // like the service is both broken and working. Name the conflict instead.
        if let Err(e) = std::net::TcpListener::bind(("127.0.0.1", EXPLORER_API_PORT)) {
            return Err(format!(
                "port {EXPLORER_API_PORT} is already in use ({e}). Something is already serving the chain API there \
                 — most likely a copy of the explorer that is still running. Stop it, or restart the app, and try again."
            ));
        }
        self.services.start_explorer(
            app,
            ProcessSpec {
                service: "explorer-api",
                binary: PathBuf::from(binary),
                args: vec![
                    format!("--rpc-server={}", self.settings.rpc_addr()),
                    format!("--listen=127.0.0.1:{EXPLORER_API_PORT}"),
                    format!(
                        "--tx-index={}",
                        state_dir.join("txindex.tsv").to_string_lossy()
                    ),
                ],
                env: vec![],
                cwd: self.data_dir.join("run/explorer-api"),
            },
        )
    }

    fn bridge_config_path(&self) -> PathBuf {
        self.config_dir.join("mining/bridge.yaml")
    }

    fn write_bridge_config(
        &self,
        payout: &str,
        dual: bool,
        zkas_rpc: &str,
    ) -> Result<PathBuf, String> {
        let path = self.bridge_config_path();
        let parent = path.parent().ok_or("invalid bridge config path")?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create mining config directory: {e}"))?;
        let kaspa_rpc = if dual {
            self.settings.kaspa_node_addr.as_str()
        } else {
            ""
        };
        let kaspa_pay = if dual {
            self.settings.kaspa_payout.as_str()
        } else {
            ""
        };
        let yaml = bridge_config_yaml(
            zkas_rpc,
            kaspa_rpc,
            kaspa_pay,
            self.settings.stratum_port,
            self.settings.min_share_diff,
        );
        std::fs::write(&path, yaml).map_err(|e| format!("cannot write bridge config: {e}"))?;
        // The fallback exists in this bridge for compatibility with broken ASIC
        // usernames. In a private solo gateway it must be the operator's own
        // address, never a project or pool wallet.
        let _ = payout;
        Ok(path)
    }

    /// RPC used to BUILD and submit mining work. It is intentionally separate
    /// from the wallet source: a user can mine through a managed local node
    /// while their wallet keeps reading the public node during initial sync.
    fn mining_zkas_rpc(&mut self) -> Result<String, String> {
        if self.settings.mining_node_mode == "local" {
            if self.services.zkas_node.running() {
                return Ok(LOCAL_ZKAS_RPC.into());
            }
            return Err("the managed ZKas mining node is not running".into());
        }
        Ok(self.settings.mining_node_addr.clone())
    }

    fn wallet_dir(&self) -> String {
        self.data_dir.join("wallets").to_string_lossy().into_owned()
    }

    /// Where backups are written: the user's Documents folder when there is one
    /// (somewhere they can actually find and copy to a USB stick), else the app
    /// data dir as a fallback.
    fn backup_dir(&self) -> PathBuf {
        dirs_documents()
            .unwrap_or_else(|| self.data_dir.clone())
            .join("ZKas Wallet Backups")
    }

    fn vault(&self) -> zkas_walletd::VaultState {
        zkas_walletd::vault_state(&self.wallet_dir(), &self.token)
    }

    /// Stop the daemon and forget the passphrase. After this the on-disk seed is
    /// ciphertext and this process holds nothing that can spend.
    fn lock(&mut self) {
        self.stop_walletd();
        self.secret = None;
    }
}

#[derive(Serialize)]
struct WalletConfig {
    /// Where the UI reaches the embedded daemon.
    base: String,
    /// The per-install wallet token (X-Wallet-Token header).
    token: String,
    /// Present only when the engine is intentionally shared beyond loopback.
    wallet_bearer: Option<String>,
    network: String,
    mode: String,
    node_addr: String,
    node_binary: Option<String>,
    node_running: bool,
}

/// Response from the narrow desktop-only wallet API bridge.
///
/// The embedded wallet daemon can move ports when Host access changes. Sending
/// requests through the WebView made the JavaScript side responsible for keeping
/// that port and the external bearer token perfectly in step with the Rust
/// process. A single stale value produced the contradictory state where
/// `/health` was live but the wallet claimed its engine had not started. Desktop
/// requests now stay inside the process and always use the Engine's current port
/// and credentials. Web and mobile continue to use walletd over HTTP normally.
#[derive(Serialize)]
struct WalletApiResponse {
    status: u16,
    body: String,
}

/// Only endpoints used by the compiled wallet UI may cross the desktop bridge.
/// This is deliberately not a generic localhost proxy.
fn allowed_wallet_api_path(path: &str) -> bool {
    matches!(
        path,
        "/health"
            | "/api/status"
            | "/api/wallet/balance"
            | "/api/wallet/create"
            | "/api/wallet/watch"
            | "/api/wallet/reveal"
            | "/api/wallet/import"
            | "/api/wallet/send"
            | "/api/wallet/send_many"
            | "/api/wallet/consolidate"
            | "/api/wallet/prepare"
            | "/api/wallet/submit"
            | "/api/wallet/sign"
            | "/api/wallet/history"
            | "/api/wallet/settings"
            | "/api/wallet/rescan"
            | "/api/verify"
    )
}

fn config_of(e: &mut Engine) -> WalletConfig {
    WalletConfig {
        base: format!("http://127.0.0.1:{}", e.port),
        token: e.token.clone(),
        wallet_bearer: (e.settings.wallet_access != "device")
            .then(|| e.wallet_access_token.clone()),
        network: "mainnet".into(),
        mode: e.settings.mode.clone(),
        node_addr: e.settings.node_addr.clone(),
        node_binary: e.settings.node_binary.clone(),
        node_running: e.services.zkas_node.running(),
    }
}

#[tauri::command]
fn wallet_config(state: tauri::State<'_, Mutex<Engine>>) -> WalletConfig {
    config_of(&mut engine(&state))
}

#[tauri::command]
async fn wallet_api_request(
    state: tauri::State<'_, Mutex<Engine>>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    wallet_token: String,
    timeout_ms: u64,
    // A Tor wallet service the user deliberately chose, instead of the engine on
    // this computer. Only .onion is accepted here — a clearnet service is reached
    // by the WebView directly and never needs to come through Rust.
    base: Option<String>,
) -> Result<WalletApiResponse, String> {
    if !matches!(method.as_str(), "GET" | "POST") {
        return Err("wallet API method is not allowed".into());
    }
    if !allowed_wallet_api_path(&path) {
        return Err("wallet API path is not allowed".into());
    }
    if !valid_wallet_token(&wallet_token) {
        return Err("invalid wallet token".into());
    }

    // A chosen remote service is reached here, in Rust, never from the WebView.
    //
    // This is the whole reason the command takes a base. Two separate failures
    // came from not doing it: a Tor choice was answered by the LOCAL daemon, and
    // the public service failed outright because the desktop origin
    // (tauri://localhost) is not in the service's CORS allowlist — the browser
    // blocked it before it left the machine. Rust is not subject to CORS, so
    // routing through it removes that class entirely and needs no server change.
    if let Some(remote) = base.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        let (client, url) = match remote_target(remote, &path)? {
            RemoteTarget::Tor(url) => (tor_client()?, url),
            RemoteTarget::Direct(url) => (engine(&state).http.clone(), url),
        };
        let mut request = match method.as_str() {
            "GET" => client.get(url),
            "POST" => client.post(url),
            _ => unreachable!(),
        }
        .header("X-Wallet-Token", wallet_token)
        .timeout(std::time::Duration::from_millis(
            timeout_ms.clamp(1_000, 900_000),
        ));
        if let Some(value) = body {
            request = request.json(&value);
        }
        let response = request.send().await.map_err(|error| {
            if remote.contains(".onion") {
                format!("cannot reach the Tor wallet service (is Tor running on {TOR_SOCKS_PROXY}?): {error}")
            } else {
                format!("cannot reach the wallet service at {remote}: {error}")
            }
        })?;
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Ok(WalletApiResponse { status, body });
    }

    // Never hold the Engine mutex across network I/O. In particular, walletd's
    // status call can race a Host/node restart that needs this same lock.
    let (http, port, bearer) = {
        let e = engine(&state);
        if e.port == 0 {
            return Err(e
                .walletd_error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .unwrap_or_else(|| "wallet engine is not running".into()));
        }
        (
            e.http.clone(),
            e.port,
            (e.settings.wallet_access != "device").then(|| e.wallet_access_token.clone()),
        )
    };

    let url = format!("http://127.0.0.1:{port}{path}");
    let mut request = match method.as_str() {
        "GET" => http.get(url),
        "POST" => http.post(url),
        _ => unreachable!(),
    }
    .header("X-Wallet-Token", wallet_token)
    .timeout(std::time::Duration::from_millis(
        timeout_ms.clamp(1_000, 900_000),
    ));
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(value) = body {
        request = request.json(&value);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("cannot reach embedded wallet engine on port {port}: {error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("cannot read embedded wallet response: {error}"))?;
    Ok(WalletApiResponse { status, body })
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
    VaultStatus {
        state: e.vault(),
        unlocked: e.port != 0,
    }
}

/// Unlock with `passphrase` and start the daemon.
///
/// The passphrase is verified against the stored ciphertext BEFORE the daemon
/// starts, so a wrong one is a clean error rather than a daemon that comes up
/// unable to load the wallet and reports an empty balance — which would read
/// exactly like "my money is gone".
#[tauri::command]
fn unlock(
    state: tauri::State<'_, Mutex<Engine>>,
    passphrase: String,
) -> Result<WalletConfig, String> {
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
    Ok(config_of(&mut e))
}

/// Set the passphrase for a device that has none yet: encrypt an existing
/// cleartext wallet in place, or simply arm the daemon so a wallet created next
/// is written encrypted. Idempotent for an already-encrypted wallet.
#[tauri::command]
fn set_passphrase(
    state: tauri::State<'_, Mutex<Engine>>,
    passphrase: String,
) -> Result<WalletConfig, String> {
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
    Ok(config_of(&mut e))
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
    std::process::Command::new(cmd)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("cannot open {path}: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
struct BackupInfo {
    path: String,
    /// The containing folder, so the UI can offer to open it.
    folder: String,
}

const MAX_BACKUP_BYTES: u64 = 1024 * 1024;

fn validate_backup_document(contents: &str) -> Result<(), String> {
    if contents.len() as u64 > MAX_BACKUP_BYTES {
        return Err("backup file is too large".into());
    }
    let value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|_| "that file is not a ZKas wallet backup".to_string())?;
    if value.get("magic").and_then(|v| v.as_str()) != Some("zkas-wallet-backup") {
        return Err("that file is not a ZKas wallet backup".into());
    }
    Ok(())
}

fn read_backup_document(path: &str) -> Result<String, String> {
    let path_ref = std::path::Path::new(path);
    if path_ref.extension().and_then(|v| v.to_str()) != Some("json") {
        return Err("select a .json ZKas wallet backup".into());
    }
    let metadata = std::fs::metadata(path_ref).map_err(|e| format!("cannot read {path}: {e}"))?;
    if metadata.len() > MAX_BACKUP_BYTES {
        return Err("backup file is too large".into());
    }
    let contents =
        std::fs::read_to_string(path_ref).map_err(|e| format!("cannot read {path}: {e}"))?;
    validate_backup_document(&contents)?;
    Ok(contents)
}

fn write_unique_backup(folder: &std::path::Path, contents: &str) -> Result<PathBuf, String> {
    validate_backup_document(contents)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    for suffix in 0..100u8 {
        let name = if suffix == 0 {
            format!("zkas-wallet-backup-{stamp}.json")
        } else {
            format!("zkas-wallet-backup-{stamp}-{suffix}.json")
        };
        let path = folder.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                if let Err(error) = file.write_all(contents.as_bytes()) {
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("cannot write backup: {error}"));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("cannot write backup: {error}")),
        }
    }
    Err("cannot create a unique backup filename".into())
}

/// Write an encrypted backup of the seed to the user's Documents folder (or the
/// app data dir if there is none), under a passphrase chosen for the FILE.
///
/// A separate backup passphrase is deliberate: the file is meant to leave this
/// machine — USB stick, cloud drive, password manager — and reusing the daily
/// unlock secret for something that travels is how one compromise becomes two.
#[tauri::command]
fn backup_wallet(
    state: tauri::State<'_, Mutex<Engine>>,
    backup_passphrase: String,
) -> Result<BackupInfo, String> {
    let e = engine(&state);
    let json = zkas_walletd::export_backup(
        &e.wallet_dir(),
        &e.token,
        e.secret.as_deref(),
        &backup_passphrase,
    )?;
    let folder = e.backup_dir();
    std::fs::create_dir_all(&folder)
        .map_err(|err| format!("cannot create backup folder: {err}"))?;
    let path = write_unique_backup(&folder, &json)?;
    Ok(BackupInfo {
        path: path.to_string_lossy().into_owned(),
        folder: folder.to_string_lossy().into_owned(),
    })
}

/// Write a backup document produced by the APP (client-side encryption of the
/// seed this device holds) into the backup folder.
///
/// The daemon-side `backup_wallet` above covers wallets whose seed walletd
/// holds; this covers the non-custodial case, which is the default — the seed
/// lives in the webview, so only the app can encrypt it.
#[tauri::command]
fn write_backup(
    state: tauri::State<'_, Mutex<Engine>>,
    contents: String,
) -> Result<BackupInfo, String> {
    let folder = engine(&state).backup_dir();
    std::fs::create_dir_all(&folder).map_err(|e| format!("cannot create backup folder: {e}"))?;
    let path = write_unique_backup(&folder, &contents)?;
    Ok(BackupInfo {
        path: path.to_string_lossy().into_owned(),
        folder: folder.to_string_lossy().into_owned(),
    })
}

/// Read a backup file back (the app decrypts it — the shell never sees a key).
#[tauri::command]
fn read_backup_file(path: String) -> Result<String, String> {
    read_backup_document(&path)
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
    let json = read_backup_document(&path)?;
    let dir = e.wallet_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("cannot create wallet folder: {err}"))?;
    zkas_walletd::import_backup(&dir, &e.token, &json, &backup_passphrase, &passphrase)?;
    e.secret = Some(passphrase);
    e.start_walletd();
    Ok(config_of(&mut e))
}

fn valid_wallet_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// Forget the wallet on this device: stop the daemon, delete its wallet file and
/// scan checkpoint, then restart the daemon empty so the app offers onboarding.
///
/// Destructive and irreversible from this machine's point of view — the caller
/// MUST have warned that funds are unreachable afterwards without a backup or
/// seed phrase. The chain is untouched: the coins still exist, and restoring the
/// seed anywhere brings them back.
#[tauri::command]
fn forget_wallet(
    state: tauri::State<'_, Mutex<Engine>>,
    token: Option<String>,
) -> Result<WalletConfig, String> {
    let mut e = engine(&state);
    e.lock(); // stop the daemon so nothing rewrites the files we are removing
    let dir = e.wallet_dir();
    // Delete the wallet the UI is REMOVING, which is not necessarily this
    // shell's own. The device can hold several wallets and the app decides which
    // is active; using the shell's token here deleted wallet #1 whenever the
    // user removed any other one.
    let token = token.unwrap_or_else(|| e.token.clone());
    // Browser tokens are hex; the desktop shell historically generated a
    // 32-character alphanumeric token. Both are safe filename components.
    if !valid_wallet_token(&token) {
        e.start_walletd();
        return Err("invalid wallet token".into());
    }
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
    Ok(config_of(&mut e))
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
    found
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Switch the node source. Restarts the embedded daemon against the new node;
/// wallet files and scan checkpoints are untouched (they key off the token).
///
/// A custom node is PROBED before anything is persisted. The embedded daemon
/// retries its node connection forever before it starts serving HTTP, so
/// restarting it against an unreachable address didn't just fail — it took the
/// whole wallet UI down, survived relaunches (the address was already saved),
/// and read as "the app is broken, reinstall it". A wrong address must be
/// refused here, with the running daemon untouched.
#[tauri::command]
async fn set_node_source(
    _app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Engine>>,
    mode: String,
    node_addr: Option<String>,
    node_binary: Option<String>,
) -> Result<WalletConfig, String> {
    if !matches!(mode.as_str(), "remote" | "custom" | "local") {
        return Err("mode must be remote | custom | local".into());
    }
    // Normalize BEFORE taking the engine lock. The real gRPC probe below can
    // take seconds and must not freeze wallet/status commands.
    let normalized_addr = match node_addr {
        Some(a) => {
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
                let host_port_ok = a
                    .rsplit_once(':')
                    .map(|(h, p)| !h.is_empty() && p.parse::<u16>().is_ok())
                    .unwrap_or(false);
                if !host_port_ok {
                    return Err(format!(
                        "node address must be host:port, e.g. 127.0.0.1:16110 (got \"{a}\")"
                    ));
                }
            }
            Some(a)
        }
        None => None,
    };
    let target = match mode.as_str() {
        "remote" => DEFAULT_REMOTE_NODE.to_string(),
        "custom" => normalized_addr
            .clone()
            .ok_or("custom node address is required")?,
        "local" => {
            let mut e = engine(&state);
            if e.settings.node_preset == "mining" {
                return Err(
                    "Mining-only nodes do not contain complete wallet history. Choose Shielded history or Archive, restart the node, and let it sync before connecting the wallet."
                        .into(),
                );
            }
            if !e.services.zkas_node.running() {
                return Err(
                    "the managed local node is not running; start it from Node first".into(),
                );
            }
            LOCAL_ZKAS_RPC.to_string()
        }
        _ => unreachable!(),
    };

    // The public node ("remote") is trusted default infrastructure, and walletd
    // handles a node that is briefly lagging or catching up on its own. So we do
    // NOT block first launch on probing it: a slow path to it, a momentary
    // `!synced` under load, or a slot-exhaustion blip must not refuse to open
    // the wallet — that is exactly what left first-run users staring at
    // "Connecting…" for ~40s and then an error. walletd retries the connection
    // and the UI shows reachability as a live status, not a launch gate.
    //
    // A user-entered `custom` node stays STRICT: probe it first and fail loudly
    // on a wrong address or an unsynced node, rather than silently connect to
    // nothing.
    if mode != "remote" {
        let (_, _, _, _, synced, _, _) = tokio::time::timeout(
            std::time::Duration::from_secs(11),
            query_node_rpc_with_deadline(&target, std::time::Duration::from_secs(8)),
        )
        .await
        .map_err(|_| format!("node RPC at {target} timed out; wallet connection was not changed"))??;
        if !synced {
            return Err(format!(
                "node at {target} is still syncing. The wallet remains on its previous source so its balance cannot become partial."
            ));
        }
        tokio::time::timeout(
            std::time::Duration::from_secs(8),
            verify_wallet_history_rpc(&target),
        )
        .await
        .map_err(|_| {
            format!("shielded-history check at {target} timed out; wallet connection was not changed")
        })??;
    }

    let mut e = engine(&state);
    // Roll back only to a daemon that was actually up. Normally one is — boot
    // starts walletd on the default source — so a switch that fails to come up
    // is correctly restored to the working connection. But if boot's own start
    // failed (port == 0), `previous` is just unusable defaults: rolling back to
    // it (a second 15s wait) buys nothing and reports a "previous connection"
    // that was never live. There, return the real error instead.
    let had_daemon = e.port != 0;
    let previous = e.settings.clone();
    if let Some(a) = normalized_addr {
        e.settings.node_addr = a;
    }
    e.settings.mode = mode;
    if let Some(b) = node_binary {
        e.settings.node_binary = if b.trim().is_empty() { None } else { Some(b) };
    }
    e.start_walletd();
    if let Err(error) = e.wait_walletd_ready(std::time::Duration::from_secs(15)) {
        if had_daemon {
            // Transactional rollback: never persist a source that leaves the app
            // dead, and restore the already-working daemon in the same command.
            e.settings = previous;
            e.start_walletd();
            let _ = e.wait_walletd_ready(std::time::Duration::from_secs(15));
            return Err(format!("{error}; restored the previous wallet connection"));
        }
        return Err(error);
    }
    e.save_settings();
    Ok(config_of(&mut e))
}

#[derive(Clone, Serialize)]
struct ComponentStatus {
    zkas_node: bool,
    zkas_node_update_available: bool,
    bridge: bool,
    bridge_update_available: bool,
    zkas_miner: bool,
    kaspa_node: bool,
    explorer: bool,
}

#[derive(Clone, Serialize)]
struct ControlConfig {
    settings: Settings,
    components: ComponentStatus,
    zkas_release: &'static str,
    bridge_release: &'static str,
    /// True only when this OS/CPU pair has a pinned, verified merged-mining
    /// bridge release. Unsupported targets must not offer a fake fallback.
    dual_mining_supported: bool,
    data_dir: String,
}

fn zkas_node_update_available(settings: &Settings, node_exists: bool) -> bool {
    node_exists && settings.node_release.as_deref() != Some(services::ZKAS_RELEASE)
}

fn bridge_update_available(settings: &Settings, bridge_exists: bool) -> bool {
    bridge_exists
        && services::bridge_supported()
        && settings.bridge_release.as_deref() != Some(services::BRIDGE_RELEASE)
}

#[tauri::command]
fn control_config(state: tauri::State<'_, Mutex<Engine>>) -> ControlConfig {
    let e = engine(&state);
    let exists = |p: &Option<String>| {
        p.as_ref()
            .is_some_and(|v| std::path::Path::new(v).is_file())
    };
    let zkas_node = exists(&e.settings.node_binary);
    let bridge = exists(&e.settings.bridge_binary);
    ControlConfig {
        settings: e.settings.clone(),
        components: ComponentStatus {
            zkas_node,
            zkas_node_update_available: zkas_node_update_available(&e.settings, zkas_node),
            bridge,
            bridge_update_available: bridge_update_available(&e.settings, bridge),
            zkas_miner: exists(&e.settings.miner_binary),
            kaspa_node: exists(&e.settings.kaspa_node_binary),
            explorer: exists(&e.settings.explorer_binary),
        },
        zkas_release: services::ZKAS_RELEASE,
        bridge_release: services::BRIDGE_RELEASE,
        dual_mining_supported: services::bridge_supported(),
        data_dir: e.data_dir.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
async fn install_local_components(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Engine>>,
    selection: InstallSelection,
) -> Result<InstalledComponents, String> {
    let data_dir = {
        let mut e = engine(&state);
        if selection.zkas
            && (e.services.zkas_node.running()
                || e.services.cpu_miner.running()
                || e.services.explorer.running())
        {
            return Err(
                "stop the local node, CPU miner, and local explorer before updating ZKAS software"
                    .into(),
            );
        }
        if selection.bridge && e.services.bridge.running() {
            return Err("stop mining before updating the Stratum bridge".into());
        }
        e.data_dir.clone()
    };
    let installed = services::install_components(&app, &data_dir, selection).await?;
    let mut e = engine(&state);
    if installed.zkas_node.is_some() {
        e.settings.node_binary = installed.zkas_node.clone();
        e.settings.node_release = Some(services::ZKAS_RELEASE.into());
    }
    if installed.zkas_miner.is_some() {
        e.settings.miner_binary = installed.zkas_miner.clone();
    }
    if installed.explorer.is_some() {
        e.settings.explorer_binary = installed.explorer.clone();
    }
    if installed.bridge.is_some() {
        e.settings.bridge_binary = installed.bridge.clone();
        e.settings.bridge_release = Some(services::BRIDGE_RELEASE.into());
    }
    if installed.kaspa_node.is_some() {
        e.settings.kaspa_node_binary = installed.kaspa_node.clone();
    }
    e.save_settings();
    Ok(installed)
}

#[derive(Clone, Serialize)]
struct NodeStatus {
    running: bool,
    managed: bool,
    pid: Option<u32>,
    rpc_addr: String,
    block_count: Option<u64>,
    header_count: Option<u64>,
    daa_score: Option<u64>,
    peer_count: Option<usize>,
    is_synced: Option<bool>,
    mempool_size: Option<usize>,
    sync_progress: Option<f64>,
    difficulty: Option<f64>,
    disk_bytes: u64,
    error: Option<String>,
    last_exit: Option<String>,
}

/// Ask a node for its status, and CLOSE the session however this ends.
///
/// The deadline lives inside this function on purpose. Callers used to wrap the whole
/// thing in `tokio::time::timeout(...)`, which cancels the future by dropping it — and a
/// dropped future never reaches `client.disconnect()`. The connection had already been
/// established by then, so every poll that overran its timeout left a live gRPC session
/// on the node.
///
/// That leak amplifies itself: a busy node answers more slowly, more polls overrun, more
/// sessions leak, and the node gets busier. Reported from the field on Windows — the
/// desktop app holding **126 established connections** to a Kaspa node whose default
/// `--rpcmaxclients` is 128, while each mining bridge held exactly one. The parent node
/// then refused everything with "gRPC service has reached full capacity", and all 126
/// vanished the moment the app was closed. The same shape as the socat forwarder leak
/// fixed on the public node the same week: nothing was closing what it opened.
///
/// So: connect, run the calls under the deadline, and disconnect unconditionally.
/// Close a gRPC session when this guard drops — including when the surrounding future is
/// CANCELLED, which is exactly the case a plain `disconnect().await` at the end misses.
///
/// `Drop` cannot await, so the disconnect is spawned. That is sound here: the client is
/// cloned, so the spawned task owns everything it needs, and a session closed a moment
/// late still returns the node's slot. Leaving it open does not.
struct DisconnectOnDrop(Option<kaspa_grpc_client::GrpcClient>);

impl Drop for DisconnectOnDrop {
    fn drop(&mut self) {
        if let Some(client) = self.0.take() {
            tokio::spawn(async move {
                let _ = client.disconnect().await;
            });
        }
    }
}

fn scopeguard_disconnect(client: kaspa_grpc_client::GrpcClient) -> DisconnectOnDrop {
    DisconnectOnDrop(Some(client))
}

async fn query_node_rpc_with_deadline(
    addr: &str,
    deadline: std::time::Duration,
) -> Result<(u64, u64, u64, usize, bool, usize, f64), String> {
    use kaspa_grpc_client::GrpcClient;
    use kaspa_rpc_core::{api::rpc::RpcApi, notify::mode::NotificationMode};

    let client = GrpcClient::connect_with_args(
        NotificationMode::Direct,
        format!("grpc://{addr}"),
        None,
        false,
        None,
        false,
        Some(500_000),
        Default::default(),
    )
    .await
    .map_err(|e| format!("cannot connect to node RPC at {addr}: {e}"))?;

    // Every call that can hang lives inside this block, so the deadline covers them and
    // the disconnect below is reached no matter which way it ends.
    let gathered = tokio::time::timeout(deadline, async {
        let dag = client
            .get_block_dag_info()
            .await
            .map_err(|e| format!("getBlockDagInfo failed: {e}"))?;
        let synced = client
            .get_sync_status()
            .await
            .map_err(|e| format!("getSyncStatus failed: {e}"))?;
        let peers = client
            .get_connected_peer_info()
            .await
            .map(|r| r.peer_info.len())
            .unwrap_or(0);
        let mempool = client
            .get_mempool_entries(false, false)
            .await
            .map(|r| r.len())
            .unwrap_or(0);
        Ok::<_, String>((dag, synced, peers, mempool))
    })
    .await;

    // Unconditional. This is the whole point of the restructure — a timed-out or failed
    // query must still hand the node its slot back.
    let _ = client.disconnect().await;

    let (dag, synced, peers, mempool) = match gathered {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(format!("node RPC at {addr} did not answer within {}s", deadline.as_secs())),
    };
    Ok((
        dag.block_count,
        dag.header_count,
        dag.virtual_daa_score,
        peers,
        synced,
        mempool,
        dag.difficulty,
    ))
}

/// Prove that an RPC is suitable for wallet recovery, not merely that it is a
/// live consensus node. A pruned mining-only node answers ordinary DAG calls
/// perfectly while returning incomplete historical notes; requesting the first
/// shielded page after genesis catches that dangerous configuration.
async fn verify_wallet_history_rpc(addr: &str) -> Result<(), String> {
    use kaspa_consensus_core::{config::params::Params, network::NetworkType};
    use kaspa_grpc_client::GrpcClient;
    use kaspa_rpc_core::{api::rpc::RpcApi, notify::mode::NotificationMode, RpcHash};

    let client = GrpcClient::connect_with_args(
        NotificationMode::Direct,
        format!("grpc://{addr}"),
        None,
        false,
        None,
        false,
        Some(500_000),
        Default::default(),
    )
    .await
    .map_err(|e| format!("cannot connect to node RPC at {addr}: {e}"))?;
    // Cleanup guard: see `query_node_rpc_with_deadline`. This function is also called
    // under an outer timeout, so it must not rely on reaching its own end to disconnect.
    let closer = client.clone();
    let _guard = scopeguard_disconnect(closer);
    let genesis = RpcHash::from_bytes(Params::from(NetworkType::Mainnet).genesis.hash.as_bytes());
    let result = client.get_shielded_blocks(genesis, 1).await;
    let _ = client.disconnect().await;
    match result {
        Ok(page) if !page.blocks.is_empty() => Ok(()),
        Ok(_) => Err(format!(
            "node at {addr} returned no shielded history after genesis; it is not safe as a wallet source"
        )),
        Err(error) => Err(format!(
            "node at {addr} cannot serve complete shielded history ({error}); use Shielded history/Archive or keep the wallet on the public node"
        )),
    }
}

fn directory_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            match entry.metadata() {
                Ok(meta) if meta.is_file() => meta.len(),
                Ok(meta) if meta.is_dir() => directory_size(&path),
                _ => 0,
            }
        })
        .sum()
}

#[tauri::command]
async fn node_status(state: tauri::State<'_, Mutex<Engine>>) -> Result<NodeStatus, String> {
    let (rpc_addr, pid, last_exit, node_dir, cached_disk, refresh_disk) = {
        let mut e = engine(&state);
        let pid = e.services.zkas_node.pid();
        let refresh_disk = e
            .node_disk_checked
            .is_none_or(|checked| checked.elapsed() >= std::time::Duration::from_secs(30));
        if refresh_disk {
            // Claim this refresh before leaving the lock so overlapping UI
            // polls do not launch duplicate directory walks.
            e.node_disk_checked = Some(std::time::Instant::now());
        }
        (
            LOCAL_ZKAS_RPC.to_string(),
            pid,
            e.services.zkas_node.last_exit(),
            e.data_dir.join("node"),
            e.node_disk_bytes,
            refresh_disk,
        )
    };
    let disk = if refresh_disk {
        let measured = tokio::task::spawn_blocking(move || directory_size(&node_dir))
            .await
            .unwrap_or(cached_disk);
        engine(&state).node_disk_bytes = measured;
        measured
    } else {
        cached_disk
    };
    if pid.is_none() {
        return Ok(NodeStatus {
            running: false,
            managed: true,
            pid: None,
            rpc_addr,
            block_count: None,
            header_count: None,
            daa_score: None,
            peer_count: None,
            is_synced: None,
            mempool_size: None,
            sync_progress: None,
            difficulty: None,
            disk_bytes: disk,
            error: None,
            last_exit,
        });
    }
    let status =
        match tokio::time::timeout(std::time::Duration::from_secs(7), query_node_rpc_with_deadline(&rpc_addr, std::time::Duration::from_secs(4)))
            .await
        {
            Ok(Ok((blocks, headers, daa, peers, synced, mempool, difficulty))) => NodeStatus {
                running: true,
                managed: true,
                pid,
                rpc_addr,
                block_count: Some(blocks),
                header_count: Some(headers),
                daa_score: Some(daa),
                peer_count: Some(peers),
                is_synced: Some(synced),
                mempool_size: Some(mempool),
                // `blocks / headers` is NOT sync progress and must not be shown as one
                // once it is near the top. Headers are fetched ahead of bodies, so the
                // ratio dips whenever the node pulls a batch of headers — it was seen
                // going 99.4% -> 97.3% across a restart — and a pruned node drops
                // bodies it no longer needs, so the ratio has no reason to ever reach
                // 100. Presented as a percentage it parks a few points short forever
                // and reads as a node stuck at 97%.
                //
                // It IS a fair signal during real initial sync, when bodies are far
                // behind. Past that, report no number rather than a false one: the UI
                // says "Catching up" and shows the counters, which do move.
                sync_progress: if synced {
                    Some(100.0)
                } else if headers > 0 && (blocks as f64) < headers as f64 * 0.98 {
                    Some((blocks as f64 / headers as f64 * 100.0).clamp(0.0, 97.9))
                } else {
                    None
                },
                difficulty: Some(difficulty),
                disk_bytes: disk,
                error: None,
                last_exit,
            },
            Ok(Err(error)) => NodeStatus {
                running: true,
                managed: true,
                pid,
                rpc_addr,
                block_count: None,
                header_count: None,
                daa_score: None,
                peer_count: None,
                is_synced: None,
                mempool_size: None,
                sync_progress: None,
                difficulty: None,
                disk_bytes: disk,
                error: Some(error),
                last_exit,
            },
            Err(_) => NodeStatus {
                running: true,
                managed: true,
                pid,
                rpc_addr,
                block_count: None,
                header_count: None,
                daa_score: None,
                peer_count: None,
                is_synced: None,
                mempool_size: None,
                sync_progress: None,
                difficulty: None,
                disk_bytes: disk,
                error: Some("node RPC status timed out".into()),
                last_exit,
            },
        };
    Ok(status)
}

#[derive(Clone, Serialize, Deserialize)]
struct WalletdStatus {
    running: bool,
    port: u16,
    node_source: String,
    node_rpc: String,
    node_connected: Option<bool>,
    synced: Option<bool>,
    scanning_progress: Option<f64>,
    note_count: Option<u64>,
    anchor_daa: Option<u64>,
    balance: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn walletd_status(state: tauri::State<'_, Mutex<Engine>>) -> Result<WalletdStatus, String> {
    let (http, port, token, bearer, node_source, node_rpc, engine_error) = {
        let e = engine(&state);
        let engine_error = e
            .walletd_error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        (
            e.http.clone(),
            e.port,
            e.token.clone(),
            (e.settings.wallet_access != "device").then(|| e.wallet_access_token.clone()),
            e.settings.mode.clone(),
            e.settings.rpc_addr(),
            engine_error,
        )
    };
    if port == 0 {
        return Ok(WalletdStatus {
            running: false,
            port,
            node_source,
            node_rpc,
            node_connected: None,
            synced: None,
            scanning_progress: None,
            note_count: None,
            anchor_daa: None,
            balance: None,
            error: engine_error,
        });
    }
    let request = http
        .get(format!("http://127.0.0.1:{port}/api/status"))
        .header("X-Wallet-Token", token)
        .timeout(std::time::Duration::from_secs(3));
    let result = match bearer {
        Some(token) => request.bearer_auth(token),
        None => request,
    }
    .send()
    .await;
    let status = match result {
        Ok(response) if response.status().is_success() => {
            let value = response
                .json::<serde_json::Value>()
                .await
                .unwrap_or_default();
            let scanned = value
                .get("scanned_blocks")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let chain = value.get("chain_len").and_then(|v| v.as_u64()).unwrap_or(0);
            WalletdStatus {
                running: true,
                port,
                node_source: node_source.clone(),
                node_rpc: node_rpc.clone(),
                node_connected: value.get("node_connected").and_then(|v| v.as_bool()),
                synced: value.get("synced").and_then(|v| v.as_bool()),
                scanning_progress: (chain > 0)
                    .then(|| (scanned as f64 / chain as f64 * 100.0).clamp(0.0, 100.0)),
                note_count: value.get("note_count").and_then(|v| v.as_u64()),
                anchor_daa: value.get("daa_score").and_then(|v| v.as_u64()),
                balance: value
                    .get("balance_fc")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned),
                error: value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned),
            }
        }
        Ok(response) => WalletdStatus {
            running: true,
            port,
            node_source: node_source.clone(),
            node_rpc: node_rpc.clone(),
            node_connected: None,
            synced: None,
            scanning_progress: None,
            note_count: None,
            anchor_daa: None,
            balance: None,
            error: engine_error
                .clone()
                .or_else(|| Some(format!("wallet daemon returned {}", response.status()))),
        },
        Err(error) => WalletdStatus {
            running: false,
            port,
            node_source,
            node_rpc,
            node_connected: None,
            synced: None,
            scanning_progress: None,
            note_count: None,
            anchor_daa: None,
            balance: None,
            error: engine_error.or_else(|| Some(error.to_string())),
        },
    };
    Ok(status)
}

#[tauri::command]
fn start_node_preset(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Engine>>,
    preset: String,
    public_p2p: bool,
) -> Result<u32, String> {
    if !matches!(preset.as_str(), "shielded" | "archival" | "mining") {
        return Err("node preset must be shielded, archival, or mining".into());
    }
    let mut e = engine(&state);
    if preset == "mining" && e.settings.mode == "local" {
        return Err("switch the wallet to Public node before starting a mining-only node".into());
    }
    e.settings.node_preset = preset;
    e.settings.node_public_p2p = public_p2p;
    let pid = e.start_local_node(&app)?;
    // Never point walletd at a process that died during startup. An existing
    // remote wallet connection remains usable if startup fails.
    std::thread::sleep(std::time::Duration::from_millis(300));
    if !e.services.zkas_node.running() {
        let error = e
            .services
            .zkas_node
            .last_exit()
            .unwrap_or_else(|| "ZKas node exited during startup".into());
        // A failed first launch is not a transient runtime crash. Leaving the
        // process marked desired made the supervisor retry a RocksDB LOCK or bad
        // argument five times while the UI had already reported failure.
        e.services.stop_zkas_node(&app);
        return Err(error);
    }
    e.settings.node_auto_start = true;
    e.save_settings();
    Ok(pid)
}

#[tauri::command]
fn stop_node(app: tauri::AppHandle, state: tauri::State<'_, Mutex<Engine>>) -> Result<(), String> {
    let mut e = engine(&state);
    e.services.stop_cpu_miner(&app);
    e.services.stop_bridge(&app);
    if e.settings.kaspa_mode == "local" {
        e.services.stop_kaspa_node(&app);
    }
    // Keep the wallet available: switch its embedded daemon back to the public
    // node before stopping the managed local process.
    if e.settings.mode == "local" {
        e.settings.mode = "remote".into();
        e.start_walletd();
        if let Err(error) = e.wait_walletd_ready(std::time::Duration::from_secs(15)) {
            e.settings.mode = "local".into();
            e.start_walletd();
            let _ = e.wait_walletd_ready(std::time::Duration::from_secs(15));
            return Err(format!(
                "could not move the wallet to the public node: {error}; restored the local wallet connection"
            ));
        }
    }
    e.stop_local_node(&app);
    e.settings.node_auto_start = false;
    e.save_settings();
    Ok(())
}

#[tauri::command]
fn set_node_options(
    state: tauri::State<'_, Mutex<Engine>>,
    public_p2p: bool,
    preset: String,
) -> Result<(), String> {
    if !matches!(preset.as_str(), "shielded" | "archival" | "mining") {
        return Err("node preset must be shielded, archival, or mining".into());
    }
    let mut e = engine(&state);
    if preset == "mining" && e.settings.mode == "local" {
        return Err("switch the wallet to Public node before selecting Mining only".into());
    }
    e.settings.node_public_p2p = public_p2p;
    e.settings.node_preset = preset;
    e.save_settings();
    Ok(())
}

#[tauri::command]
fn service_logs(
    state: tauri::State<'_, Mutex<Engine>>,
    service: Option<String>,
    limit: Option<usize>,
) -> Vec<ServiceLog> {
    engine(&state)
        .services
        .logs(service.as_deref(), limit.unwrap_or(200))
}

fn validate_endpoint(raw: &str, label: &str) -> Result<String, String> {
    let value = raw
        .trim()
        .trim_start_matches("grpc://")
        .trim_end_matches('/');
    let valid = value
        .rsplit_once(':')
        .is_some_and(|(host, port)| !host.is_empty() && port.parse::<u16>().is_ok());
    if !valid {
        return Err(format!("{label} must be host:port"));
    }
    if value
        .chars()
        .any(|character| matches!(character, '\n' | '\r' | '"'))
    {
        return Err(format!("invalid {label}"));
    }
    Ok(value.to_string())
}

fn validate_payout_address(raw: &str, expected_prefix: &str) -> Result<String, String> {
    let value = raw.trim();
    let parsed = kaspa_addresses::Address::try_from(value)
        .map_err(|e| format!("invalid {expected_prefix} payout address: {e}"))?;
    let normalized = parsed.to_string();
    if !normalized.starts_with(&format!("{expected_prefix}:")) {
        return Err(format!("payout address must start with {expected_prefix}:"));
    }
    Ok(normalized)
}

fn check_stratum_port(port: u16) -> Result<(), String> {
    if port < 1024 {
        return Err("choose a Stratum port from 1024 to 65535".into());
    }
    match std::net::TcpListener::bind(("0.0.0.0", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(error) => {
            let bridge_dashboard = std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], 18114)),
                std::time::Duration::from_millis(250),
            )
            .is_ok();
            Err(if bridge_dashboard {
                format!(
                    "Stratum port {port} is already used by another bridge. Stop that bridge before starting mining here; the app will not kill a manually managed miner."
                )
            } else {
                format!(
                    "Stratum port {port} is already in use ({error}). Stop the program using it or choose another port."
                )
            })
        }
    }
}

fn check_bridge_control_ports() -> Result<(), String> {
    for (port, label) in [(18080, "bridge health"), (18114, "bridge metrics")] {
        std::net::TcpListener::bind(("127.0.0.1", port))
            .map(drop)
            .map_err(|e| format!("local {label} port {port} is already in use: {e}"))?;
    }
    Ok(())
}

#[derive(Clone, Serialize)]
struct LocalNetworkInfo {
    /// Preferred human LAN address. `lan_ips` contains every usable interface;
    /// this compatibility field favors ordinary Wi-Fi/Ethernet over VPN ranges.
    lan_ip: Option<String>,
    lan_ips: Vec<String>,
}

#[tauri::command]
fn local_network_info() -> LocalNetworkInfo {
    let lan_ips = lan_ipv4s();
    LocalNetworkInfo {
        lan_ip: lan_ips.first().cloned(),
        lan_ips,
    }
}

fn lan_ipv4_rank(ip: &std::net::Ipv4Addr) -> u8 {
    let octets = ip.octets();
    // Home routers overwhelmingly use 192.168/16. Prefer it over 10/8, which is
    // also the most common VPN/tunnel range; still return every address below.
    if octets[0] == 192 && octets[1] == 168 {
        0
    } else if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        1
    } else if octets[0] == 10 {
        2
    } else if octets[0] == 169 && octets[1] == 254 {
        4
    } else {
        3
    }
}

fn lan_ipv4s() -> Vec<String> {
    let mut ips: Vec<std::net::Ipv4Addr> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            std::net::IpAddr::V4(ip)
                if !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_multicast()
                    && !ip.is_broadcast() => Some(ip),
            _ => None,
        })
        .collect();
    ips.sort_by_key(|ip| (lan_ipv4_rank(ip), ip.octets()));
    ips.dedup();
    ips.into_iter().map(|ip| ip.to_string()).collect()
}

fn configure_mining_zkas_source(
    e: &mut Engine,
    mode: &str,
    address: Option<&str>,
) -> Result<(), String> {
    match mode {
        "local" => {
            e.settings.mining_node_mode = "local".into();
            e.settings.mining_node_addr = LOCAL_ZKAS_RPC.into();
        }
        "custom" => {
            e.settings.mining_node_mode = "custom".into();
            e.settings.mining_node_addr =
                validate_endpoint(address.unwrap_or_default(), "ZKas mining node RPC")?;
        }
        _ => return Err("ZKas mining node mode must be local or custom".into()),
    }
    Ok(())
}

/// Wait until a node can actually give the bridge work, then resume mining.
///
/// Runs on its own thread (see the call site in `setup`). Deliberately patient: a machine
/// that just lost power comes back with a node that is both starting AND behind, and the
/// honest options are to wait or to give up on a miner who asked to keep mining.
///
/// Gives up after `RESUME_MINING_DEADLINE`. The intent flag is left set either way, so the
/// next launch tries again — only the user's own Stop clears it.
fn wait_then_resume_mining(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    const RESUME_MINING_DEADLINE: std::time::Duration = std::time::Duration::from_secs(60 * 60);
    const POLL: std::time::Duration = std::time::Duration::from_secs(15);

    let rpc = {
        let state = app.state::<Mutex<Engine>>();
        let mut e = engine(&state);
        e.mining_zkas_rpc()?
    };

    // First the port, then the answer. `wait_for_node_listener` already exists for the
    // former and reports the last error rather than a bare timeout.
    wait_for_node_listener(&rpc, RESUME_MINING_DEADLINE)?;

    // Then sync. A listening node is not a useful node: the bridge refuses to build work
    // against one that is still catching up, so starting here would just burn the
    // supervisor's restart budget until it gave up and left mining silently off.
    let deadline = std::time::Instant::now() + RESUME_MINING_DEADLINE;
    loop {
        match tauri::async_runtime::block_on(query_node_rpc_with_deadline(
            &rpc,
            std::time::Duration::from_secs(8),
        )) {
            Ok((_, _, _, _, synced, _, _)) if synced => break,
            Ok(_) => {}
            Err(error) if std::time::Instant::now() >= deadline => {
                return Err(format!("node never became ready: {error}"));
            }
            Err(_) => {}
        }
        if std::time::Instant::now() >= deadline {
            return Err("node did not finish syncing in time".into());
        }
        std::thread::sleep(POLL);
    }

    let state = app.state::<Mutex<Engine>>();
    let mut e = engine(&state);
    let pid = resume_mining(&mut e, app)?;
    log_crash(&format!("resumed mining after restart (bridge pid {pid})"));
    Ok(())
}

/// Restart the last mining session on launch. See the call site in `setup`.
///
/// Reuses the persisted configuration rather than re-deriving it: the payout address, the
/// mode, the work source and the Stratum settings are all already saved, and re-deriving
/// them risks resuming with something the operator did not choose.
fn resume_mining(e: &mut Engine, app: &tauri::AppHandle) -> Result<u32, String> {
    let payout = e.settings.mining_payout.clone();
    if payout.is_empty() {
        // Sessions started before the payout was persisted. Nothing to resume TO, and
        // guessing an address is the one thing that must never happen with money.
        return Err("no saved payout address; start mining once from the Mine page".into());
    }
    let dual = e.settings.mining_mode == "dual";
    // Dual mining merges against a Kaspa parent, and the bridge cannot work without one.
    // Starting only the bridge here would reproduce precisely the symptom this whole
    // change exists to remove: hashrate apparently running while the Kaspa side sits at
    // "Starting" forever. A managed parent is ours to bring up; a `custom` one belongs to
    // the operator and we only use the address they configured.
    if dual && e.settings.kaspa_mode == "local" {
        e.start_local_kaspa_node(app)?;
        if !e.services.kaspa_node.running() {
            let error = e
                .services
                .kaspa_node
                .last_exit()
                .unwrap_or_else(|| "Kaspa node exited during startup".into());
            e.services.stop_kaspa_node(app);
            return Err(error);
        }
    }
    // No probe here: the caller has already waited for the node to answer and report
    // itself synced. A second one-shot check would only add a way to fail.
    match start_bridge(e, app, &payout, dual) {
        Ok(pid) => Ok(pid),
        Err(error) => {
            // Do not leave a parent node running for a merge that never started.
            if dual && e.settings.kaspa_mode == "local" {
                e.services.stop_kaspa_node(app);
            }
            Err(error)
        }
    }
}

fn start_bridge(
    e: &mut Engine,
    app: &tauri::AppHandle,
    payout: &str,
    dual: bool,
) -> Result<u32, String> {
    let binary = e
        .settings
        .bridge_binary
        .clone()
        .ok_or("Stratum bridge is not installed")?;
    if !e.services.bridge.running() {
        let config = e.bridge_config_path();
        let recovered =
            services::stop_orphaned_bridge_processes(std::path::Path::new(&binary), &config)?;
        if !recovered.is_empty() {
            log_crash(&format!(
                "recovered orphaned Stratum bridge process(es): {}",
                recovered
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        check_stratum_port(e.settings.stratum_port)?;
        check_bridge_control_ports()?;
    }
    let zkas_rpc = e.mining_zkas_rpc()?;
    let config = e.write_bridge_config(payout, dual, &zkas_rpc)?;
    let mut env = vec![
        ("RUST_LOG".into(), "info".into()),
        ("BRIDGE_ALLOW_UNSYNCED".into(), "0".into()),
        ("POOL_FALLBACK_ADDRESS".into(), payout.into()),
    ];
    if dual {
        env.push(("ZKAS_MERGED_MINING".into(), "1".into()));
        env.push(("ZKAS_KASPA_NODE".into(), e.settings.kaspa_node_addr.clone()));
        env.push(("ZKAS_KASPA_PAY".into(), e.settings.kaspa_payout.clone()));
    } else {
        env.push(("ZKAS_MERGED_MINING".into(), "0".into()));
    }
    e.services.start_bridge(
        app,
        ProcessSpec {
            service: "stratum-bridge",
            binary: PathBuf::from(binary),
            args: vec![
                "--node-mode".into(),
                "external".into(),
                "--config".into(),
                config.to_string_lossy().into_owned(),
            ],
            env,
            cwd: config.parent().unwrap_or(&e.config_dir).to_path_buf(),
        },
        e.settings.stratum_port,
        std::time::Duration::from_secs(30),
    )
}

#[tauri::command]
fn start_solo_mining(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Engine>>,
    stratum_port: u16,
    payout_address: String,
    min_share_diff: f64,
    zkas_mode: String,
    zkas_node_addr: Option<String>,
) -> Result<u32, String> {
    let payout = validate_payout_address(&payout_address, "zkas")?;
    let mut e = engine(&state);
    configure_mining_zkas_source(&mut e, &zkas_mode, zkas_node_addr.as_deref())?;
    let zkas_rpc = e.mining_zkas_rpc()?;
    probe_node(&zkas_rpc)?;
    if !min_share_diff.is_finite() || !(1.0..=1_000_000_000_000.0).contains(&min_share_diff) {
        return Err("starting share difficulty must be between 1 and 1 trillion".into());
    }
    e.settings.stratum_port = stratum_port;
    e.settings.min_share_diff = min_share_diff;
    e.settings.mining_mode = "solo".into();
    // Records intent so a reboot resumes. This used to be set to FALSE here, which is why
    // `mining_auto_start` was never enabled by anything.
    e.settings.mining_auto_start = true;
    e.settings.mining_payout = payout.clone();
    e.services.stop_bridge(&app);
    let pid = start_bridge(&mut e, &app, &payout, false)?;
    e.save_settings();
    Ok(pid)
}

#[tauri::command]
fn start_dual_mining(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Engine>>,
    stratum_port: u16,
    zkas_payout: String,
    kaspa_payout: String,
    kaspa_mode: String,
    kaspa_node_addr: Option<String>,
    min_share_diff: f64,
    zkas_mode: String,
    zkas_node_addr: Option<String>,
) -> Result<u32, String> {
    if !services::bridge_supported() {
        return Err(format!(
            "dual mining is not available on {}/{} because no verified bridge is published",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    }
    let zkas_payout = validate_payout_address(&zkas_payout, "zkas")?;
    let kaspa_payout = validate_payout_address(&kaspa_payout, "kaspa")?;
    if !matches!(kaspa_mode.as_str(), "local" | "custom") {
        return Err("Kaspa node mode must be local or custom".into());
    }
    if !min_share_diff.is_finite() || !(1.0..=1_000_000_000_000.0).contains(&min_share_diff) {
        return Err("starting share difficulty must be between 1 and 1 trillion".into());
    }
    let mut e = engine(&state);
    configure_mining_zkas_source(&mut e, &zkas_mode, zkas_node_addr.as_deref())?;
    let zkas_rpc = e.mining_zkas_rpc()?;
    probe_node(&zkas_rpc)?;
    e.settings.stratum_port = stratum_port;
    e.settings.min_share_diff = min_share_diff;
    e.settings.kaspa_mode = kaspa_mode.clone();
    e.settings.kaspa_payout = kaspa_payout;
    e.settings.kaspa_node_addr = if kaspa_mode == "local" {
        LOCAL_KASPA_RPC.into()
    } else {
        validate_endpoint(kaspa_node_addr.as_deref().unwrap_or(""), "Kaspa node RPC")?
    };
    let mut kaspa_started_here = false;
    if kaspa_mode == "custom" {
        probe_node(&e.settings.kaspa_node_addr)?;
    } else {
        let kaspa_was_running = e.services.kaspa_node.running();
        e.start_local_kaspa_node(&app)?;
        kaspa_started_here = !kaspa_was_running;
        if !e.services.kaspa_node.running() {
            let error = e
                .services
                .kaspa_node
                .last_exit()
                .unwrap_or_else(|| "Kaspa node exited during startup".into());
            e.services.stop_kaspa_node(&app);
            return Err(error);
        }
        // The released dual bridge intentionally degrades to ZKAS-only when it
        // cannot connect to the Kaspa parent during construction; it does not
        // later promote that session. Never race it against a freshly spawned
        // Kaspa RPC or the UI would say dual while KAS work was silently absent.
        if let Err(error) =
            wait_for_node_listener(LOCAL_KASPA_RPC, std::time::Duration::from_secs(20))
        {
            let detail = e.services.kaspa_node.last_exit();
            if !kaspa_was_running {
                // This command owns the new child. Do not leave a failed launch in
                // the supervisor's restart loop after reporting an error to the user.
                e.services.stop_kaspa_node(&app);
            }
            return Err(match detail {
                Some(detail) => format!("{error}; Kaspa node {detail}"),
                None => error,
            });
        }
    }
    e.settings.mining_mode = "dual".into();
    e.settings.mining_auto_start = true;
    e.settings.mining_payout = zkas_payout.clone();
    e.services.stop_bridge(&app);
    let pid = match start_bridge(&mut e, &app, &zkas_payout, true) {
        Ok(pid) => pid,
        Err(error) => {
            if kaspa_started_here {
                e.services.stop_kaspa_node(&app);
            }
            return Err(error);
        }
    };
    e.save_settings();
    Ok(pid)
}

#[tauri::command]
fn stop_mining(app: tauri::AppHandle, state: tauri::State<'_, Mutex<Engine>>) {
    let mut e = engine(&state);
    e.services.stop_cpu_miner(&app);
    e.services.stop_bridge(&app);
    if e.settings.kaspa_mode == "local" {
        e.services.stop_kaspa_node(&app);
    }
    e.settings.mining_auto_start = false;
    e.save_settings();
}

#[tauri::command]
fn start_cpu_miner(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Engine>>,
    threads: usize,
    mining_address: String,
) -> Result<u32, String> {
    let address = validate_payout_address(&mining_address, "zkas")?;
    if threads == 0 || threads > 256 {
        return Err("CPU miner threads must be between 1 and 256".into());
    }
    let mut e = engine(&state);
    let rpc = e.mining_zkas_rpc()?;
    probe_node(&rpc)?;
    let binary = e
        .settings
        .miner_binary
        .clone()
        .ok_or("ZKas CPU miner is not installed")?;
    let cwd = e.data_dir.join("run/cpu-miner");
    e.services.start_cpu_miner(
        &app,
        ProcessSpec {
            service: "cpu-miner",
            binary: PathBuf::from(binary),
            args: vec![
                "--rpc-server".into(),
                rpc,
                "--mining-address".into(),
                address,
                "--threads".into(),
                threads.to_string(),
            ],
            env: vec![("RUST_LOG".into(), "info".into())],
            cwd,
        },
    )
}

#[tauri::command]
fn stop_cpu_miner(app: tauri::AppHandle, state: tauri::State<'_, Mutex<Engine>>) {
    engine(&state).services.stop_cpu_miner(&app);
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct BridgeApiStats {
    #[serde(rename = "networkHashrate")]
    network_hashrate: f64,
    #[serde(rename = "activeWorkers")]
    active_workers: u64,
    #[serde(rename = "totalBlocks")]
    total_blocks: u64,
    #[serde(rename = "totalKasBlocks")]
    total_kas_blocks: u64,
    #[serde(rename = "totalShares")]
    total_shares: u64,
}

#[derive(Clone, Serialize)]
struct MiningStatus {
    mode: String,
    bridge_running: bool,
    bridge_pid: Option<u32>,
    cpu_miner_running: bool,
    cpu_miner_pid: Option<u32>,
    kaspa_node_running: bool,
    kaspa_node_pid: Option<u32>,
    zkas_rpc: String,
    zkas_rpc_connected: bool,
    zkas_synced: Option<bool>,
    zkas_rpc_error: Option<String>,
    kaspa_rpc: Option<String>,
    kaspa_rpc_connected: bool,
    kaspa_synced: Option<bool>,
    kaspa_rpc_error: Option<String>,
    stratum_port: u16,
    active_workers: u64,
    shares_accepted: u64,
    blocks_found: u64,
    kas_blocks_found: u64,
    network_hashrate: f64,
    bridge_error: Option<String>,
}

#[tauri::command]
async fn mining_status(state: tauri::State<'_, Mutex<Engine>>) -> Result<MiningStatus, String> {
    let (
        mode,
        bridge_running,
        bridge_pid,
        miner_running,
        miner_pid,
        kaspa_running,
        kaspa_pid,
        port,
        last_exit,
        zkas_rpc,
        zkas_should_probe,
        kaspa_rpc,
        kaspa_should_probe,
    ) = {
        let mut e = engine(&state);
        let bridge_pid = e.services.bridge.pid();
        let miner_pid = e.services.cpu_miner.pid();
        let kaspa_pid = e.services.kaspa_node.pid();
        (
            e.settings.mining_mode.clone(),
            bridge_pid.is_some(),
            bridge_pid,
            miner_pid.is_some(),
            miner_pid,
            kaspa_pid.is_some() || e.settings.kaspa_mode == "custom",
            kaspa_pid,
            e.settings.stratum_port,
            e.services.bridge.last_exit(),
            if e.settings.mining_node_mode == "local" {
                LOCAL_ZKAS_RPC.to_string()
            } else {
                e.settings.mining_node_addr.clone()
            },
            e.settings.mining_node_mode == "custom" || e.services.zkas_node.running(),
            (e.settings.kaspa_mode != "disabled").then(|| e.settings.kaspa_node_addr.clone()),
            e.settings.kaspa_mode == "custom" || kaspa_pid.is_some(),
        )
    };
    let zkas_status = if zkas_should_probe {
        Some(
            tokio::time::timeout(std::time::Duration::from_secs(6), query_node_rpc_with_deadline(&zkas_rpc, std::time::Duration::from_secs(3)))
                .await,
        )
    } else {
        None
    };
    let kaspa_status = if kaspa_should_probe {
        if let Some(address) = kaspa_rpc.as_deref() {
            Some(
                tokio::time::timeout(std::time::Duration::from_secs(6), query_node_rpc_with_deadline(address, std::time::Duration::from_secs(3)))
                    .await,
            )
        } else {
            None
        }
    } else {
        None
    };
    let rpc_fields = |status: Option<
        Result<
            Result<(u64, u64, u64, usize, bool, usize, f64), String>,
            tokio::time::error::Elapsed,
        >,
    >| {
        match status {
            Some(Ok(Ok((_, _, _, _, synced, _, _)))) => (true, Some(synced), None),
            Some(Ok(Err(error))) => (false, None, Some(error)),
            Some(Err(_)) => (false, None, Some("RPC status timed out".to_string())),
            None => (false, None, None),
        }
    };
    let (zkas_rpc_connected, zkas_synced, zkas_rpc_error) = rpc_fields(zkas_status);
    let (kaspa_rpc_connected, kaspa_synced, kaspa_rpc_error) = rpc_fields(kaspa_status);
    let local = if bridge_running {
        reqwest::Client::new()
            .get("http://127.0.0.1:18114/api/stats")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .ok()
            .and_then(|response| (response.status().is_success()).then_some(response))
    } else {
        None
    };
    let stats = match local {
        Some(response) => response.json::<BridgeApiStats>().await.unwrap_or_default(),
        None => BridgeApiStats::default(),
    };
    Ok(MiningStatus {
        mode,
        bridge_running,
        bridge_pid,
        cpu_miner_running: miner_running,
        cpu_miner_pid: miner_pid,
        kaspa_node_running: kaspa_running,
        kaspa_node_pid: kaspa_pid,
        zkas_rpc,
        zkas_rpc_connected,
        zkas_synced,
        zkas_rpc_error,
        kaspa_rpc,
        kaspa_rpc_connected,
        kaspa_synced,
        kaspa_rpc_error,
        stratum_port: port,
        active_workers: stats.active_workers,
        shares_accepted: stats.total_shares,
        blocks_found: stats.total_blocks,
        kas_blocks_found: stats.total_kas_blocks,
        network_hashrate: stats.network_hashrate,
        bridge_error: (!bridge_running).then_some(last_exit).flatten(),
    })
}

/// Relay the explorer's public, read-only API into the desktop webview.
///
/// The URL host is fixed here and the path is tightly allow-listed. This is not a
/// generic HTTP proxy (which would quietly punch a hole through the desktop CSP),
/// and no wallet token, seed, cookie, or Authorization header is forwarded.
#[tauri::command]
async fn public_explorer_get(path: String) -> Result<serde_json::Value, String> {
    let clean = path.trim();
    if clean.len() > 1_024
        || !clean.starts_with('/')
        || clean.starts_with("//")
        || clean.contains("..")
        || clean.contains('\\')
        || clean.bytes().any(|b| b.is_ascii_control())
    {
        return Err("invalid explorer path".into());
    }
    let allowed_info = [
        "/info/blockdag",
        "/info/network",
        "/info/nodes",
        "/info/relay",
        "/info/shielded",
        "/info/halving",
        "/info/coinsupply",
    ];
    let fixed = allowed_info.contains(&clean) || clean == "/blocks/recent";
    let pulse = clean
        .strip_prefix("/info/pulse?window=")
        .is_some_and(|window| matches!(window, "15m" | "1h" | "12h" | "24h" | "7d" | "30d"));
    let detail = clean
        .strip_prefix("/blocks/")
        .or_else(|| clean.strip_prefix("/transactions/"))
        .is_some_and(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()));
    if !(fixed || pulse || detail) {
        return Err("explorer path is not allowed".into());
    }
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(format!("zkas-desktop/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("valid explorer HTTP client")
    });
    // api.zkas.info has no public DNS record. The hosted wallet's /chain route
    // is the stable, same read-only explorer backend used by the web wallet.
    client
        .get(format!("https://wallet.zkas.info/chain{clean}"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("cannot reach explorer: {e}"))?
        .error_for_status()
        .map_err(|e| format!("explorer returned an error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("explorer returned invalid JSON: {e}"))
}

#[derive(Clone, Serialize)]
struct SelfHostStatus {
    wallet_engine_running: bool,
    wallet_engine_url: Option<String>,
    node_mode: String,
    node_rpc: String,
    explorer_installed: bool,
    explorer_running: bool,
    explorer_pid: Option<u32>,
    explorer_url: String,
    explorer_last_exit: Option<String>,
    /// There is source code for the gateway, but no signed/hashed binary release.
    /// Keeping this explicit prevents a dead "Install" button from masquerading
    /// as a one-click service.
    gateway_release_available: bool,
    data_dir: String,
    backup_dir: String,
    autostart_enabled: bool,
    wallet_access: String,
    wallet_access_port: u16,
    wallet_public_url: String,
    wallet_access_url: Option<String>,
    wallet_access_token: Option<String>,
    lan_ip: Option<String>,
    lan_ips: Vec<String>,
    wallet_access_urls: Vec<String>,
    /// One pairing string per reachable address: address + API token + wallet selector.
    wallet_pairing_uris: Vec<String>,
    node_running: bool,
    node_public_p2p: bool,
    node_lan_rpc: bool,
}

#[tauri::command]
fn self_host_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Engine>>,
) -> SelfHostStatus {
    let mut e = engine(&state);
    let installed = e
        .settings
        .explorer_binary
        .as_ref()
        .is_some_and(|p| std::path::Path::new(p).is_file());
    let lan_ips = lan_ipv4s();
    let lan_ip = lan_ips.first().cloned();
    let wallet_access_urls: Vec<String> = match e.settings.wallet_access.as_str() {
        "lan" => lan_ips
            .iter()
            .map(|ip| format!("http://{ip}:{}", e.settings.wallet_access_port))
            .collect(),
        "wan" if !e.settings.wallet_public_url.is_empty() => {
            vec![e.settings.wallet_public_url.clone()]
        }
        _ => vec![],
    };
    // One string that carries everything a phone needs: address, the API's bearer token,
    // and the WALLET token that selects this computer's wallet. Without the third, a
    // paired device connects successfully and opens an empty wallet, which is
    // indistinguishable from losing your coins. Secrets live in the fragment so they
    // never reach a request line or an access log.
    let wallet_pairing_uris: Vec<String> = if e.settings.wallet_access == "device" {
        Vec::new()
    } else {
        wallet_access_urls
            .iter()
            .map(|url| {
                let scheme = if url.starts_with("https://") { "zkas+https" } else { "zkas+http" };
                let host_port = url.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
                format!(
                    "{scheme}://{host_port}#token={}&wallet={}&net=mainnet",
                    e.wallet_access_token, e.token
                )
            })
            .collect()
    };
    let wallet_access_url = match e.settings.wallet_access.as_str() {
        "lan" => wallet_access_urls.first().cloned(),
        "wan" => {
            (!e.settings.wallet_public_url.is_empty()).then(|| e.settings.wallet_public_url.clone())
        }
        _ => None,
    };
    let node_running = e.services.zkas_node.running();
    let wallet_engine_running = e.port != 0
        && !e
            .walletd_task
            .as_ref()
            .is_some_and(tokio::task::JoinHandle::is_finished);
    SelfHostStatus {
        wallet_engine_running,
        wallet_engine_url: wallet_engine_running.then(|| format!("http://127.0.0.1:{}", e.port)),
        node_mode: e.settings.mode.clone(),
        node_rpc: e.settings.rpc_addr(),
        explorer_installed: installed,
        explorer_running: e.services.explorer.running(),
        explorer_pid: e.services.explorer.pid(),
        explorer_url: format!("http://127.0.0.1:{EXPLORER_API_PORT}"),
        explorer_last_exit: e.services.explorer.last_exit(),
        gateway_release_available: false,
        data_dir: e.data_dir.to_string_lossy().into_owned(),
        backup_dir: e.backup_dir().to_string_lossy().into_owned(),
        autostart_enabled: app.autolaunch().is_enabled().unwrap_or(false),
        wallet_access: e.settings.wallet_access.clone(),
        wallet_access_port: e.settings.wallet_access_port,
        wallet_public_url: e.settings.wallet_public_url.clone(),
        wallet_access_url,
        wallet_access_token: (e.settings.wallet_access != "device")
            .then(|| e.wallet_access_token.clone()),
        lan_ip,
        lan_ips,
        wallet_access_urls,
        wallet_pairing_uris,
        node_running,
        node_public_p2p: e.settings.node_public_p2p,
        node_lan_rpc: e.settings.node_lan_rpc,
    }
}

#[tauri::command]
fn set_host_access(
    state: tauri::State<'_, Mutex<Engine>>,
    wallet_access: String,
    wallet_access_port: u16,
    wallet_public_url: String,
    node_lan_rpc: bool,
    node_public_p2p: bool,
) -> Result<(), String> {
    if !matches!(wallet_access.as_str(), "device" | "lan" | "wan") {
        return Err("wallet access must be device, lan, or wan".into());
    }
    if wallet_access_port < 1024 {
        return Err("wallet service port must be from 1024 to 65535".into());
    }
    let public_url = wallet_public_url.trim().trim_end_matches('/').to_string();
    if wallet_access == "wan" {
        let parsed = reqwest::Url::parse(&public_url).map_err(|_| {
            "enter the public HTTPS wallet URL, for example https://wallet.example.com"
        })?;
        if parsed.scheme() != "https" || parsed.host_str().is_none() {
            return Err("internet wallet access requires an HTTPS URL".into());
        }
    }

    let mut e = engine(&state);
    let node_changed =
        e.settings.node_lan_rpc != node_lan_rpc || e.settings.node_public_p2p != node_public_p2p;
    if node_changed && e.services.zkas_node.running() {
        return Err("stop the managed node before changing its network access".into());
    }
    let previous = e.settings.clone();
    e.settings.wallet_access = wallet_access;
    e.settings.wallet_access_port = wallet_access_port;
    e.settings.wallet_public_url = public_url;
    e.settings.node_lan_rpc = node_lan_rpc;
    e.settings.node_public_p2p = node_public_p2p;

    // A locked wallet has no engine to restart; the new policy applies on its
    // next unlock. An active engine is switched transactionally.
    if e.port != 0 {
        e.start_walletd();
        if let Err(error) = e.wait_walletd_ready(std::time::Duration::from_secs(15)) {
            e.settings = previous;
            e.start_walletd();
            let _ = e.wait_walletd_ready(std::time::Duration::from_secs(15));
            return Err(format!("{error}; restored the previous Host settings"));
        }
    }
    e.save_settings();
    Ok(())
}

#[tauri::command]
fn set_desktop_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    (if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    })
    .map_err(|error| format!("could not update start-on-boot: {error}"))
}

#[tauri::command]
fn start_explorer_backend(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Engine>>,
) -> Result<u32, String> {
    engine(&state).start_explorer_api(&app)
}

#[tauri::command]
fn stop_explorer_backend(app: tauri::AppHandle, state: tauri::State<'_, Mutex<Engine>>) {
    engine(&state).services.stop_explorer(&app);
}

/// Refuse a node address nothing is listening on. A TCP connect (with DNS
/// resolution) catches the wrong-host/wrong-port/typo cases in seconds; a node
/// that accepts TCP but speaks the wrong protocol still leaves the app alive —
/// the daemon serves HTTP and shows "node not connected" — so TCP is the right
/// depth for this gate.
fn probe_node(addr: &str) -> Result<(), String> {
    use std::net::ToSocketAddrs;
    let mut addrs = addr.to_socket_addrs().map_err(|e| {
        format!(
            "cannot resolve \"{addr}\": {e} — settings unchanged, still using the previous node"
        )
    })?;
    let target = addrs
        .next()
        .ok_or_else(|| format!("\"{addr}\" resolves to nothing — settings unchanged"))?;
    std::net::TcpStream::connect_timeout(&target, std::time::Duration::from_secs(4)).map_err(
        |e| {
            format!(
            "no node answering at {addr} ({e}). Check the address and that the node is running \
             with gRPC on that port — settings unchanged, still using the previous node"
        )
        },
    )?;
    Ok(())
}

fn wait_for_node_listener(addr: &str, timeout: std::time::Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        match probe_node(addr) {
            Ok(()) => return Ok(()),
            Err(error) => last = error,
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    Err(format!(
        "node RPC at {addr} did not become ready within {} seconds{}",
        timeout.as_secs(),
        (!last.is_empty())
            .then(|| format!(": {last}"))
            .unwrap_or_default()
    ))
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Mutex<Engine>>() {
        let mut e = engine(&state);
        // A hidden plaintext/watch-only wallet has no passphrase ceremony to
        // perform, so restore its loopback daemon before the UI reloads. An
        // encrypted wallet deliberately remains stopped and opens locked.
        if e.port == 0 && e.vault() != zkas_walletd::VaultState::Encrypted {
            e.start_walletd();
        }
    }
    if let Some(window) = app.webview_windows().values().next() {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Closing to tray locks/stops walletd beneath the still-mounted web UI.
        // Reload on restore so boot re-reads the engine port and vault state.
        let _ = window.eval("location.reload()");
    }
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
            #[cfg(desktop)]
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let config_dir = app.path().app_config_dir().expect("app config dir");
            let data_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&config_dir).ok();
            std::fs::create_dir_all(&data_dir).ok();
            let mut app_engine = Engine::new(config_dir, data_dir);
            if app_engine.settings.node_auto_start {
                if let Err(error) = app_engine.start_local_node(app.handle()) {
                    log_crash(&format!("managed ZKas node did not start: {error}"));
                    app_engine.settings.node_auto_start = false;
                    if app_engine.settings.mode == "local" {
                        app_engine.settings.mode = "remote".into();
                    }
                    app_engine.save_settings();
                }
            } else if app_engine.settings.mode == "local" {
                // Never leave walletd aimed at a local port with no process.
                // Running a node and selecting a wallet source are independent.
                app_engine.settings.mode = "remote".into();
                app_engine.save_settings();
            }
            // Resume mining if that is what the machine was doing when it went down.
            //
            // Reported by an operator running two ASICs: after a power cut the wallet
            // came back but mining did not, so they auto-started `stratum-bridge.exe`
            // themselves from the saved config. That works — hashrate returns — but the
            // Mine page still reads "Stopped", because the app decides that from a child
            // process it owns and it owns nothing it did not spawn.
            //
            // Resuming here fixes both halves at once: the bridge runs again AND the app
            // owns it, so the UI is right and the existing crash-restart supervision
            // applies. `start_bridge` reclaims orphaned bridge processes matching this
            // binary and config first, so an operator who keeps their own autostart is
            // taken over cleanly rather than colliding on the Stratum port.
            //
            // Deliberately best-effort and NON-fatal. Mining depends on a node that may
            // still be starting, on hardware that may have changed, and on a payout
            // address that must be present. A failure is logged and the intent is left
            // ALONE so the next launch tries again — a power cut mid-boot must not
            // silently un-enrol a miner. The user's own Stop is the only thing that
            // clears it.
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
            if app_engine.vault() != zkas_walletd::VaultState::Encrypted {
                app_engine.start_walletd();
            }
            let resume_mining_wanted = app_engine.settings.mining_auto_start;
            app.manage(Mutex::new(app_engine));
            // Resume mining if that is what this machine was doing when it went down.
            //
            // On a THREAD, and never on the startup path. Two reasons, both of which the
            // first version of this got wrong:
            //
            //   * The node was launched microseconds ago by the block above. It is not
            //     listening yet — a kaspad takes seconds to open its gRPC port and longer
            //     to be useful — so probing it once here fails on every cold boot, which
            //     is precisely the case this feature exists for.
            //   * Waiting for it synchronously would block `setup`, so the window would
            //     not appear until mining was sorted out. Nobody wants a wallet that
            //     takes a minute to open because a miner is warming up.
            //
            // So: wait for the node to answer AND report itself synced, then start. The
            // bridge runs with BRIDGE_ALLOW_UNSYNCED=0 and would exit immediately against
            // a node still catching up — after a long outage that catch-up is minutes to
            // hours, which is exactly when a miner is least able to babysit it.
            if resume_mining_wanted {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(error) = wait_then_resume_mining(&handle) {
                        log_crash(&format!("mining did not resume after restart: {error}"));
                    }
                });
            }
            #[cfg(desktop)]
            {
                let open = MenuItem::with_id(app, "open", "Open ZKas Wallet", true, None::<&str>)?;
                let quit =
                    MenuItem::with_id(app, "quit", "Quit and stop services", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;
                let mut tray = TrayIconBuilder::new()
                    .tooltip("ZKas Wallet")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "open" => show_main_window(app),
                        "quit" => {
                            if let Some(state) = app.try_state::<Mutex<Engine>>() {
                                let mut e = engine(&state);
                                e.lock();
                                e.services.stop_all(app);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }
            // A node or bridge can die after startup (OOM, driver fault, transient
            // file error). Reap it and restart only while the user still wants it
            // running, with bounded exponential backoff so a bad binary never
            // becomes a tight crash loop.
            let supervisor = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let Some(state) = supervisor.try_state::<Mutex<Engine>>() else {
                    break;
                };
                engine(&state).services.tick(&supervisor);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if let Some(state) = window.app_handle().try_state::<Mutex<Engine>>() {
                        let mut e = engine(&state);
                        if e.services.any_background_running() {
                            // Keep node/mining/explorer children alive, but never
                            // keep an unlocked spending engine alive invisibly.
                            e.lock();
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if let Some(state) = window.app_handle().try_state::<Mutex<Engine>>() {
                        let mut e = engine(&state);
                        e.lock();
                        e.services.stop_all(window.app_handle());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            wallet_config,
            wallet_api_request,
            set_node_source,
            control_config,
            install_local_components,
            node_status,
            walletd_status,
            start_node_preset,
            stop_node,
            set_node_options,
            service_logs,
            start_solo_mining,
            start_dual_mining,
            stop_mining,
            local_network_info,
            start_cpu_miner,
            stop_cpu_miner,
            mining_status,
            public_explorer_get,
            self_host_status,
            set_host_access,
            start_explorer_backend,
            stop_explorer_backend,
            set_desktop_autostart,
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

#[cfg(test)]
mod control_tests {
    use super::*;

    const ZKAS_ADDRESS: &str =
        "zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh";
    const KASPA_ADDRESS: &str =
        "kaspa:qrap6w97jjpwrp59yj8fd3tfkz9jkxjd2spsjn4yxfpw60zzpdzsxnddcggqe";

    #[test]
    fn home_lan_address_ranks_before_vpn_address() {
        use std::net::Ipv4Addr;
        assert!(
            lan_ipv4_rank(&Ipv4Addr::new(192, 168, 15, 227))
                < lan_ipv4_rank(&Ipv4Addr::new(10, 10, 0, 4))
        );
    }

    #[test]
    fn endpoint_input_is_normalized_and_injection_is_rejected() {
        assert_eq!(
            validate_endpoint(" grpc://127.0.0.1:16110/ ", "RPC").unwrap(),
            "127.0.0.1:16110"
        );
        assert!(validate_endpoint("127.0.0.1", "RPC").is_err());
        assert!(validate_endpoint("node:70000", "RPC").is_err());
        assert!(validate_endpoint("node:16110\nother: 1", "RPC").is_err());
    }

    #[test]
    fn payout_networks_cannot_be_swapped() {
        assert_eq!(
            validate_payout_address(ZKAS_ADDRESS, "zkas").unwrap(),
            ZKAS_ADDRESS
        );
        assert_eq!(
            validate_payout_address(KASPA_ADDRESS, "kaspa").unwrap(),
            KASPA_ADDRESS
        );
        assert!(validate_payout_address(KASPA_ADDRESS, "zkas").is_err());
        assert!(validate_payout_address(ZKAS_ADDRESS, "kaspa").is_err());
    }

    #[test]
    fn managed_chain_ports_do_not_collide() {
        assert_eq!(LOCAL_ZKAS_RPC, "127.0.0.1:16810");
        assert_eq!(LOCAL_ZKAS_RPC_LAN, "0.0.0.0:16810");
        assert_eq!(LOCAL_ZKAS_P2P_PRIVATE, "127.0.0.1:16811");
        assert_eq!(LOCAL_KASPA_RPC, "127.0.0.1:16110");
        assert_eq!(LOCAL_KASPA_P2P_PRIVATE, "127.0.0.1:16111");
        assert_ne!(LOCAL_ZKAS_RPC, LOCAL_KASPA_RPC);
        assert_ne!(LOCAL_ZKAS_P2P_PRIVATE, LOCAL_KASPA_P2P_PRIVATE);
    }

    #[test]
    fn desktop_wallet_bridge_is_not_a_generic_localhost_proxy() {
        for path in [
            "/api/status",
            "/api/wallet/prepare",
            "/api/wallet/submit",
            "/api/verify",
        ] {
            assert!(allowed_wallet_api_path(path));
        }
        assert!(!allowed_wallet_api_path("/health"));
        assert!(!allowed_wallet_api_path("/api/admin"));
        assert!(!allowed_wallet_api_path(
            "/api/status?redirect=http://example.com"
        ));
    }

    fn one_shot_http(status: &str) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response =
            format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        let task = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 256];
            let _ = stream.read(&mut request);
            stream.write_all(response.as_bytes()).unwrap();
        });
        (address, task)
    }

    #[test]
    fn wallet_engine_readiness_requires_http_200() {
        let (healthy, healthy_task) = one_shot_http("200 OK");
        assert!(walletd_health_ready(healthy));
        healthy_task.join().unwrap();

        let (unhealthy, unhealthy_task) = one_shot_http("503 Service Unavailable");
        assert!(!walletd_health_ready(unhealthy));
        unhealthy_task.join().unwrap();
    }

    fn http_response(
        address: std::net::SocketAddr,
        path: &str,
        headers: &[(&str, &str)],
    ) -> String {
        let mut stream =
            std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(2))
                .unwrap();
        let mut request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("Connection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn http_status(address: std::net::SocketAddr, path: &str, headers: &[(&str, &str)]) -> u16 {
        http_response(address, path, headers)
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse().ok())
            .unwrap()
    }

    fn cors_preflight(address: std::net::SocketAddr, origin: &str) -> String {
        cors_preflight_with(address, origin, &[])
    }

    fn cors_preflight_with(
        address: std::net::SocketAddr,
        origin: &str,
        extra: &[(&str, &str)],
    ) -> String {
        let mut stream =
            std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(2))
                .unwrap();
        let mut request = format!(
            "OPTIONS /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {origin}\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: authorization,x-wallet-token\r\n"
        );
        for (name, value) in extra {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("Connection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn lan_wallet_engine_is_live_and_bearer_gated() {
        let root = std::env::temp_dir().join(format!(
            "zkas-desktop-lan-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = root.join("config");
        let data = root.join("data");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let mut engine = Engine::new(config, data);
        engine.settings.wallet_access = "lan".into();
        engine.settings.wallet_access_port = port;
        engine.start_walletd();
        engine
            .wait_walletd_ready(std::time::Duration::from_secs(5))
            .unwrap();

        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        assert!(walletd_api_ready(
            address,
            &engine.token,
            Some(&engine.wallet_access_token)
        ));
        assert!(!walletd_api_ready(address, &engine.token, None));
        assert_eq!(http_status(address, "/health", &[]), 200);
        assert_eq!(http_status(address, "/api/status", &[]), 401);
        // Foreground clients use WebViews and therefore preflight the bearer +
        // wallet-token headers. Cover every installed-shell origin here; native
        // Android background sync is not a browser and skips CORS.
        for origin in [
            "http://tauri.localhost",
            "https://localhost",
            "capacitor://localhost",
        ] {
            let response = cors_preflight(address, origin).to_ascii_lowercase();
            assert!(response.starts_with("http/1.1 200 "), "{response}");
            assert!(
                response.contains(&format!("access-control-allow-origin: {origin}")),
                "{response}"
            );
            assert!(response.contains("authorization"), "{response}");
            assert!(response.contains("x-wallet-token"), "{response}");

            // Chromium cannot resolve a synthetic app origin to an IP address
            // space, so it treats one as public and preflights Private Network
            // Access before touching a LAN address. An unanswered PNA preflight
            // fails the request with no status for the page to report.
            let private_network = cors_preflight_with(
                address,
                origin,
                &[("Access-Control-Request-Private-Network", "true")],
            )
            .to_ascii_lowercase();
            assert!(
                private_network.contains("access-control-allow-private-network: true"),
                "{private_network}"
            );

            // A rejected bearer must still be a READABLE rejection. Without CORS
            // headers on the 401 the browser withholds the response entirely and
            // the app can only report an opaque transport failure — indisting-
            // uishable from a wrong address, a closed port or a firewall.
            let unauthorized = http_response(
                address,
                "/api/status",
                &[
                    ("Origin", origin),
                    ("Authorization", "Bearer not-the-right-token"),
                    ("X-Wallet-Token", &engine.token),
                ],
            )
            .to_ascii_lowercase();
            assert!(unauthorized.starts_with("http/1.1 401 "), "{unauthorized}");
            assert!(
                unauthorized.contains(&format!("access-control-allow-origin: {origin}")),
                "{unauthorized}"
            );
        }
        assert_eq!(
            http_status(
                address,
                "/api/status",
                &[
                    (
                        "Authorization",
                        &format!("Bearer {}", engine.wallet_access_token)
                    ),
                    ("X-Wallet-Token", &engine.token),
                ],
            ),
            200
        );
        engine.stop_walletd();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn wallet_engine_http_stays_available_while_node_is_offline() {
        let root = std::env::temp_dir().join(format!(
            "zkas-desktop-offline-node-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = root.join("config");
        let data = root.join("data");

        // Reserve and release a local port so the address is well-formed but no
        // node can answer it. Wallet HTTP must not wait behind gRPC reconnects.
        let unavailable = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable_port = unavailable.local_addr().unwrap().port();
        drop(unavailable);

        let mut engine = Engine::new(config, data);
        engine.settings.mode = "custom".into();
        engine.settings.node_addr = format!("127.0.0.1:{unavailable_port}");
        engine.start_walletd();
        engine
            .wait_walletd_ready(std::time::Duration::from_secs(5))
            .expect("wallet HTTP must start even when its node is offline");

        let address = std::net::SocketAddr::from(([127, 0, 0, 1], engine.port));
        assert_eq!(http_status(address, "/health", &[]), 200);
        engine.stop_walletd();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn generated_bridge_yaml_keeps_instance_fields_nested() {
        let yaml = bridge_config_yaml(
            "127.0.0.1:16810",
            "127.0.0.1:16110",
            KASPA_ADDRESS,
            5555,
            8192.0,
        );
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        let root = parsed.as_mapping().unwrap();
        let instances = root
            .get(serde_yaml::Value::String("instances".into()))
            .and_then(serde_yaml::Value::as_sequence)
            .unwrap();
        let instance = instances
            .first()
            .and_then(serde_yaml::Value::as_mapping)
            .unwrap();
        assert_eq!(
            instance
                .get(serde_yaml::Value::String("stratum_port".into()))
                .and_then(serde_yaml::Value::as_str),
            Some("0.0.0.0:5555")
        );
        assert_eq!(
            instance
                .get(serde_yaml::Value::String("min_share_diff".into()))
                .and_then(serde_yaml::Value::as_f64),
            Some(8192.0)
        );
        assert_eq!(
            instance
                .get(serde_yaml::Value::String("prom_port".into()))
                .and_then(serde_yaml::Value::as_str),
            Some("127.0.0.1:18114")
        );
        assert!(!root.contains_key(serde_yaml::Value::String("min_share_diff".into())));
    }

    #[test]
    fn corrupted_persisted_controls_fall_back_to_safe_defaults() {
        let mut settings = Settings {
            mode: "broken".into(),
            node_preset: "magic".into(),
            kaspa_mode: "unknown".into(),
            mining_mode: "pool".into(),
            stratum_port: 80,
            min_share_diff: -1.0,
            wallet_access: "public-everything".into(),
            wallet_access_port: 80,
            ..Settings::default()
        };
        settings.normalize();
        assert_eq!(settings.mode, "remote");
        assert_eq!(settings.node_preset, "shielded");
        assert_eq!(settings.kaspa_mode, "disabled");
        assert_eq!(settings.mining_mode, "solo");
        assert_eq!(settings.stratum_port, 5555);
        assert_eq!(settings.min_share_diff, 8192.0);
        assert_eq!(settings.wallet_access, "device");
        assert_eq!(settings.wallet_access_port, 8501);
    }

    #[test]
    fn legacy_node_install_is_offered_the_pinned_release() {
        let mut settings = Settings {
            node_binary: Some("/existing/zkas-node".into()),
            ..Settings::default()
        };
        assert!(zkas_node_update_available(&settings, true));
        settings.node_release = Some(services::ZKAS_RELEASE.into());
        assert!(!zkas_node_update_available(&settings, true));
        assert!(!zkas_node_update_available(&settings, false));
    }

    #[test]
    fn legacy_bridge_install_is_offered_the_pinned_release() {
        let mut settings = Settings {
            bridge_binary: Some("/existing/stratum-bridge".into()),
            ..Settings::default()
        };
        assert!(bridge_update_available(&settings, true));
        settings.bridge_release = Some(services::BRIDGE_RELEASE.into());
        assert!(!bridge_update_available(&settings, true));
        assert!(!bridge_update_available(&settings, false));
    }

    #[test]
    fn wallet_tokens_cannot_escape_the_wallet_directory() {
        assert!(valid_wallet_token("0123456789abcdef0123456789abcdef"));
        assert!(valid_wallet_token("AbCdEfGhIjKlMnOpQrStUvWxYz012345"));
        assert!(!valid_wallet_token("../../wallets/target.json"));
        assert!(!valid_wallet_token("short"));
    }

    #[test]
    fn backup_files_are_validated_and_never_overwritten() {
        let folder = std::env::temp_dir().join(format!(
            "zkas-desktop-backup-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let document = r#"{"magic":"zkas-wallet-backup","version":2}"#;
        let first = write_unique_backup(&folder, document).unwrap();
        let second = write_unique_backup(&folder, document).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            read_backup_document(first.to_str().unwrap()).unwrap(),
            document
        );
        assert!(validate_backup_document(r#"{"magic":"something-else"}"#).is_err());
        let _ = std::fs::remove_dir_all(folder);
    }
}
