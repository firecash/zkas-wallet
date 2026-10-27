#!/usr/bin/env bash
# Windows desktop build (NSIS installer) on the 142 build box, cross-compiled from Linux.
#
#   scripts/build-windows-142.sh [<wallet ref>]        (default: main)
#
# Runs ON 142. Target x86_64-pc-windows-msvc through cargo-xwin (Microsoft's CRT and
# SDK headers, linked with lld-link) and Tauri's NSIS bundler (makensis). MSVC, not
# MinGW: no libstdc++/libgcc/winpthread DLL can end up in the exe, which is the bug
# the old MinGW node builds shipped. The DLL check at the end enforces it.
#
# One-time host setup (done 2026-10-27): apt nsis lld-14; rustup target
# x86_64-pc-windows-msvc; cargo install --locked cargo-xwin.
# macOS builds on Codemagic (codemagic.yaml), Linux with build-linux-142.sh.
#
# Everything happens in a fresh directory under /root/zkas/ci, laid out the way
# src-tauri/Cargo.toml expects (the engine is the sibling ../rusty-kaspa), so no
# existing checkout on the box is touched. The cargo target dir is shared across
# runs, so only the first build is slow.
#
# House rules for 142 (a shared box that also runs the live walletd): nice 19,
# bounded jobs, one heavy job at a time under /root/zkas/HEAVY.lock, and no apt
# from here — a missing dependency is reported, not installed.
set -euo pipefail

REF="${1:-main}"
WALLET_REPO="${WALLET_REPO:-https://zkas.info/code/wallet.git}"
ENGINE_REPO="${ENGINE_REPO:-https://zkas.info/code/rusty.git}"
CI_ROOT="${CI_ROOT:-/root/zkas/ci}"
JOBS="${JOBS:-6}"
RUST_TARGET=x86_64-pc-windows-msvc
TARGET_NAME=windows-x86_64

export PATH="/root/.cargo/bin:/usr/lib/llvm-14/bin:$PATH"
export CARGO_TARGET_DIR="$CI_ROOT/target-windows"
# aws-lc-sys: use its bundled pre-assembled objects instead of needing nasm.
export AWS_LC_SYS_PREBUILT_NASM=1
export CARGO_BUILD_JOBS="$JOBS"

missing=""
for pkg in protobuf-compiler nsis lld-14 llvm-14; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"
done
command -v cargo-xwin >/dev/null || missing="$missing cargo-xwin(cargo install --locked cargo-xwin)"
rustup target list --installed | grep -qx "$RUST_TARGET" || missing="$missing rustup-target:$RUST_TARGET"
[ -z "$missing" ] || { echo "missing build dependencies:$missing (install deliberately, then re-run)" >&2; exit 3; }
case "$(node -v 2>/dev/null || echo none)" in
  v20.*|v22.*) ;;
  *) echo "node 20+ required; found $(node -v 2>/dev/null || echo none)" >&2; exit 3 ;;
esac

mkdir -p "$CI_ROOT"
exec 9>/root/zkas/HEAVY.lock
flock 9

WORK="$CI_ROOT/windows-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
echo "workspace $WORK"

git clone -q "$WALLET_REPO" "$WORK/zkas-wallet"
git -C "$WORK/zkas-wallet" checkout -q "$REF"
SHA="$(git -C "$WORK/zkas-wallet" rev-parse HEAD)"
VER="$(node -p "require('$WORK/zkas-wallet/package.json').version")"
echo "wallet $REF = $SHA (version $VER)"

PIN="$(tr -d '[:space:]' < "$WORK/zkas-wallet/ENGINE_PIN")"
printf '%s' "$PIN" | grep -qE '^[0-9a-f]{40}$' || { echo "no valid engine pin in ENGINE_PIN" >&2; exit 3; }
E="$WORK/rusty-kaspa"
git init -q "$E"
git -C "$E" remote add origin "$ENGINE_REPO"
git -C "$E" fetch -q --depth 1 origin "$PIN"
git -C "$E" checkout -q FETCH_HEAD
test -d "$E/zkas-walletd" || { echo "engine checkout is missing zkas-walletd" >&2; exit 3; }
echo "engine $PIN"

cd "$WORK/zkas-wallet"
nice -n 19 npm ci --no-audit --no-fund
nice -n 19 npx tauri build --runner cargo-xwin --target "$RUST_TARGET" --bundles nsis

OUT="$CI_ROOT/out/$VER"
mkdir -p "$OUT"
B="$CARGO_TARGET_DIR/$RUST_TARGET/release/bundle"
find "$B" -type f -name '*-setup.exe' -newer "$WORK/zkas-wallet/package.json" -print0 |
  while IFS= read -r -d '' f; do cp "$f" "$OUT/ZKas-Wallet-$TARGET_NAME-setup.exe"; done
# The app exe must import only system DLLs (no MinGW runtime, nothing we would have
# to ship next to it). WebView2Loader is statically linked by Tauri v2.
EXE="$(find "$CARGO_TARGET_DIR/$RUST_TARGET/release" -maxdepth 1 -name '*.exe' | head -1)"
DLLS="$(llvm-readobj --coff-imports "$EXE" | sed -n 's/^ *Name: //p' | sort -u)"
echo "imports of $(basename "$EXE"):"; echo "$DLLS" | sed 's/^/  /'
BAD="$(echo "$DLLS" | grep -i -v -E '^(kernel32|user32|gdi32|advapi32|shell32|ole32|oleaut32|ws2_32|ntdll|bcrypt|crypt32|secur32|userenv|dwmapi|uxtheme|comctl32|comdlg32|shlwapi|version|winmm|imm32|iphlpapi|setupapi|cfgmgr32|dbghelp|powrprof|propsys|rpcrt4|wininet|winhttp|dnsapi|ncrypt|msimg32|psapi|d3d11|dxgi|dcomp|oleacc|uiautomationcore|windowscodecs|api-ms-win-[a-z0-9-]+|vcruntime140(_1)?|msvcp140|ucrtbase)\.dll$' || true)"
[ -z "$BAD" ] || { echo "UNEXPECTED DLL imports:"; echo "$BAD"; exit 4; }
ls "$OUT"/ZKas-Wallet-$TARGET_NAME* >/dev/null 2>&1 || { echo "no bundles were produced" >&2; exit 1; }
( cd "$OUT" && sha256sum ZKas-Wallet-$TARGET_NAME* | tee "SHA256SUMS-$TARGET_NAME" )
echo "done: $OUT (wallet $SHA, engine $PIN)"
