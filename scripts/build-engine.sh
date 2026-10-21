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

# The engine revision must be the one the desktop and iOS workflows pin.
#
# Those builds check the SHA out; this one compiles whatever the sibling checkout happens
# to be sitting at, and nothing connected the two. On 1.0.52-rc2 that shipped an APK whose
# engine was ~85 commits behind the desktop one — missing the checkpoint fix, on the one
# platform the problem was reported from. The drift is invisible in the build log: the
# engine compiles perfectly, it is just a different engine.
#
# So read the pin from the workflow that declares it and refuse to build off it.
# ENGINE_PIN overrides the expected SHA; ENGINE_PIN_SKIP=1 skips the check entirely (for
# building against a local engine branch on purpose).
#
# Exits 3 (not 1) on a mismatch, because build-android.sh tolerates a FAILED engine build
# so a host without the NDK still produces a hosted-only app — which would silently ship a
# release APK with no embedded engine. 3 means "the engine is buildable but would be the
# wrong one", and that caller turns it into a hard failure.
#
# The engine source is where ENGINE_CRATE's path dependency points (`../../rusty-kaspa`
# relative to the crate), NOT a sibling of this repo: on the build box ENGINE_CRATE is
# /root/zkas/mobile-test/zkas-signer/walletd-mobile while this repo sits in
# /root/zkas/android-build, so checking $ROOT/../rusty-kaspa compared a checkout nothing
# builds from. NODE_SRC overrides it.
if [ -z "${NODE_SRC:-}" ]; then
  if [ -d "$ENGINE/../../rusty-kaspa/.git" ]; then NODE_SRC="$ENGINE/../../rusty-kaspa"; else NODE_SRC="$ROOT/../rusty-kaspa"; fi
fi
if [ "${ENGINE_PIN_SKIP:-0}" != "1" ]; then
  PIN="${ENGINE_PIN:-}"
  if [ -z "$PIN" ]; then
    PIN="$(sed -nE 's/^[[:space:]]*ref:[[:space:]]*([0-9a-f]{40})[[:space:]]*$/\1/p' "$ROOT/.github/workflows/desktop-all.yml" | head -1)"
  fi
  # Fail closed on both sides: no declared pin means the check would pass vacuously, which
  # is the state this guard exists to end.
  [ -n "$PIN" ] || { echo "no engine pin found in .github/workflows/desktop-all.yml (set ENGINE_PIN, or ENGINE_PIN_SKIP=1)"; exit 3; }
  HAVE="$(git -C "$NODE_SRC" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$HAVE" ] || { echo "cannot read the engine revision at $NODE_SRC (set NODE_SRC, or ENGINE_PIN_SKIP=1)"; exit 3; }
  if [ "$HAVE" != "$PIN" ]; then
    echo "engine revision mismatch: the APK would not match the desktop/iOS builds." >&2
    echo "  $NODE_SRC is at $HAVE" >&2
    echo "  the workflows pin        $PIN" >&2
    echo "  fix:  git -C $NODE_SRC fetch origin main && git -C $NODE_SRC checkout $PIN" >&2
    exit 3
  fi
  echo "engine pin OK — $NODE_SRC at ${PIN:0:12}, matching the desktop/iOS workflows"
fi

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
    CARGO_PROFILE_RELEASE_STRIP=none \
    cargo build --manifest-path "$ENGINE/Cargo.toml" --target "$tgt" --release
  dst="$ROOT/android/app/src/main/jniLibs/${ABI[$tgt]}"
  mkdir -p "$dst"
  # Build UNSTRIPPED, then strip on the way into jniLibs.
  #
  # The workspace sets `[profile.release] strip = true`, which removes the full symbol
  # table. UniFFI reads its metadata from THAT table (not .dynsym), so bindgen found
  # nothing, generated nothing, and — because it exits 0 even on failure — the `|| true`
  # below swallowed it. The vendored Kotlin binding silently froze on 2026-09-10: any
  # UniFFI function added after that date simply never reached Kotlin.
  #
  # So the object bindgen reads keeps its symbols, and the object we ship does not.
  cp "$ENGINE/target/$tgt/release/libzkas_walletd_mobile.so" "$dst/"
  "$BIN/llvm-strip" "$dst/libzkas_walletd_mobile.so"
done

# Refresh the vendored UniFFI Kotlin bindings from the just-built library.
BIND="$ROOT/android/app/src/main/java/uniffi/zkas_walletd_mobile"
mkdir -p "$BIND"
rm -rf "$ROOT/.engine-bindings"
# NOT silenced and NOT `|| true`. uniffi-bindgen exits 0 even when it fails, so the only
# way to know it worked is to look for the file — and a stale binding is worse than a
# failed build: the app compiles against Kotlin that no longer matches the library.
(cd "$ENGINE" && cargo run --bin uniffi-bindgen -- generate \
  --library "$ENGINE/target/aarch64-linux-android/release/libzkas_walletd_mobile.so" \
  --language kotlin --out-dir "$ROOT/.engine-bindings")
GEN="$ROOT/.engine-bindings/uniffi/zkas_walletd_mobile/zkas_walletd_mobile.kt"
[ -f "$GEN" ] || { echo "FATAL: uniffi-bindgen produced no Kotlin binding (it exits 0 on failure - check the library kept its symbol table)"; exit 1; }
cp "$GEN" "$BIND/"

echo "engine built into android/app/src/main/jniLibs (arm64-v8a, armeabi-v7a, x86_64)"
