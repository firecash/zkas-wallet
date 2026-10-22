fn main() {
    // The crate version (Cargo.toml) is not the app version: release.sh bumps tauri.conf.json,
    // never Cargo.toml, so CARGO_PKG_VERSION has read "1.0.5" since 1.0.5. crash.log and the
    // diagnostic log name the version a user is actually running, so take it from tauri.conf.
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let conf = std::fs::read_to_string("tauri.conf.json").unwrap_or_default();
    let version = conf
        .split_once("\"version\"")
        .and_then(|(_, rest)| rest.split('"').nth(1))
        .filter(|v| !v.is_empty() && v.len() < 40 && v.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)))
        .map(str::to_owned)
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=ZKAS_APP_VERSION={version}");
    tauri_build::build()
}
