#!/usr/bin/env bash
# Build the FireCash Android wallet: web bundle -> capacitor sync -> gradle.
#
#   ./scripts/build-android.sh            # debug APK (unsigned-for-store, installable)
#   ./scripts/build-android.sh release    # signed release APK + AAB
#
# Release signing reads a properties file that is NEVER in the repo:
#
#   FC_KEYSTORE=/path/firecash-release.jks
#   FC_KEYSTORE_PASS=...
#   FC_KEY_ALIAS=firecash
#   FC_KEY_PASS=...
#
# Point FC_SIGNING_PROPS at it (default: /root/work/.android-signing on the build
# host). Losing that keystore means Android will refuse to update installed apps —
# back it up offline.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${JAVA_HOME:=/usr/lib/jvm/java-17-openjdk-amd64}"
: "${ANDROID_HOME:=/root/work/android-sdk}"
: "${FC_SIGNING_PROPS:=/root/work/.android-signing}"
export JAVA_HOME ANDROID_HOME FC_SIGNING_PROPS
export ANDROID_SDK_ROOT="$ANDROID_HOME"

MODE="${1:-debug}"

npm run build
npx cap sync android

cd android
if [ "$MODE" = "release" ]; then
  [ -f "$FC_SIGNING_PROPS" ] || { echo "no signing props at $FC_SIGNING_PROPS" >&2; exit 1; }
  ./gradlew --no-daemon assembleRelease bundleRelease
  echo "APK: android/app/build/outputs/apk/release/app-release.apk"
  echo "AAB: android/app/build/outputs/bundle/release/app-release.aab"
else
  ./gradlew --no-daemon assembleDebug
  echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"
fi
