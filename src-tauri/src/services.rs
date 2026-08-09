//! Local node/mining process supervision and verified binary installation.
//!
//! Nodes and the Stratum bridge intentionally remain child processes. A crash in
//! mining code must not take the wallet (and its unlocked key material) down with
//! it, and release binaries can be updated independently of the desktop shell.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const MAX_LOG_LINES: usize = 2_000;
const HEALTHY_RUN: Duration = Duration::from_secs(60);
const MAX_RESTART_DELAY: u64 = 30;
const MAX_RESTART_ATTEMPTS: u32 = 5;
pub const ZKAS_RELEASE: &str = "zkas-v1.0.6";
pub const BRIDGE_RELEASE: &str = "v1.0.7";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceLog {
    pub at_unix_ms: u64,
    pub service: String,
    pub stream: String,
    pub line: String,
}

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static LOG_FILE_LOCK: Mutex<()> = Mutex::new(());
const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;

pub fn set_log_path(path: PathBuf) {
    let _ = LOG_PATH.set(path);
}

#[derive(Clone, Debug, Serialize)]
pub struct ServiceStateEvent {
    pub service: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadProgress {
    pub component: String,
    pub received: u64,
    pub total: Option<u64>,
    pub phase: String,
}

#[derive(Clone, Debug)]
pub struct ProcessSpec {
    pub service: &'static str,
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

pub struct ManagedProcess {
    child: Option<Child>,
    desired: bool,
    spec: Option<ProcessSpec>,
    started_at: Option<Instant>,
    restart_attempts: u32,
    restart_after: Option<Instant>,
    last_exit: Option<String>,
}

impl Default for ManagedProcess {
    fn default() -> Self {
        Self {
            child: None,
            desired: false,
            spec: None,
            started_at: None,
            restart_attempts: 0,
            restart_after: None,
            last_exit: None,
        }
    }
}

impl ManagedProcess {
    pub fn running(&mut self) -> bool {
        self.reap_if_exited();
        self.child.is_some()
    }

    pub fn pid(&mut self) -> Option<u32> {
        self.reap_if_exited();
        self.child.as_ref().map(Child::id)
    }

    pub fn last_exit(&self) -> Option<String> {
        self.last_exit.clone()
    }

    fn reap_if_exited(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                let ran_for = self.started_at.map(|t| t.elapsed()).unwrap_or_default();
                self.last_exit = Some(format!("exited with {status}"));
                self.child = None;
                self.started_at = None;
                if self.desired {
                    if ran_for >= HEALTHY_RUN {
                        self.restart_attempts = 0;
                    }
                    self.restart_attempts = self.restart_attempts.saturating_add(1);
                    if self.restart_attempts >= MAX_RESTART_ATTEMPTS {
                        self.desired = false;
                        self.restart_after = None;
                        self.last_exit = Some(format!(
                            "{status}; automatic restart stopped after {MAX_RESTART_ATTEMPTS} failed starts"
                        ));
                    } else {
                        let delay = (1u64 << self.restart_attempts.min(5)).min(MAX_RESTART_DELAY);
                        self.restart_after = Some(Instant::now() + Duration::from_secs(delay));
                    }
                }
                true
            }
            Ok(None) => false,
            Err(e) => {
                self.last_exit = Some(format!("could not inspect process: {e}"));
                false
            }
        }
    }

    fn start(
        &mut self,
        app: &AppHandle,
        logs: Arc<Mutex<VecDeque<ServiceLog>>>,
        spec: ProcessSpec,
    ) -> Result<u32, String> {
        self.reap_if_exited();
        if let Some(child) = self.child.as_ref() {
            self.desired = true;
            return Ok(child.id());
        }
        if !spec.binary.is_file() {
            return Err(format!(
                "{} binary was not found at {}",
                spec.service,
                spec.binary.display()
            ));
        }
        std::fs::create_dir_all(&spec.cwd).map_err(|e| {
            format!(
                "cannot create {} working directory: {e}",
                spec.cwd.display()
            )
        })?;

        let mut command = Command::new(&spec.binary);
        command
            .args(&spec.args)
            .envs(spec.env.iter().map(|(k, v)| (k, v)))
            .current_dir(&spec.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Keep children out of the desktop process's console group. This also
            // gives a future graceful CTRL_BREAK shutdown a process-group target.
            command.creation_flags(0x0000_0200);
        }

        push_log(
            &logs,
            ServiceLog {
                at_unix_ms: now_ms(),
                service: spec.service.to_string(),
                stream: "app".into(),
                line: format!(
                    "launching {} {}",
                    spec.binary.display(),
                    spec.args.join(" ")
                ),
            },
        );
        let mut child = command.spawn().map_err(|e| {
            let message = format!("failed to start {}: {e}", spec.service);
            push_log(
                &logs,
                ServiceLog {
                    at_unix_ms: now_ms(),
                    service: spec.service.to_string(),
                    stream: "app".into(),
                    line: message.clone(),
                },
            );
            message
        })?;
        let pid = child.id();
        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(
                app.clone(),
                Arc::clone(&logs),
                spec.service,
                "stdout",
                stdout,
            );
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(
                app.clone(),
                Arc::clone(&logs),
                spec.service,
                "stderr",
                stderr,
            );
        }
        push_log(
            &logs,
            ServiceLog {
                at_unix_ms: now_ms(),
                service: spec.service.to_string(),
                stream: "app".into(),
                line: format!("started PID {pid}"),
            },
        );
        self.spec = Some(spec.clone());
        self.child = Some(child);
        self.desired = true;
        self.started_at = Some(Instant::now());
        self.restart_after = None;
        self.last_exit = None;
        let _ = app.emit(
            "service-state",
            ServiceStateEvent {
                service: spec.service.into(),
                running: true,
                pid: Some(pid),
                detail: "started".into(),
            },
        );
        Ok(pid)
    }

    fn stop(&mut self, app: &AppHandle, service: &'static str) {
        self.desired = false;
        self.restart_after = None;
        self.restart_attempts = 0;
        self.spec = None;
        if let Some(mut child) = self.child.take() {
            terminate_child(&mut child);
        }
        self.started_at = None;
        let _ = app.emit(
            "service-state",
            ServiceStateEvent {
                service: service.into(),
                running: false,
                pid: None,
                detail: "stopped by user".into(),
            },
        );
    }

    fn tick(&mut self, app: &AppHandle, logs: Arc<Mutex<VecDeque<ServiceLog>>>) {
        let exited = self.reap_if_exited();
        if exited {
            if let Some(spec) = self.spec.as_ref() {
                push_log(
                    &logs,
                    ServiceLog {
                        at_unix_ms: now_ms(),
                        service: spec.service.into(),
                        stream: "app".into(),
                        line: self.last_exit.clone().unwrap_or_else(|| "exited".into()),
                    },
                );
                let _ = app.emit(
                    "service-state",
                    ServiceStateEvent {
                        service: spec.service.into(),
                        running: false,
                        pid: None,
                        detail: self.last_exit.clone().unwrap_or_else(|| "exited".into()),
                    },
                );
            }
        }
        if !self.desired
            || self.child.is_some()
            || self.restart_after.is_some_and(|t| t > Instant::now())
        {
            return;
        }
        let Some(spec) = self.spec.clone() else {
            return;
        };
        if let Err(e) = self.start(app, logs, spec.clone()) {
            self.last_exit = Some(e.clone());
            self.restart_attempts = self.restart_attempts.saturating_add(1);
            if self.restart_attempts >= MAX_RESTART_ATTEMPTS {
                self.desired = false;
                self.restart_after = None;
                self.last_exit = Some(format!(
                    "{e}; automatic restart stopped after {MAX_RESTART_ATTEMPTS} failed starts"
                ));
            } else {
                let delay = (1u64 << self.restart_attempts.min(5)).min(MAX_RESTART_DELAY);
                self.restart_after = Some(Instant::now() + Duration::from_secs(delay));
            }
            let _ = app.emit(
                "service-state",
                ServiceStateEvent {
                    service: spec.service.into(),
                    running: false,
                    pid: None,
                    detail: self.last_exit.clone().unwrap_or(e),
                },
            );
        }
    }
}

fn owned_process_matches(
    binary: &Path,
    process_exe: Option<&Path>,
    command: &[OsString],
    required_args: &[OsString],
) -> bool {
    let canonical_binary = std::fs::canonicalize(binary).unwrap_or_else(|_| binary.to_path_buf());
    let same_path = |path: &Path| {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()) == canonical_binary
    };
    let same_binary = process_exe.is_some_and(same_path)
        || command
            .first()
            .map(PathBuf::from)
            .is_some_and(|path| same_path(&path));
    same_binary
        && required_args
            .iter()
            .all(|required| command.iter().any(|actual| actual == required))
}

fn bridge_process_matches(
    binary: &Path,
    process_exe: Option<&Path>,
    command: &[OsString],
    config: &Path,
) -> bool {
    let required = [
        OsString::from("--config"),
        config.as_os_str().to_os_string(),
    ];
    if !required
        .iter()
        .all(|expected| command.iter().any(|actual| actual == expected))
    {
        return false;
    }
    if owned_process_matches(binary, process_exe, command, &required) {
        return true;
    }
    // An app update may replace/rename the executable while the old child is
    // still alive. The generated config path is unique to this wallet install;
    // accept an older executable only when it is still recognisably the bridge
    // and carries that exact app-owned config. Never match by port alone.
    let expected_name = binary
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let actual_name = process_exe
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .or_else(|| {
            command.first().map(PathBuf::from).and_then(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
            })
        })
        .unwrap_or_default();
    let bridge_name = |name: &str| {
        name == expected_name
            || name == "stratum-bridge"
            || name == "stratum-bridge.exe"
            || name.starts_with("stratum-bridge.old")
    };
    bridge_name(&actual_name)
}

/// Stop an app-owned child left behind by a force-quit, crash, or updater.
/// Matching requires both the exact installed executable and app-unique CLI
/// arguments. A foreign bridge/node using the same network port is never killed.
fn stop_orphaned_processes(
    binary: &Path,
    required_args: &[OsString],
    label: &str,
) -> Result<Vec<u32>, String> {
    use sysinfo::{ProcessesToUpdate, Signal, System};

    let mut system = System::new_all();
    let matches: Vec<_> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            owned_process_matches(binary, process.exe(), process.cmd(), required_args)
                .then_some(*pid)
        })
        .collect();
    if matches.is_empty() {
        return Ok(Vec::new());
    }

    for pid in &matches {
        if let Some(process) = system.process(*pid) {
            // Nodes flush RocksDB on SIGINT. Windows does not support this
            // signal through sysinfo, so it falls through to the forced stop.
            let graceful = process.kill_with(Signal::Interrupt).unwrap_or(false)
                || process.kill_with(Signal::Term).unwrap_or(false);
            if !graceful && !process.kill() {
                return Err(format!("could not stop orphaned {label} process {pid}"));
            }
        }
    }

    let graceful_deadline = Instant::now() + Duration::from_secs(12);
    loop {
        system.refresh_processes(ProcessesToUpdate::Some(&matches));
        if matches.iter().all(|pid| system.process(*pid).is_none()) {
            return Ok(matches.iter().map(|pid| pid.as_u32()).collect());
        }
        if Instant::now() >= graceful_deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    for pid in &matches {
        if let Some(process) = system.process(*pid) {
            let _ = process.kill();
        }
    }
    let kill_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        system.refresh_processes(ProcessesToUpdate::Some(&matches));
        if matches.iter().all(|pid| system.process(*pid).is_none()) {
            return Ok(matches.iter().map(|pid| pid.as_u32()).collect());
        }
        if Instant::now() >= kill_deadline {
            let alive = matches
                .iter()
                .filter(|pid| system.process(**pid).is_some())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "orphaned {label} process did not stop (PID {alive}); close it before starting it again"
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Nodes are owned by their exact binary plus their app-specific data folder.
/// Merely deleting RocksDB's LOCK file is unsafe while the process is alive.
pub fn stop_orphaned_node_processes(binary: &Path, appdir: &Path) -> Result<Vec<u32>, String> {
    stop_orphaned_processes(
        binary,
        &[OsString::from(format!(
            "--appdir={}",
            appdir.to_string_lossy()
        ))],
        "node",
    )
}

/// A wallet-managed bridge is uniquely identified by the installed executable
/// and this wallet's generated config path. This reclaims Stratum 5555 and the
/// loopback health/dashboard ports without touching a separately installed pool.
pub fn stop_orphaned_bridge_processes(binary: &Path, config: &Path) -> Result<Vec<u32>, String> {
    use sysinfo::{ProcessesToUpdate, Signal, System};

    let mut system = System::new_all();
    let matches: Vec<_> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            bridge_process_matches(binary, process.exe(), process.cmd(), config).then_some(*pid)
        })
        .collect();
    if matches.is_empty() {
        return Ok(Vec::new());
    }
    for pid in &matches {
        if let Some(process) = system.process(*pid) {
            let graceful = process.kill_with(Signal::Interrupt).unwrap_or(false)
                || process.kill_with(Signal::Term).unwrap_or(false);
            if !graceful && !process.kill() {
                return Err(format!(
                    "could not stop orphaned Stratum bridge process {pid}"
                ));
            }
        }
    }
    let graceful_deadline = Instant::now() + Duration::from_secs(12);
    loop {
        system.refresh_processes(ProcessesToUpdate::Some(&matches));
        if matches.iter().all(|pid| system.process(*pid).is_none()) {
            return Ok(matches.iter().map(|pid| pid.as_u32()).collect());
        }
        if Instant::now() >= graceful_deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    for pid in &matches {
        if let Some(process) = system.process(*pid) {
            let _ = process.kill();
        }
    }
    let kill_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        system.refresh_processes(ProcessesToUpdate::Some(&matches));
        if matches.iter().all(|pid| system.process(*pid).is_none()) {
            return Ok(matches.iter().map(|pid| pid.as_u32()).collect());
        }
        if Instant::now() >= kill_deadline {
            let alive = matches
                .iter()
                .filter(|pid| system.process(**pid).is_some())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "orphaned Stratum bridge did not stop (PID {alive}); close it before starting mining"
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Ask node-like children to flush their databases before falling back to a
/// hard kill. On Unix, SIGINT follows the same shutdown path as Ctrl+C in both
/// kaspad and the bridge. Windows' `Child` API has no portable console-signal
/// equivalent, so `kill` remains the reliable last resort there.
fn terminate_child(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: the PID comes from the live `Child`; SIGINT does not access
        // memory and failure is handled by the forced-kill fallback below.
        let _ = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGINT) };
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub struct ServiceManager {
    pub zkas_node: ManagedProcess,
    pub kaspa_node: ManagedProcess,
    pub bridge: ManagedProcess,
    pub cpu_miner: ManagedProcess,
    pub explorer: ManagedProcess,
    logs: Arc<Mutex<VecDeque<ServiceLog>>>,
}

#[derive(Clone)]
pub struct ServiceLogger {
    service: &'static str,
    logs: Arc<Mutex<VecDeque<ServiceLog>>>,
}

impl ServiceLogger {
    pub fn record(&self, stream: &'static str, line: impl Into<String>) {
        push_log(
            &self.logs,
            ServiceLog {
                at_unix_ms: now_ms(),
                service: self.service.into(),
                stream: stream.into(),
                line: line.into(),
            },
        );
    }
}

impl Default for ServiceManager {
    fn default() -> Self {
        let mut existing = VecDeque::with_capacity(MAX_LOG_LINES);
        if let Some(path) = LOG_PATH.get() {
            if let Ok(file) = File::open(path) {
                for line in BufReader::new(file).lines().map_while(Result::ok) {
                    if let Ok(entry) = serde_json::from_str::<ServiceLog>(&line) {
                        if existing.len() == MAX_LOG_LINES {
                            existing.pop_front();
                        }
                        existing.push_back(entry);
                    }
                }
            }
        }
        Self {
            zkas_node: ManagedProcess::default(),
            kaspa_node: ManagedProcess::default(),
            bridge: ManagedProcess::default(),
            cpu_miner: ManagedProcess::default(),
            explorer: ManagedProcess::default(),
            logs: Arc::new(Mutex::new(existing)),
        }
    }
}

impl ServiceManager {
    pub fn logger(&self, service: &'static str) -> ServiceLogger {
        ServiceLogger {
            service,
            logs: Arc::clone(&self.logs),
        }
    }

    /// True only for child services that are useful with the window hidden.
    /// The embedded wallet engine is deliberately excluded: hiding the window
    /// locks it so no spending secret remains live in the tray.
    pub fn any_background_running(&mut self) -> bool {
        self.zkas_node.running()
            || self.kaspa_node.running()
            || self.bridge.running()
            || self.cpu_miner.running()
            || self.explorer.running()
    }

    pub fn start_zkas_node(&mut self, app: &AppHandle, spec: ProcessSpec) -> Result<u32, String> {
        self.zkas_node.restart_attempts = 0;
        self.zkas_node.start(app, Arc::clone(&self.logs), spec)
    }

    pub fn start_kaspa_node(&mut self, app: &AppHandle, spec: ProcessSpec) -> Result<u32, String> {
        self.kaspa_node.restart_attempts = 0;
        self.kaspa_node.start(app, Arc::clone(&self.logs), spec)
    }

    pub fn start_bridge(
        &mut self,
        app: &AppHandle,
        spec: ProcessSpec,
        stratum_port: u16,
        timeout: Duration,
    ) -> Result<u32, String> {
        self.bridge.restart_attempts = 0;
        let pid = self.bridge.start(app, Arc::clone(&self.logs), spec)?;
        let deadline = Instant::now() + timeout;
        let ready = |port| {
            std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                Duration::from_millis(150),
            )
            .is_ok()
        };
        loop {
            if !self.bridge.running() {
                let exit = self
                    .bridge
                    .last_exit()
                    .unwrap_or_else(|| "exited before opening Stratum".into());
                let detail = self
                    .logs(Some("stratum-bridge"), 8)
                    .into_iter()
                    .map(|line| line.line)
                    .collect::<Vec<_>>()
                    .join(" | ");
                self.bridge.stop(app, "stratum-bridge");
                return Err(if detail.is_empty() {
                    format!("Stratum bridge {exit}")
                } else {
                    format!("Stratum bridge {exit}: {detail}")
                });
            }
            // The bridge is useful only when miners can reach Stratum AND its
            // health/dashboard endpoints are live. Returning earlier made the UI
            // say "Mining" while the child was still connecting or about to exit.
            if ready(stratum_port) && ready(18080) && ready(18114) {
                return Ok(pid);
            }
            if Instant::now() >= deadline {
                let detail = self
                    .logs(Some("stratum-bridge"), 8)
                    .into_iter()
                    .map(|line| line.line)
                    .collect::<Vec<_>>()
                    .join(" | ");
                self.bridge.stop(app, "stratum-bridge");
                return Err(if detail.is_empty() {
                    format!(
                        "Stratum bridge did not open port {stratum_port} and its dashboard within {} seconds",
                        timeout.as_secs()
                    )
                } else {
                    format!(
                        "Stratum bridge was not ready within {} seconds: {detail}",
                        timeout.as_secs()
                    )
                });
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn start_cpu_miner(&mut self, app: &AppHandle, spec: ProcessSpec) -> Result<u32, String> {
        self.cpu_miner.restart_attempts = 0;
        self.cpu_miner.start(app, Arc::clone(&self.logs), spec)
    }

    pub fn start_explorer(&mut self, app: &AppHandle, spec: ProcessSpec) -> Result<u32, String> {
        self.explorer.restart_attempts = 0;
        self.explorer.start(app, Arc::clone(&self.logs), spec)
    }

    pub fn stop_zkas_node(&mut self, app: &AppHandle) {
        self.zkas_node.stop(app, "zkas-node");
    }

    pub fn stop_kaspa_node(&mut self, app: &AppHandle) {
        self.kaspa_node.stop(app, "kaspa-node");
    }

    pub fn stop_bridge(&mut self, app: &AppHandle) {
        self.bridge.stop(app, "stratum-bridge");
    }

    pub fn stop_cpu_miner(&mut self, app: &AppHandle) {
        self.cpu_miner.stop(app, "cpu-miner");
    }

    pub fn stop_explorer(&mut self, app: &AppHandle) {
        self.explorer.stop(app, "explorer-api");
    }

    pub fn stop_all(&mut self, app: &AppHandle) {
        // Consumers first, then their nodes.
        self.stop_cpu_miner(app);
        self.stop_bridge(app);
        self.stop_explorer(app);
        self.stop_kaspa_node(app);
        self.stop_zkas_node(app);
    }

    pub fn tick(&mut self, app: &AppHandle) {
        let logs = Arc::clone(&self.logs);
        self.zkas_node.tick(app, Arc::clone(&logs));
        self.kaspa_node.tick(app, Arc::clone(&logs));
        self.bridge.tick(app, Arc::clone(&logs));
        self.cpu_miner.tick(app, Arc::clone(&logs));
        self.explorer.tick(app, logs);
    }

    pub fn logs(&self, service: Option<&str>, limit: usize) -> Vec<ServiceLog> {
        let guard = self.logs.lock().unwrap_or_else(|p| p.into_inner());
        let take = limit.clamp(1, MAX_LOG_LINES);
        let mut out: Vec<_> = guard
            .iter()
            .rev()
            .filter(|line| service.is_none_or(|s| line.service == s))
            .take(take)
            .cloned()
            .collect();
        out.reverse();
        out
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn push_log(logs: &Arc<Mutex<VecDeque<ServiceLog>>>, line: ServiceLog) {
    {
        let mut guard = logs.lock().unwrap_or_else(|p| p.into_inner());
        if guard.len() == MAX_LOG_LINES {
            guard.pop_front();
        }
        guard.push_back(line.clone());
    }
    let Some(path) = LOG_PATH.get() else { return };
    let _file_guard = LOG_FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() >= MAX_LOG_FILE_BYTES) {
        let rotated = path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(path, rotated);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        if let Ok(json) = serde_json::to_string(&line) {
            let _ = writeln!(file, "{json}");
        }
    }
}

fn spawn_log_reader<R: Read + Send + 'static>(
    app: AppHandle,
    logs: Arc<Mutex<VecDeque<ServiceLog>>>,
    service: &'static str,
    stream: &'static str,
    reader: R,
) {
    std::thread::spawn(move || {
        for raw in BufReader::new(reader).lines() {
            let line = match raw {
                Ok(v) => v,
                Err(e) => format!("log stream error: {e}"),
            };
            let event = ServiceLog {
                at_unix_ms: now_ms(),
                service: service.into(),
                stream: stream.into(),
                line,
            };
            push_log(&logs, event.clone());
            let _ = app.emit("service-log", event);
        }
    });
}

#[derive(Clone, Debug, Deserialize)]
pub struct InstallSelection {
    pub zkas: bool,
    pub bridge: bool,
    pub kaspa: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct InstalledComponents {
    pub zkas_node: Option<String>,
    pub zkas_miner: Option<String>,
    pub explorer: Option<String>,
    pub bridge: Option<String>,
    pub kaspa_node: Option<String>,
}

#[derive(Clone)]
struct ArchiveSpec {
    component: &'static str,
    url: &'static str,
    sha256: &'static str,
}

struct ExtractTarget<'a> {
    entries: &'a [&'a str],
    destination: PathBuf,
}

/// Install pinned release artifacts. The SHA-256 digests are GitHub's release
/// asset digests for the immutable tags named in each URL; an interrupted or
/// tampered download is never executed.
pub async fn install_components(
    app: &AppHandle,
    data_dir: &Path,
    selection: InstallSelection,
) -> Result<InstalledComponents, String> {
    if !selection.zkas && !selection.bridge && !selection.kaspa {
        return Err("choose at least one component".into());
    }
    let bin_dir = data_dir.join("bin");
    let downloads = data_dir.join("downloads");
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|e| format!("cannot create binary directory: {e}"))?;
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|e| format!("cannot create download directory: {e}"))?;

    let exe = if cfg!(windows) { ".exe" } else { "" };
    let mut installed = InstalledComponents::default();

    // The ZKas archive supplies the node, diagnostic CPU miner and local
    // explorer. The merged-mining bridge is always installed from its own
    // independently verified release below.
    if selection.zkas {
        let spec = zkas_archive()?;
        let archive = download_verified(app, &downloads, &spec).await?;
        let node_dest = bin_dir.join(format!("zkas-node{exe}"));
        let miner_dest = bin_dir.join(format!("zkas-miner{exe}"));
        let explorer_dest = bin_dir.join(format!("zkas-api{exe}"));
        let mut targets = Vec::new();
        targets.push(ExtractTarget {
            entries: if cfg!(windows) {
                &["bin/kaspad.exe", "kaspad.exe"]
            } else {
                &["bin/kaspad", "kaspad"]
            },
            destination: node_dest.clone(),
        });
        targets.push(ExtractTarget {
            entries: if cfg!(windows) {
                &["bin/zkas-miner.exe", "zkas-miner.exe"]
            } else {
                &["bin/zkas-miner", "zkas-miner"]
            },
            destination: miner_dest.clone(),
        });
        targets.push(ExtractTarget {
            entries: if cfg!(windows) {
                &["bin/zkas-api.exe", "zkas-api.exe"]
            } else {
                &["bin/zkas-api", "zkas-api"]
            },
            destination: explorer_dest.clone(),
        });
        extract_exact(app, spec.component, archive, targets).await?;
        installed.zkas_node = Some(node_dest.to_string_lossy().into_owned());
        installed.zkas_miner = Some(miner_dest.to_string_lossy().into_owned());
        installed.explorer = Some(explorer_dest.to_string_lossy().into_owned());
    }

    // Use only the solo-dual-mode release whose CI executes every native binary
    // and verifies its KAS+ZKAS merged-mining and dashboard capability markers.
    if selection.bridge {
        let spec = bridge_archive()?;
        let archive = download_verified(app, &downloads, &spec).await?;
        let dest = bin_dir.join(format!("stratum-bridge{exe}"));
        let entries: &[&str] = if cfg!(windows) {
            &["stratum-bridge.exe", "bin/stratum-bridge.exe"]
        } else {
            &["stratum-bridge", "bin/stratum-bridge"]
        };
        extract_exact(
            app,
            spec.component,
            archive,
            vec![ExtractTarget {
                entries,
                destination: dest.clone(),
            }],
        )
        .await?;
        installed.bridge = Some(dest.to_string_lossy().into_owned());
    }

    if selection.kaspa {
        let spec = kaspa_archive()?;
        let archive = download_verified(app, &downloads, &spec).await?;
        let dest = bin_dir.join(format!("kaspa-node{exe}"));
        let entries: &[&str] = if cfg!(windows) {
            &["bin/kaspad.exe", "kaspad.exe"]
        } else {
            &["bin/kaspad", "kaspad"]
        };
        extract_exact(
            app,
            spec.component,
            archive,
            vec![ExtractTarget {
                entries,
                destination: dest.clone(),
            }],
        )
        .await?;
        installed.kaspa_node = Some(dest.to_string_lossy().into_owned());
    }

    Ok(installed)
}

async fn download_verified(
    app: &AppHandle,
    dir: &Path,
    spec: &ArchiveSpec,
) -> Result<PathBuf, String> {
    let final_path = dir.join(format!("{}.zip", spec.component));
    if final_path.is_file() && file_sha256(&final_path)? == spec.sha256 {
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                component: spec.component.into(),
                received: 1,
                total: Some(1),
                phase: "verified cached download".into(),
            },
        );
        return Ok(final_path);
    }
    let part = dir.join(format!("{}.zip.part", spec.component));
    let _ = tokio::fs::remove_file(&part).await;
    let client = reqwest::Client::builder()
        .user_agent(format!("zkas-desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("cannot create download client: {e}"))?;
    let response = client
        .get(spec.url)
        .send()
        .await
        .map_err(|e| format!("{} download failed: {e}", spec.component))?
        .error_for_status()
        .map_err(|e| format!("{} download failed: {e}", spec.component))?;
    let total = response.content_length();
    let mut received = 0u64;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("cannot create download: {e}"))?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{} download interrupted: {e}", spec.component))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("cannot write download: {e}"))?;
        received += chunk.len() as u64;
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                component: spec.component.into(),
                received,
                total,
                phase: "downloading".into(),
            },
        );
    }
    file.flush()
        .await
        .map_err(|e| format!("cannot finish download: {e}"))?;
    drop(file);
    let actual = file_sha256(&part)?;
    if actual != spec.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("{} failed SHA-256 verification", spec.component));
    }
    replace_file(&part, &final_path)?;
    let _ = app.emit(
        "download-progress",
        DownloadProgress {
            component: spec.component.into(),
            received,
            total,
            phase: "verified".into(),
        },
    );
    Ok(final_path)
}

async fn extract_exact(
    app: &AppHandle,
    component: &'static str,
    archive: PathBuf,
    targets: Vec<ExtractTarget<'static>>,
) -> Result<(), String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let file =
            File::open(&archive).map_err(|e| format!("cannot open {}: {e}", archive.display()))?;
        let mut zip =
            zip::ZipArchive::new(file).map_err(|e| format!("invalid {component} archive: {e}"))?;
        for target in targets {
            let mut found = None;
            for candidate in target.entries {
                if let Ok(index) = zip.index_for_name(candidate).ok_or(()) {
                    found = Some(index);
                    break;
                }
            }
            let index = found.ok_or_else(|| {
                format!(
                    "{component} archive does not contain {}",
                    target.entries.join(" or ")
                )
            })?;
            let mut entry = zip
                .by_index(index)
                .map_err(|e| format!("cannot read {component} archive: {e}"))?;
            if let Some(parent) = target.destination.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            }
            let temp = target.destination.with_extension("installing");
            let mut output = File::create(&temp)
                .map_err(|e| format!("cannot create {}: {e}", temp.display()))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|e| format!("cannot extract {}: {e}", target.destination.display()))?;
            output
                .flush()
                .map_err(|e| format!("cannot flush {}: {e}", temp.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("cannot mark {} executable: {e}", temp.display()))?;
            }
            replace_file(&temp, &target.destination)?;
        }
        let _ = handle.emit(
            "download-progress",
            DownloadProgress {
                component: component.into(),
                received: 1,
                total: Some(1),
                phase: "installed".into(),
            },
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("{component} extraction task failed: {e}"))?
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    let old = to.with_extension("old");
    let _ = std::fs::remove_file(&old);
    if to.exists() {
        std::fs::rename(to, &old).map_err(|e| format!("cannot replace {}: {e}", to.display()))?;
    }
    if let Err(e) = std::fs::rename(from, to) {
        if old.exists() {
            let _ = std::fs::rename(&old, to);
        }
        return Err(format!("cannot install {}: {e}", to.display()));
    }
    let _ = std::fs::remove_file(old);
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn zkas_archive() -> Result<ArchiveSpec, String> {
    Ok(ArchiveSpec {
        component: "zkas-v1.0.6-linux-x64",
        url: "https://github.com/firecash/zkas-rusty/releases/download/zkas-v1.0.6/zkas-zkas-v1.0.6-linux-amd64.zip",
        sha256: "1709b7a01b5b88bf06b91a01a8df104cf831a09805e44d21f41d8e9767ce3ce8",
    })
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn zkas_archive() -> Result<ArchiveSpec, String> {
    Ok(ArchiveSpec {
        component: "zkas-v1.0.6-windows-x64",
        url: "https://github.com/firecash/zkas-rusty/releases/download/zkas-v1.0.6/zkas-zkas-v1.0.6-win64.zip",
        sha256: "8b63c491096f12fd70d57a079d062934fd6ccc326e1c75e2f001aa9305b2d830",
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn zkas_archive() -> Result<ArchiveSpec, String> {
    Ok(ArchiveSpec {
        component: "zkas-v1.0.6-macos-arm64",
        url: "https://github.com/firecash/zkas-rusty/releases/download/zkas-v1.0.6/zkas-zkas-v1.0.6-osx-arm64.zip",
        sha256: "22cd34540bf678b602a01438ae67bd16741d7c155fac8c622884cd9493d0429c",
    })
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn zkas_archive() -> Result<ArchiveSpec, String> {
    Ok(ArchiveSpec {
        component: "zkas-v1.0.6-macos-x64",
        url: "https://github.com/firecash/zkas-rusty/releases/download/zkas-v1.0.6/zkas-zkas-v1.0.6-osx-x86_64.zip",
        sha256: "24b6d5f9d1ab31266d5bc0fca9a5021e7b4aa8e28ae4d71a06f75f15305b06f5",
    })
}

#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64")
)))]
fn zkas_archive() -> Result<ArchiveSpec, String> {
    Err("no verified ZKas release is published for this platform yet".into())
}

fn bridge_archive_for(os: &str, arch: &str) -> Result<ArchiveSpec, String> {
    let (component, url, sha256) = match (os, arch) {
        ("linux", "x86_64") => (
            "solo-dual-bridge-v1.0.7-linux-x64",
            "https://github.com/firecash/solo-dual-mode/releases/download/v1.0.7/solo-dual-mode-linux-x64.zip",
            "271c32854c9865e616f41bbb113732d04c52ccf9e9d099e44d7803b77becede9",
        ),
        ("linux", "aarch64") => (
            "solo-dual-bridge-v1.0.7-linux-arm64",
            "https://github.com/firecash/solo-dual-mode/releases/download/v1.0.7/solo-dual-mode-linux-arm64.zip",
            "1357e85722398e8dd102a5a96e410efa7291a1b6e3117f5bfa7dfa76b5902020",
        ),
        ("macos", "x86_64") => (
            "solo-dual-bridge-v1.0.7-macos-x64",
            "https://github.com/firecash/solo-dual-mode/releases/download/v1.0.7/solo-dual-mode-macos-x64.zip",
            "9563e0dcbf1b4aea3318d05262560309b0d4112230aa1566fd3acfa640dfffd7",
        ),
        ("macos", "aarch64") => (
            "solo-dual-bridge-v1.0.7-macos-arm64",
            "https://github.com/firecash/solo-dual-mode/releases/download/v1.0.7/solo-dual-mode-macos-arm64.zip",
            "518dfced1f3ad0c3945dcc17ecdaaea9dbbdbdc35eeb39d3789de09d24fab989",
        ),
        ("windows", "x86_64") => (
            "solo-dual-bridge-v1.0.7-windows-x64",
            "https://github.com/firecash/solo-dual-mode/releases/download/v1.0.7/solo-dual-mode-windows-x64.zip",
            "d77432113eb479c481d5698aff9b1a78a83f982b3ee675eb84f4c266dd67febc",
        ),
        ("windows", "aarch64") => (
            "solo-dual-bridge-v1.0.7-windows-arm64",
            "https://github.com/firecash/solo-dual-mode/releases/download/v1.0.7/solo-dual-mode-windows-arm64.zip",
            "4247a4cd23cbe8fbbc0f94bb3958550d855af4449e2a798a00fd0e2f47d66099",
        ),
        _ => {
            return Err(format!(
                "a verified merged-mining bridge is not published for {os}/{arch}"
            ))
        }
    };
    Ok(ArchiveSpec {
        component,
        url,
        sha256,
    })
}

fn bridge_archive() -> Result<ArchiveSpec, String> {
    bridge_archive_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn bridge_supported() -> bool {
    bridge_archive().is_ok()
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn kaspa_archive() -> Result<ArchiveSpec, String> {
    Ok(ArchiveSpec {
        component: "kaspa-v2.0.1-linux-x64",
        url: "https://github.com/kaspanet/rusty-kaspa/releases/download/v2.0.1/rusty-kaspa-v2.0.1-linux-amd64.zip",
        sha256: "9d0ad0aedbe29670e3e2dde664462c526d30a2d2ff7274d18b1a310a127d1c13",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orphan_matching_never_claims_a_foreign_bridge() {
        let current = Path::new("/app/bin/stratum-bridge");
        let config = Path::new("/app/mining/bridge.yaml");
        let owned = vec![
            OsString::from("/app/bin/stratum-bridge.old"),
            OsString::from("--node-mode"),
            OsString::from("external"),
            OsString::from("--config"),
            config.as_os_str().to_os_string(),
        ];
        assert!(bridge_process_matches(
            current,
            Some(Path::new("/app/bin/stratum-bridge.old")),
            &owned,
            config,
        ));

        let foreign_config = vec![
            OsString::from("/usr/bin/stratum-bridge"),
            OsString::from("--config"),
            OsString::from("/home/miner/bridge.yaml"),
        ];
        assert!(!bridge_process_matches(
            current,
            Some(Path::new("/usr/bin/stratum-bridge")),
            &foreign_config,
            config,
        ));

        let unrelated_binary = vec![
            OsString::from("/tmp/not-a-bridge"),
            OsString::from("--config"),
            config.as_os_str().to_os_string(),
        ];
        assert!(!bridge_process_matches(
            current,
            Some(Path::new("/tmp/not-a-bridge")),
            &unrelated_binary,
            config,
        ));
    }

    fn assert_verified_release(spec: ArchiveSpec) {
        assert!(spec.url.starts_with("https://github.com/"));
        assert_eq!(spec.sha256.len(), 64);
        assert!(spec.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn platform_release_metadata_is_complete() {
        let zkas = zkas_archive().unwrap();
        assert!(zkas.component.contains(ZKAS_RELEASE));
        assert!(zkas.url.contains(ZKAS_RELEASE));
        assert_verified_release(zkas);
        assert_verified_release(kaspa_archive().unwrap());
        assert_verified_release(bridge_archive().unwrap());
    }

    #[test]
    fn merged_mining_release_covers_all_desktop_platforms() {
        let targets = [
            ("linux", "x86_64", "linux-x64"),
            ("linux", "aarch64", "linux-arm64"),
            ("macos", "x86_64", "macos-x64"),
            ("macos", "aarch64", "macos-arm64"),
            ("windows", "x86_64", "windows-x64"),
            ("windows", "aarch64", "windows-arm64"),
        ];
        for (os, arch, asset) in targets {
            let spec = bridge_archive_for(os, arch).unwrap();
            assert!(spec.component.contains(BRIDGE_RELEASE));
            assert!(spec.url.contains(BRIDGE_RELEASE));
            assert!(spec.url.ends_with(&format!("solo-dual-mode-{asset}.zip")));
            assert_verified_release(spec);
        }
        assert!(bridge_archive_for("android", "aarch64").is_err());
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn kaspa_archive() -> Result<ArchiveSpec, String> {
    Ok(ArchiveSpec {
        component: "kaspa-v2.0.1-windows-x64",
        url: "https://github.com/kaspanet/rusty-kaspa/releases/download/v2.0.1/rusty-kaspa-v2.0.1-win64.zip",
        sha256: "bec0710079baa612fa0776af9460ae8106193b6458974eb2ebdb9e233383bce8",
    })
}

#[cfg(all(
    target_os = "macos",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
fn kaspa_archive() -> Result<ArchiveSpec, String> {
    Ok(ArchiveSpec {
        component: "kaspa-v2.0.1-macos",
        url: "https://github.com/kaspanet/rusty-kaspa/releases/download/v2.0.1/rusty-kaspa-v2.0.1-osx.zip",
        sha256: "db7745f326e29eab4fa005e0f9ecca4649738e7c5fd7f4394d3edd663727c1f7",
    })
}

#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64")
)))]
fn kaspa_archive() -> Result<ArchiveSpec, String> {
    Err("no verified Kaspa node release is published for this platform yet".into())
}
