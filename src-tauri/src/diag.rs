//! The desktop half of the diagnostic log.
//!
//! One rotating JSONL store in `<app data>/logs/diag/` (10 files x 2 MB), shared by the
//! WebView (which sends its already-redacted batches through `diag_append`) and this shell
//! (process start and exit, an unclean previous session, panics, window focus, resource use,
//! and every line the shell already wrote to crash.log).
//!
//! Writes go through a channel to one writer thread, so neither the UI thread nor the async
//! runtime ever waits on the disk. The only synchronous write is a panic's, because the
//! process may be about to die.
//!
//! Nothing here sends anything anywhere. The files leave the machine only when the user
//! presses Export on the Diagnostics screen, which writes ONE file to their Downloads folder.
//!
//! `scrub` is a port of the free-text rules of `src/diag/redact.ts` (the canonical
//! implementation), held to the same `test/diag-redaction-vectors.json`.

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const FILES: usize = 10;
const FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE: usize = 16 * 1024;

pub const LEVEL_OFF: u8 = 0;
pub const LEVEL_NORMAL: u8 = 1;
pub const LEVEL_VERBOSE: u8 = 2;

struct Diag {
    dir: PathBuf,
    salt: String,
    sid: String,
    started: Instant,
    level: AtomicU8,
    seq: AtomicU64,
    tx: Mutex<Sender<Vec<String>>>,
    prev_unclean: bool,
    config_served: AtomicBool,
    known: Mutex<Vec<String>>,
}

static DIAG: OnceLock<Diag> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as i64;
    // Civil-from-days (Howard Hinnant), so no date crate is needed for a timestamp.
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

fn file_path(dir: &Path, i: usize) -> PathBuf {
    dir.join(format!("diag.{i}.jsonl"))
}

/// Append to the current file, rotating first if it is full. diag.0 is the newest.
fn write_lines(dir: &Path, lines: &[String]) {
    let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let current = file_path(dir, 0);
    if std::fs::metadata(&current).is_ok_and(|m| m.len() >= FILE_BYTES) {
        let _ = std::fs::remove_file(file_path(dir, FILES - 1));
        for i in (0..FILES - 1).rev() {
            let _ = std::fs::rename(file_path(dir, i), file_path(dir, i + 1));
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&current) {
        let mut buf = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
        for l in lines {
            buf.push_str(l);
            buf.push('\n');
        }
        let _ = f.write_all(buf.as_bytes());
    }
}

fn level_name(l: u8) -> &'static str {
    match l {
        LEVEL_OFF => "off",
        LEVEL_VERBOSE => "verbose",
        _ => "normal",
    }
}

fn parse_level(s: &str) -> u8 {
    match s.trim() {
        "off" => LEVEL_OFF,
        "verbose" => LEVEL_VERBOSE,
        _ => LEVEL_NORMAL,
    }
}

/// Start the store. Called first thing in `run()`, before the panic hook, so a crash during
/// start-up is on the record too. `dir` is the app data dir (the crash.log directory).
pub fn init(app_data: Option<PathBuf>) {
    let Some(base) = app_data else { return };
    let dir = base.join("logs").join("diag");
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let salt_path = dir.join("salt");
    let salt = std::fs::read_to_string(&salt_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or_else(|| {
            let s = random_hex(16);
            let _ = std::fs::write(&salt_path, &s);
            s
        });
    let level = std::fs::read_to_string(dir.join("level"))
        .map(|s| parse_level(&s))
        .unwrap_or(LEVEL_NORMAL);
    // A marker that exists only while a session is running. Finding it at start means the
    // last session never reached a clean exit: a crash, an OOM kill, a power cut, a kill -9.
    let marker = dir.join("running");
    let prev_unclean = marker.exists();
    let _ = std::fs::write(&marker, std::process::id().to_string());

    let (tx, rx) = channel::<Vec<String>>();
    let writer_dir = dir.clone();
    let _ = std::thread::Builder::new()
        .name("diag-writer".into())
        .spawn(move || {
            while let Ok(mut batch) = rx.recv() {
                // Coalesce whatever else is already waiting into one write.
                while let Ok(more) = rx.try_recv() {
                    batch.extend(more);
                }
                write_lines(&writer_dir, &batch);
            }
        });
    let _ = DIAG.set(Diag {
        dir,
        salt,
        sid: random_hex(6),
        started: Instant::now(),
        level: AtomicU8::new(level),
        seq: AtomicU64::new(0),
        tx: Mutex::new(tx),
        prev_unclean,
        config_served: AtomicBool::new(false),
        known: Mutex::new(Vec::new()),
    });
    let mut f = Map::new();
    f.insert("version".into(), json!(env!("CARGO_PKG_VERSION")));
    f.insert("pid".into(), json!(std::process::id()));
    emit("app", "process_start", "info", f);
    if prev_unclean {
        emit("app", "prev_unclean", "warn", Map::new());
    }
}

/// Let shell events reach the live tail on the Diagnostics screen.
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Values that must never appear in a line (the wallet token, which this shell knows).
pub fn set_known_secrets(values: Vec<String>) {
    if let Some(d) = DIAG.get() {
        *d.known.lock().unwrap_or_else(|p| p.into_inner()) =
            values.into_iter().filter(|v| v.len() >= 8).collect();
    }
}

pub fn level() -> u8 {
    DIAG.get()
        .map(|d| d.level.load(Ordering::Relaxed))
        .unwrap_or(LEVEL_OFF)
}

fn envelope(d: &Diag, cat: &str, ev: &str, lvl: &str, fields: Map<String, Value>) -> String {
    let mut o = Map::new();
    o.insert("t".into(), json!(now_iso()));
    o.insert("m".into(), json!(d.started.elapsed().as_millis() as u64));
    o.insert("src".into(), json!("rust"));
    o.insert("sid".into(), json!(d.sid));
    o.insert(
        "seq".into(),
        json!(d.seq.fetch_add(1, Ordering::Relaxed) + 1),
    );
    o.insert("lvl".into(), json!(lvl));
    o.insert("cat".into(), json!(cat));
    o.insert("ev".into(), json!(ev));
    for (k, v) in fields {
        if !o.contains_key(&k) {
            o.insert(k, v);
        }
    }
    let line = Value::Object(o).to_string();
    scrub_with(d, &line, usize::MAX)
}

/// Record one shell event. Fields are numbers, enums and fixed strings by construction; the
/// whole line is still scrubbed, so a careless field cannot leak.
pub fn emit(cat: &str, ev: &str, lvl: &str, fields: Map<String, Value>) {
    let Some(d) = DIAG.get() else { return };
    if d.level.load(Ordering::Relaxed) == LEVEL_OFF {
        return;
    }
    let line = envelope(d, cat, ev, lvl, fields);
    if let Some(app) = APP.get() {
        let _ = app.emit("diag-line", line.clone());
    }
    let _ =
        d.tx.lock()
            .unwrap_or_else(|p| p.into_inner())
            .send(vec![line]);
}

/// A panic: written synchronously, because the process may not live to drain the channel.
pub fn emit_sync(cat: &str, ev: &str, lvl: &str, fields: Map<String, Value>) {
    let Some(d) = DIAG.get() else { return };
    if d.level.load(Ordering::Relaxed) == LEVEL_OFF {
        return;
    }
    let line = envelope(d, cat, ev, lvl, fields);
    write_lines(&d.dir, &[line]);
}

/// The session ended cleanly: remove the marker that would otherwise say it did not.
pub fn clean_exit() {
    let Some(d) = DIAG.get() else { return };
    let mut f = Map::new();
    f.insert(
        "uptime_ms".into(),
        json!(d.started.elapsed().as_millis() as u64),
    );
    emit_sync("app", "exit", "info", f);
    let _ = std::fs::remove_file(d.dir.join("running"));
}

// ---- redaction (port of src/diag/redact.ts free-text rules) -------------------------

struct Rules {
    phrase: Regex,
    address: Regex,
    onion: Regex,
    email: Regex,
    hex64: Regex,
    hex: Regex,
    token: Regex,
    ipv4: Regex,
    money: Regex,
    digit: Regex,
    letter: Regex,
    fast: Regex,
    hexletters: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| Rules {
        // `(?-u:\b)`: JavaScript's \b is ASCII; Rust's default is Unicode.
        phrase: Regex::new(r"(?-u:\b)(?:[a-z]{3,8}[ \t]+){11,}[a-z]{3,8}(?-u:\b)").unwrap(),
        address: Regex::new(r"(?i)(?-u:\b)(?:zkas|zkastest|zkasdev|zkassim|firecash|kaspa|kaspatest|kaspadev|kaspasim):[a-z0-9]{20,}").unwrap(),
        onion: Regex::new(r"(?i)(?-u:\b)[a-z2-7]{16,56}\.onion(?-u:\b)").unwrap(),
        email: Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+").unwrap(),
        hex64: Regex::new(r"(?-u:\b)[0-9a-fA-F]{64}(?-u:\b)").unwrap(),
        hex: Regex::new(r"[0-9a-fA-F]{16,}").unwrap(),
        token: Regex::new(r"[A-Za-z0-9+_=-]{32,}").unwrap(),
        ipv4: Regex::new(r"(?-u:\b)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?-u:\b)").unwrap(),
        money: Regex::new(r"(?i)(^|[^~\w.<>=-])(-?\d[\d,_]*(?:\.\d+)?)\s*(ZKAS|KAS|sompi|FC)(?-u:\b)").unwrap(),
        digit: Regex::new(r"\d").unwrap(),
        letter: Regex::new(r"[A-Za-z]").unwrap(),
        fast: Regex::new(r"[\d:@]").unwrap(),
        hexletters: Regex::new(r"[a-fA-F]{16}").unwrap(),
    })
}

const PUBLIC_HOSTS: &[&str] = &[
    "seed.zkas.info",
    "wallet.zkas.info",
    "zkas.info",
    "explorer.zkas.info",
    "services.zkas.info",
    "api.zkas.info",
    "185.147.157.125",
    "160.187.211.153",
    "142.248.80.23",
    "127.0.0.1",
    "localhost",
    "plqu6zzg5u6lkofv76m3pnnxzbaus6pgs4thced4wejdroi7z7exd6qd.onion",
];

fn pseudonym(salt: &str, kind: &str, value: &str) -> String {
    let mut h = Sha256::new();
    h.update(format!("{salt}:{kind}:{}", value.trim().to_lowercase()).as_bytes());
    hex::encode(h.finalize())[..8].to_string()
}

pub fn bucket_amount(zkas: f64) -> String {
    if !zkas.is_finite() {
        return "?".into();
    }
    let v = zkas.abs();
    let sign = if zkas < 0.0 { "-" } else { "" };
    if v == 0.0 {
        return "0".into();
    }
    const D: &[(f64, &str)] = &[
        (0.001, "<0.001"),
        (0.01, "0.001-0.01"),
        (0.1, "0.01-0.1"),
        (1.0, "0.1-1"),
        (10.0, "1-10"),
        (100.0, "10-100"),
        (1_000.0, "100-1k"),
        (10_000.0, "1k-10k"),
        (100_000.0, "10k-100k"),
        (1_000_000.0, "100k-1M"),
    ];
    for (limit, name) in D {
        if v < *limit {
            return format!("{sign}{name}");
        }
    }
    format!("{sign}>=1M")
}

fn private_ipv4(a: u32, b: u32) -> bool {
    a == 10
        || a == 127
        || (a == 192 && b == 168)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 169 && b == 254)
}

/// Redact free text with an explicit salt (and known secrets). Mirrors `redactText`.
pub fn scrub_salted(salt: &str, known: &[String], input: &str, max: usize) -> String {
    let r = rules();
    let mut s = input.to_string();
    for k in known {
        if s.contains(k.as_str()) {
            s = s.replace(k.as_str(), &format!("x:{}", pseudonym(salt, "secret", k)));
        }
    }
    if s.chars().count() < 47
        && !r.fast.is_match(&s)
        && !r.hexletters.is_match(&s)
        && !s.contains(".onion")
    {
        return s;
    }
    s = r.phrase.replace_all(&s, "[phrase]").into_owned();
    s = r
        .address
        .replace_all(&s, |c: &regex::Captures| {
            format!("addr:{}", pseudonym(salt, "addr", &c[0]))
        })
        .into_owned();
    s = r
        .onion
        .replace_all(&s, |c: &regex::Captures| {
            if PUBLIC_HOSTS.contains(&c[0].to_lowercase().as_str()) {
                c[0].to_string()
            } else {
                format!("onion:{}", pseudonym(salt, "host", &c[0]))
            }
        })
        .into_owned();
    s = r.email.replace_all(&s, "[email]").into_owned();
    // A hex run counts only if it has a letter: digits alone are a number (a float's 17
    // significant digits), and mangling one made a JSON line invalid in a real run.
    let has_hex_letter = |t: &str| t.bytes().any(|b| matches!(b, b'a'..=b'f' | b'A'..=b'F'));
    s = r
        .hex64
        .replace_all(&s, |c: &regex::Captures| {
            if has_hex_letter(&c[0]) {
                format!("h:{}", pseudonym(salt, "hash", &c[0]))
            } else {
                c[0].to_string()
            }
        })
        .into_owned();
    s = r
        .hex
        .replace_all(&s, |c: &regex::Captures| {
            if has_hex_letter(&c[0]) {
                format!("x:{}", pseudonym(salt, "hex", &c[0]))
            } else {
                c[0].to_string()
            }
        })
        .into_owned();
    {
        let mut out = String::with_capacity(s.len());
        let mut last = 0;
        for m in r.token.find_iter(&s) {
            out.push_str(&s[last..m.start()]);
            let t = m.as_str();
            let public_onion = s[m.end()..].starts_with(".onion")
                && PUBLIC_HOSTS.contains(&format!("{}.onion", t.to_lowercase()).as_str());
            if r.digit.is_match(t) && r.letter.is_match(t) && !public_onion {
                out.push_str(&format!("b:{}", pseudonym(salt, "tok", t)));
            } else {
                out.push_str(t);
            }
            last = m.end();
        }
        out.push_str(&s[last..]);
        s = out;
    }
    s = r
        .ipv4
        .replace_all(&s, |c: &regex::Captures| {
            let all = &c[0];
            if PUBLIC_HOSTS.contains(&all) {
                return all.to_string();
            }
            let a: u32 = c[1].parse().unwrap_or(999);
            let b: u32 = c[2].parse().unwrap_or(999);
            if a > 255 || b > 255 {
                return all.to_string();
            }
            format!(
                "{}:{}",
                if private_ipv4(a, b) { "lan" } else { "ip" },
                pseudonym(salt, "ip", all)
            )
        })
        .into_owned();
    s = r
        .money
        .replace_all(&s, |c: &regex::Captures| {
            let n: f64 = c[2].replace([',', '_'], "").parse().unwrap_or(f64::NAN);
            let unit = &c[3];
            let sompi = unit.eq_ignore_ascii_case("sompi");
            let zkas = if sompi { n / 1e8 } else { n };
            format!(
                "{}~{} {}",
                &c[1],
                bucket_amount(zkas),
                if sompi {
                    "ZKAS".to_string()
                } else {
                    unit.to_uppercase()
                }
            )
        })
        .into_owned();
    if s.chars().count() > max {
        s = s.chars().take(max).collect::<String>() + "…";
    }
    s
}

fn scrub_with(d: &Diag, input: &str, max: usize) -> String {
    let known = d.known.lock().unwrap_or_else(|p| p.into_inner()).clone();
    scrub_salted(&d.salt, &known, input, max)
}

// ---- resource sampler ------------------------------------------------------------

/// Once a minute: this process's RSS and CPU, and the machine's memory. The question this
/// answers is "was it the wallet, or the machine?" — an OOM kill leaves no panic, so the
/// last sample before silence is the only witness.
pub fn start_sampler() {
    let _ = std::thread::Builder::new()
        .name("diag-sampler".into())
        .spawn(|| {
            use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
            let mut sys = System::new();
            let Ok(pid) = sysinfo::get_current_pid() else {
                return;
            };
            let cores = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1) as f32;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                if level() == LEVEL_OFF {
                    continue;
                }
                sys.refresh_memory();
                // ALL, not Some(&[pid]): sysinfo 0.31 computes a process's CPU% only on a full
                // refresh (found in a real run: every sample read 0.0). One /proc walk a minute.
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    ProcessRefreshKind::new().with_cpu().with_memory(),
                );
                let mut f = Map::new();
                if let Some(p) = sys.process(pid) {
                    f.insert("rss_mb".into(), json!(p.memory() / 1_048_576));
                    f.insert("virt_mb".into(), json!(p.virtual_memory() / 1_048_576));
                    // sysinfo reports per-core percent summed over cores; normalise to the machine.
                    f.insert(
                        "cpu_pct".into(),
                        // f64, rounded: an f32 widened to f64 serialises as 17 digits.
                        json!((((p.cpu_usage() / cores) as f64) * 10.0).round() / 10.0),
                    );
                }
                f.insert("sys_used_mb".into(), json!(sys.used_memory() / 1_048_576));
                f.insert("sys_total_mb".into(), json!(sys.total_memory() / 1_048_576));
                f.insert(
                    "sys_avail_mb".into(),
                    json!(sys.available_memory() / 1_048_576),
                );
                emit("perf", "process", "info", f);
            }
        });
}

// ---- commands ----------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagConfig {
    salt: String,
    level: String,
    proc_uptime_ms: u64,
    start_kind: String,
    env: Value,
    dir: String,
    prev_unclean: bool,
    tour: bool,
}

#[tauri::command]
pub fn diag_config() -> Result<DiagConfig, String> {
    let d = DIAG.get().ok_or("diagnostics are not available")?;
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    // A second config call in one process is the WebView reloading (tray restore, a crash
    // boundary's Reload), not a new launch.
    let reload = d.config_served.swap(true, Ordering::Relaxed);
    Ok(DiagConfig {
        salt: d.salt.clone(),
        level: level_name(d.level.load(Ordering::Relaxed)).into(),
        proc_uptime_ms: d.started.elapsed().as_millis() as u64,
        start_kind: if reload {
            "reload".into()
        } else {
            "cold".into()
        },
        env: json!({
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "os_version": System::long_os_version(),
            "kernel": System::kernel_version(),
            "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            "total_mem_mb": sys.total_memory() / 1_048_576,
            "shell_version": env!("CARGO_PKG_VERSION"),
        }),
        dir: d.dir.to_string_lossy().into_owned(),
        prev_unclean: d.prev_unclean && !reload,
        tour: std::env::var("ZKAS_DIAG_TOUR")
            .map(|v| v == "1")
            .unwrap_or(false),
    })
}

/// A batch from the WebView. Each line must be one JSON object; it is scrubbed again here
/// (defence in depth: the WebView's redactor is the first line, not the only one).
#[tauri::command]
pub fn diag_append(lines: Vec<String>) {
    let Some(d) = DIAG.get() else { return };
    if d.level.load(Ordering::Relaxed) == LEVEL_OFF {
        return;
    }
    let ok: Vec<String> = lines
        .into_iter()
        .filter(|l| {
            l.len() <= MAX_LINE && l.starts_with('{') && serde_json::from_str::<Value>(l).is_ok()
        })
        .map(|l| scrub_with(d, &l, usize::MAX))
        .collect();
    if !ok.is_empty() {
        let _ = d.tx.lock().unwrap_or_else(|p| p.into_inner()).send(ok);
    }
}

#[tauri::command]
pub fn diag_set_level(level: String) {
    let Some(d) = DIAG.get() else { return };
    let l = parse_level(&level);
    d.level.store(l, Ordering::Relaxed);
    let _ = std::fs::write(d.dir.join("level"), level_name(l));
}

#[derive(Serialize)]
pub struct DiagStats {
    files: usize,
    bytes: u64,
}

#[tauri::command]
pub fn diag_stats() -> DiagStats {
    let Some(d) = DIAG.get() else {
        return DiagStats { files: 0, bytes: 0 };
    };
    let mut files = 0;
    let mut bytes = 0;
    for i in 0..FILES {
        if let Ok(m) = std::fs::metadata(file_path(&d.dir, i)) {
            files += 1;
            bytes += m.len();
        }
    }
    DiagStats { files, bytes }
}

#[tauri::command]
pub fn diag_clear() {
    let Some(d) = DIAG.get() else { return };
    let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    for i in 0..FILES {
        let _ = std::fs::remove_file(file_path(&d.dir, i));
    }
}

/// The last `n` lines of a text file, scrubbed, as `{cat, ev, line}` records.
fn tail_as_records(d: &Diag, path: &Path, n: usize, cat: &str) -> Vec<String> {
    let Ok(f) = File::open(path) else {
        return Vec::new();
    };
    let mut ring: std::collections::VecDeque<String> = std::collections::VecDeque::with_capacity(n);
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if ring.len() == n {
            ring.pop_front();
        }
        ring.push_back(line);
    }
    ring.into_iter()
        .map(|l| {
            json!({ "src": "file", "cat": cat, "ev": "line", "line": scrub_with(d, &l, 2_000) })
                .to_string()
        })
        .collect()
}

/// Build the export in memory: the header, every diag file oldest first, then the tails of
/// crash.log and services.log (both scrubbed — services.log holds raw engine lines, which
/// name the wallet token).
pub fn build_export(header: &str) -> Result<String, String> {
    let d = DIAG.get().ok_or("diagnostics are not available")?;
    let mut out = String::new();
    let header = if serde_json::from_str::<Value>(header).is_ok() {
        scrub_with(d, header, usize::MAX)
    } else {
        "{}".into()
    };
    out.push_str(&header);
    out.push('\n');
    {
        let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        for i in (0..FILES).rev() {
            if let Ok(text) = std::fs::read_to_string(file_path(&d.dir, i)) {
                out.push_str(&text);
            }
        }
    }
    if let Some(base) = d.dir.parent().and_then(|p| p.parent()) {
        for l in tail_as_records(d, &base.join("crash.log"), 300, "crashlog") {
            out.push_str(&l);
            out.push('\n');
        }
        for l in tail_as_records(
            d,
            &base.join("logs").join("services.log"),
            1_000,
            "serviceslog",
        ) {
            out.push_str(&l);
            out.push('\n');
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct DiagExport {
    path: String,
}

#[tauri::command]
pub fn diag_export(app: AppHandle, header: String) -> Result<DiagExport, String> {
    use tauri::Manager;
    let body = build_export(&header)?;
    let folder = app
        .path()
        .download_dir()
        .ok()
        .or_else(|| app.path().home_dir().ok())
        .ok_or("no Downloads folder")?;
    let _ = std::fs::create_dir_all(&folder);
    let stamp = now_iso().replace([':', '.'], "-");
    let path = folder.join(format!("zkas-diagnostics-{}.jsonl", &stamp[..19]));
    std::fs::write(&path, body).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    let mut f = Map::new();
    f.insert(
        "bytes".into(),
        json!(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)),
    );
    emit("diag", "exported", "info", f);
    Ok(DiagExport {
        path: path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vectors {
        salt: String,
        max: usize,
        cases: Vec<Case>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        input: String,
        expect: String,
    }

    /// The Rust port must produce exactly what the canonical JS redactor does.
    #[test]
    fn matches_the_shared_redaction_vectors() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test/diag-redaction-vectors.json"
        ))
        .expect("vectors");
        let v: Vectors = serde_json::from_str(&raw).expect("parse vectors");
        assert!(v.cases.len() > 15);
        for c in &v.cases {
            assert_eq!(
                scrub_salted(&v.salt, &[], &c.input, v.max),
                c.expect,
                "input: {}",
                c.input
            );
        }
    }

    #[test]
    fn scrubbing_a_whole_json_line_keeps_it_valid_json() {
        let line = json!({"cat":"err","ev":"panic","msg":"panicked paying zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh 12.5 ZKAS tx 35dd94a1d8d20d8b19e1b70531f105736071876945f04b2028d5b97fdeff43ff"}).to_string();
        let out = scrub_salted("00", &[], &line, usize::MAX);
        let v: Value = serde_json::from_str(&out).expect("still JSON");
        let msg = v["msg"].as_str().unwrap();
        assert!(!msg.contains("zkas:py82"));
        assert!(!msg.contains("35dd94a1"));
        assert!(msg.contains("~10-100 ZKAS"));
    }

    #[test]
    fn known_secrets_are_replaced_by_value() {
        let token = "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9aB1cD".to_string();
        let out = scrub_salted(
            "00",
            &[token.clone()],
            &format!("wallet '{token}': opened"),
            600,
        );
        assert!(!out.contains(&token));
    }

    #[test]
    fn rotation_keeps_ten_bounded_files() {
        let dir = std::env::temp_dir().join(format!("zkas-diag-test-{}", random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let line = "x".repeat(1024);
        let batch: Vec<String> = (0..512).map(|_| line.clone()).collect();
        for _ in 0..(FILES * 5) {
            write_lines(&dir, &batch);
        }
        let mut count = 0;
        for i in 0..FILES + 2 {
            if let Ok(m) = std::fs::metadata(file_path(&dir, i)) {
                count += 1;
                assert!(
                    m.len() <= FILE_BYTES + 600 * 1024,
                    "file {i} is {} bytes",
                    m.len()
                );
            }
        }
        assert_eq!(count, FILES);
        assert!(!file_path(&dir, FILES).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamps_are_iso() {
        let t = now_iso();
        assert_eq!(t.len(), 24, "{t}");
        assert!(t.ends_with('Z'));
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[10..11], "T");
    }
}
