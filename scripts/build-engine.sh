#!/usr/bin/env bash
# Build the embedded ZKas wallet engine (zkas-walletd-mobile) into the Android
# app's jniLibs, so the APK/AAB can run the wallet ON the phone.
#
# Needs, as siblings of this repo (the same layout build-android.sh already uses):
#   ../rusty-kaspa    (zkas-rusty — the node workspace zkas-walletd lives in)
#   ../zkas-signer    (holds walletd-mobile/, the UniFFI engine crate)
# and an Android NDK (ANDROID_NDK_HOME, or r26+ discoverable).
#
# cargo-ndk 4.x panics on NDK r26, so we drive the NDK clang linkers directly.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENGINE="${ENGINE_CRATE:-$ROOT/../zkas-signer/walletd-mobile}"
[ -f "$ENGINE/Cargo.toml" ] || { echo "engine crate not found at $ENGINE (set ENGINE_CRATE)"; exit 1; }

NDK="${ANDROID_NDK_HOME:-}"
[ -z "$NDK" ] && NDK="$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
[ -z "$NDK" ] && NDK="$(ls -d /root/zkas/android-ndk-* 2>/dev/null | sort -V | tail -1 || true)"
[ -d "$NDK" ] || { echo "Android NDK not found (set ANDROID_NDK_HOME)"; exit 1; }
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
API="${ANDROID_ENGINE_API:-24}"

# rustc target -> (android ABI dir, clang prefix)
declare -A ABI=( [aarch64-linux-android]=arm64-v8a [armv7-linux-androideabi]=armeabi-v7a [x86_64-linux-android]=x86_64 )
declare -A CLANG=( [aarch64-linux-android]=aarch64-linux-android [armv7-linux-androideabi]=armv7a-linux-androideabi [x86_64-linux-android]=x86_64-linux-android )

for tgt in "${!ABI[@]}"; do
  rustup target add "$tgt" >/dev/null 2>&1 || true
  cc="$BIN/${CLANG[$tgt]}${API}-clang"
  var=$(echo "$tgt" | tr 'a-z-' 'A-Z_')
  echo ">> building engine for $tgt (${ABI[$tgt]})"
  env \
    "CC_${tgt//-/_}=$cc" \
    "AR_${tgt//-/_}=$BIN/llvm-ar" \
    "CARGO_TARGET_${var}_LINKER=$cc" \
    ANDROID_NDK_HOME="$NDK" \
    cargo build --manifest-path "$ENGINE/Cargo.toml" --target "$tgt" --release
  dst="$ROOT/android/app/src/main/jniLibs/${ABI[$tgt]}"
  mkdir -p "$dst"
  cp "$ENGINE/target/$tgt/release/libzkas_walletd_mobile.so" "$dst/"
done

# Refresh the vendored UniFFI Kotlin bindings from the just-built library.
BIND="$ROOT/android/app/src/main/java/uniffi/zkas_walletd_mobile"
mkdir -p "$BIND"
cargo run --manifest-path "$ENGINE/Cargo.toml" --bin uniffi-bindgen -- generate \
  --library "$ENGINE/target/aarch64-linux-android/release/libzkas_walletd_mobile.so" \
  --language kotlin --out-dir "$ROOT/.engine-bindings" >/dev/null 2>&1 || true
[ -f "$ROOT/.engine-bindings/uniffi/zkas_walletd_mobile/zkas_walletd_mobile.kt" ] && \
  cp "$ROOT/.engine-bindings/uniffi/zkas_walletd_mobile/zkas_walletd_mobile.kt" "$BIND/"

echo "engine built into android/app/src/main/jniLibs (arm64-v8a, armeabi-v7a, x86_64)"
