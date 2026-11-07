#!/bin/bash
# Fetch the prebuilt on-device engine for iOS into ios/ZkasEngine, where the Podfile
# expects it, so `pod install` in ios/App links it.
#
#   scripts/fetch-ios-engine.sh            # the version named in ios/ZkasEngine/ENGINE_VERSION
#   scripts/fetch-ios-engine.sh 2026-11-07 # a specific published version
#
# Each published version lives at https://zkas.info/downloads/ios/engine/<version>/ and holds
#   ZkasEngine.xcframework.zip   the Rust static library for device (arm64) and simulator
#                                (arm64 + x86_64), with UniFFI's C header and modulemap
#   zkas_walletd_mobile.swift    the generated Swift that calls into it (the pod compiles
#                                it into the module `ZkasEngine` the app imports)
#   MANIFEST                     the zkas-rusty and zkas-signer revisions it was built from,
#                                and the SHA-256 of both files
# The zip is verified against the MANIFEST before anything is unpacked.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/ios/ZkasEngine"
VERSION="${1:-$(tr -d '[:space:]' < "$DEST/ENGINE_VERSION")}"
BASE="https://zkas.info/downloads/ios/engine/$VERSION"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "fetching engine $VERSION"
curl -fsSL "$BASE/MANIFEST" -o "$TMP/MANIFEST"
curl -fsSL "$BASE/ZkasEngine.xcframework.zip" -o "$TMP/ZkasEngine.xcframework.zip"
curl -fsSL "$BASE/zkas_walletd_mobile.swift" -o "$TMP/zkas_walletd_mobile.swift"
for f in ZkasEngine.xcframework.zip zkas_walletd_mobile.swift; do
  want="$(grep -E "^sha256 +$f " "$TMP/MANIFEST" | awk '{print $3}')"
  [ -n "$want" ] || { echo "MANIFEST names no checksum for $f"; exit 2; }
  have="$(shasum -a 256 "$TMP/$f" | cut -d' ' -f1)"
  [ "$have" = "$want" ] || { echo "checksum mismatch for $f: $have != $want"; exit 2; }
done
rm -rf "$DEST/ZkasEngine.xcframework" "$DEST/Sources/zkas_walletd_mobile.swift"
mkdir -p "$DEST/Sources"
unzip -q "$TMP/ZkasEngine.xcframework.zip" -d "$DEST"
cp "$TMP/zkas_walletd_mobile.swift" "$DEST/Sources/"
cp "$TMP/MANIFEST" "$DEST/MANIFEST"
echo "engine $VERSION in $DEST:"; sed -n '1,6p' "$DEST/MANIFEST"
echo "now: cd ios/App && pod install"
