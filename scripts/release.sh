#!/usr/bin/env bash
# One-shot ZKAS wallet release: version bump → git tag (fires desktop CI) →
# web + signed Android build on the build host → deploy web → upload Android to
# the GitHub release. Everything desktop/mobile/web lands on the SAME release tag.
#
#   ./scripts/release.sh 1.0.15          # full release
#   ./scripts/release.sh --build 1.0.15  # skip bump/tag; (re)build+deploy+upload an existing tag
#   ./scripts/release.sh --no-deploy 1.0.15   # build + upload, but don't touch the live web host
#
# WHAT RUNS WHERE
#   - version bump, git push, tag       : here (the repo checkout you run this from)
#   - desktop (5 targets)               : GitHub Actions (.github/workflows/desktop-all.yml, on tag v*)
#   - web dist/ + Android APK+AAB        : the build host over ssh (12-core box; never build on the live node)
#   - web deploy                        : rsync dist/ to the web host
#   - Android upload                    : gh release upload onto the tag CI created
#
# SECRETS (never in the repo):
#   - build-host password : $BUILD_HOST_PASS, else first line of $BUILD_HOST_PASS_FILE (default /root/work/.build-host)
#   - GitHub token        : $GH_TOKEN, else parsed from /root/.gh_creds
# Everything else is config below and overridable by env.
set -euo pipefail

REPO="${REPO:-firecash/zkas-wallet}"
BUILD_HOST="${BUILD_HOST:-142.248.80.23}"
BUILD_USER="${BUILD_USER:-root}"
BUILD_DIR="${BUILD_DIR:-/root/zkas/android-build/firecash-wallet}"
BUILD_ENV="${BUILD_ENV:-/root/zkas/android-env.sh}"     # exports JAVA_HOME/ANDROID_HOME/FC_SIGNING_PROPS
WEB_HOST="${WEB_HOST:-root@160.187.211.153}"
WEB_DIR="${WEB_DIR:-/var/www/wallet.zkas.info/html}"
BUILD_PASS_FILE="${BUILD_HOST_PASS_FILE:-/root/work/.build-host}"

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---- args ----
DO_BUMP=1; DO_DEPLOY=1; DO_PRE=0; VERSION=""
for a in "$@"; do
  case "$a" in
    --build|--build-only) DO_BUMP=0 ;;
    --no-deploy)          DO_DEPLOY=0 ;;
    --pre|--prerelease)   DO_PRE=1 ;;
    -*)                   die "unknown flag: $a" ;;
    *)                    VERSION="$a" ;;
  esac
done
# Allow a prerelease suffix (e.g. 1.0.17-rc1). A suffixed version is a prerelease
# regardless of --pre, and --pre marks the GitHub release as a prerelease too.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "usage: release.sh [--build] [--no-deploy] [--pre] <x.y.z[-suffix]>"
[[ "$VERSION" == *-* ]] && DO_PRE=1
TAG="v$VERSION"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ---- secrets ----
BUILD_PASS="${BUILD_HOST_PASS:-}"
[ -z "$BUILD_PASS" ] && [ -f "$BUILD_PASS_FILE" ] && BUILD_PASS="$(head -n1 "$BUILD_PASS_FILE")"
[ -n "$BUILD_PASS" ] || die "no build-host password ($BUILD_PASS_FILE or \$BUILD_HOST_PASS)"
GH_TOKEN="${GH_TOKEN:-}"
[ -z "$GH_TOKEN" ] && [ -f /root/.gh_creds ] && GH_TOKEN="$(grep -oE 'https://[^@]+@github.com' /root/.gh_creds | head -1 | sed -E 's#https://[^:]+:([^@]+)@github.com#\1#')"
[ -n "$GH_TOKEN" ] || die "no GitHub token (\$GH_TOKEN or /root/.gh_creds)"
command -v sshpass >/dev/null || die "sshpass not installed"
export SSHPASS="$BUILD_PASS"
BH() { sshpass -e ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$BUILD_USER@$BUILD_HOST" "$@"; }
gh_api() { curl -fsS -H "Authorization: token $GH_TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

# ---- 1. version bump + tag ----
if [ "$DO_BUMP" = 1 ]; then
  log "Bumping to $VERSION and tagging $TAG"
  [ "$(git branch --show-current)" = "main" ] || die "not on main"
  git diff --quiet && git diff --cached --quiet || die "working tree dirty — commit or stash first"
  node -e "const f='package.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
  # tauri (desktop): version drives the bundle filenames the macOS workflow emits
  node -e "const f='src-tauri/tauri.conf.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
  # android: versionName follows, versionCode auto-increments
  gver="android/app/build.gradle"
  code=$(grep -oE 'versionCode [0-9]+' "$gver" | grep -oE '[0-9]+'); newcode=$((code+1))
  sed -i -E "s/versionCode [0-9]+/versionCode $newcode/; s/versionName \"[^\"]*\"/versionName \"$VERSION\"/" "$gver"
  git add package.json src-tauri/tauri.conf.json "$gver"
  git -c user.name='firecash' -c user.email='dev@firecash.info' commit -q -m "release $VERSION"
  git fetch -q origin main
  [ "$(git merge-base main origin/main)" = "$(git rev-parse origin/main)" ] || die "main is not fast-forward — rebase first"
  git push -q origin main
  git tag -a "$TAG" -m "zkas-wallet $VERSION"
  git push -q origin "$TAG"
  echo "pushed $TAG (versionCode $newcode) — desktop CI is now building the 5 desktop targets"
fi

# ---- 2. sync source to the build host ----
log "Syncing source to $BUILD_HOST:$BUILD_DIR"
BH "mkdir -p '$BUILD_DIR'"
sshpass -e rsync -az --delete \
  --exclude .git --exclude node_modules --exclude dist --exclude release-artifacts \
  --exclude 'android/*/build' --exclude 'android/build' --exclude 'android/.gradle' \
  -e "ssh -o StrictHostKeyChecking=accept-new" \
  "$ROOT/" "$BUILD_USER@$BUILD_HOST:$BUILD_DIR/"

# ---- 3. build web dist + signed Android on the build host ----
# build-android.sh runs `npm run build` internally, so this produces BOTH dist/ (web)
# and the signed release APK+AAB in one pass.
log "Building web + signed Android on $BUILD_HOST (this takes a few minutes)"
BH "set -e; source '$BUILD_ENV'; cd '$BUILD_DIR'; \
    echo '-- npm install --'; npm install --no-audit --no-fund >/tmp/rel-npm.log 2>&1 || { tail -30 /tmp/rel-npm.log; exit 1; }; \
    echo '-- build web + android release --'; ./scripts/build-android.sh release"

APK_REMOTE="$BUILD_DIR/android/app/build/outputs/apk/release/app-release.apk"
AAB_REMOTE="$BUILD_DIR/android/app/build/outputs/bundle/release/app-release.aab"
BH "test -f '$APK_REMOTE' && test -f '$AAB_REMOTE'" || die "Android artifacts missing after build"

# ---- 4. fetch artifacts ----
OUT="$ROOT/release-artifacts/$TAG"; mkdir -p "$OUT"
log "Fetching artifacts to $OUT"
sshpass -e scp -o StrictHostKeyChecking=accept-new \
  "$BUILD_USER@$BUILD_HOST:$APK_REMOTE" "$OUT/zkas-wallet-$VERSION.apk"
sshpass -e scp -o StrictHostKeyChecking=accept-new \
  "$BUILD_USER@$BUILD_HOST:$AAB_REMOTE" "$OUT/zkas-wallet-$VERSION.aab"
# web bundle, for the deploy step and as a downloadable
BH "cd '$BUILD_DIR' && tar czf /tmp/rel-dist.tgz -C dist ." && \
  sshpass -e scp -o StrictHostKeyChecking=accept-new "$BUILD_USER@$BUILD_HOST:/tmp/rel-dist.tgz" "$OUT/web-dist-$VERSION.tgz"
echo "artifacts:"; ls -la "$OUT"

# ---- 5. deploy web to the live host ----
if [ "$DO_DEPLOY" = 1 ]; then
  log "Deploying web bundle to $WEB_HOST:$WEB_DIR"
  tmp="$(mktemp -d)"; tar xzf "$OUT/web-dist-$VERSION.tgz" -C "$tmp"
  # Force web-readable modes on the wire: without this, rsync -a propagates the
  # mktemp dir's 0700 onto $WEB_DIR and nginx (www-data) gets 403 (can't traverse).
  rsync -az --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r -e "ssh -o StrictHostKeyChecking=accept-new" "$tmp/" "$WEB_HOST:$WEB_DIR/"
  ssh "$WEB_HOST" "chmod 755 '$WEB_DIR' && chmod -R u=rwX,go=rX '$WEB_DIR'" || true
  ssh "$WEB_HOST" "systemctl reload nginx" || true
  rm -rf "$tmp"
  echo "web deployed → https://wallet.zkas.info"
fi

# ---- 6. upload Android to the GitHub release (CI creates it from the tag) ----
log "Waiting for the $TAG release, then uploading Android artifacts"
rel_id=""
for i in $(seq 1 60); do
  rel_id="$(gh_api "https://api.github.com/repos/$REPO/releases/tags/$TAG" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
  [ -n "$rel_id" ] && break
  sleep 10
done
if [ -z "$rel_id" ]; then
  echo "release $TAG not created yet by CI; creating it now"
  rel_id="$(gh_api -X POST "https://api.github.com/repos/$REPO/releases" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"body\":\"zkas-wallet $VERSION\",\"prerelease\":$([ "$DO_PRE" = 1 ] && echo true || echo false)}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
fi
# The desktop CI may have created the release without the prerelease flag; mark it.
if [ "$DO_PRE" = 1 ]; then
  gh_api -X PATCH "https://api.github.com/repos/$REPO/releases/$rel_id" -d '{"prerelease":true}' >/dev/null && echo "marked $TAG as a pre-release"
fi
upload() { # <file> <label>
  local f="$1" name; name="$(basename "$1")"
  # delete an existing asset of the same name so re-runs replace cleanly
  gh_api "https://api.github.com/repos/$REPO/releases/$rel_id/assets" \
    | python3 -c "import sys,json;[print(a['id']) for a in json.load(sys.stdin) if a['name']=='$name']" \
    | while read -r aid; do gh_api -X DELETE "https://api.github.com/repos/$REPO/releases/assets/$aid" >/dev/null || true; done
  curl -fsS -H "Authorization: token $GH_TOKEN" -H "Content-Type: $2" \
    --data-binary @"$f" \
    "https://uploads.github.com/repos/$REPO/releases/$rel_id/assets?name=$name" >/dev/null
  echo "uploaded $name"
}
upload "$OUT/zkas-wallet-$VERSION.apk" "application/vnd.android.package-archive"
upload "$OUT/zkas-wallet-$VERSION.aab" "application/octet-stream"

log "Release $TAG done"
echo "  desktop : GitHub Actions → release $TAG (check the Actions tab)"
echo "  android : APK + AAB uploaded to release $TAG"
echo "  web     : $([ "$DO_DEPLOY" = 1 ] && echo 'deployed to wallet.zkas.info' || echo 'built, not deployed (--no-deploy)')"
