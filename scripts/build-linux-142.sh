#!/usr/bin/env bash
# Linux desktop build (deb + AppImage) on the 142 build box, from the Radicle repo.
#
#   scripts/build-linux-142.sh [<wallet ref>]        (default: main)
#
# Runs ON 142. Windows and macOS build on AppVeyor (appveyor.yml); Android and web
# build with scripts/release.sh. This replaces the `desktop:linux-x86_64` GitLab job,
# which can no longer run: GitLab blocked the account in October 2026.
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
RUST_TARGET=x86_64-unknown-linux-gnu
TARGET_NAME=linux-x86_64

export PATH="/root/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$CI_ROOT/target-linux"
export CARGO_BUILD_JOBS="$JOBS"

missing=""
for pkg in protobuf-compiler patchelf xdg-utils libssl-dev libxdo-dev librsvg2-dev \
           libayatana-appindicator3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev \
           libjavascriptcoregtk-4.1-dev; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"
done
[ -z "$missing" ] || { echo "missing build dependencies:$missing (install deliberately, then re-run)" >&2; exit 3; }
case "$(node -v 2>/dev/null || echo none)" in
  v20.*|v22.*) ;;
  *) echo "node 20+ required; found $(node -v 2>/dev/null || echo none)" >&2; exit 3 ;;
esac

mkdir -p "$CI_ROOT"
exec 9>/root/zkas/HEAVY.lock
flock 9

WORK="$CI_ROOT/linux-$(date -u +%Y%m%d-%H%M%S)"
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
nice -n 19 npx tauri build --target "$RUST_TARGET" --bundles deb,appimage

OUT="$CI_ROOT/out/$VER"
mkdir -p "$OUT"
B="$CARGO_TARGET_DIR/$RUST_TARGET/release/bundle"
find "$B" -type f \( -name '*.deb' -o -name '*.AppImage' \) -newer "$WORK/zkas-wallet/package.json" -print0 |
  while IFS= read -r -d '' f; do cp "$f" "$OUT/ZKas-Wallet-$TARGET_NAME.${f##*.}"; done
ls "$OUT"/ZKas-Wallet-$TARGET_NAME.* >/dev/null 2>&1 || { echo "no bundles were produced" >&2; exit 1; }
( cd "$OUT" && sha256sum ZKas-Wallet-$TARGET_NAME.* | tee "SHA256SUMS-$TARGET_NAME" )
echo "done: $OUT (wallet $SHA, engine $PIN)"
