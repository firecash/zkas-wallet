#!/usr/bin/env bash
# One-shot ZKAS wallet release: version bump → git tag (fires desktop CI) →
# web + signed Android build on the build host → deploy web → upload Android to
# the GitLab release. Everything desktop/mobile/web lands on the SAME release tag.
#
#   ./scripts/release.sh 1.0.15          # full release
#   ./scripts/release.sh --build 1.0.15  # skip bump/tag; (re)build+deploy+upload an existing tag
#   ./scripts/release.sh --no-deploy 1.0.15   # build + upload, but don't touch the live web host
#   ./scripts/release.sh --build --force-notes 1.0.15  # rewrite the release notes this script generated
#
# HOST: GitLab, not GitHub. The `firecash` GitHub account was suspended on
# 2026-10-23, so api.github.com/repos/firecash/* and uploads.github.com answer
# 403/404 and every GitHub call below used to be a hard failure mid-release. The
# repos now live at gitlab.com/zkas-group/<same names>.
#
# WHAT RUNS WHERE
#   - version bump, git push, tag       : here (the repo checkout you run this from)
#   - desktop                           : GitLab CI/CD (.gitlab-ci.yml, on tag v*) — LINUX ONLY.
#                                         Windows and macOS are off by default; see the header
#                                         of .gitlab-ci.yml for why and what they would cost.
#   - web dist/ + Android APK+AAB        : the build host over ssh (12-core box; never build on the live node)
#   - web deploy                        : rsync dist/ to the web host
#   - Android upload                    : generic package + release asset link on the tag's release
#
# SECRETS (never in the repo):
#   - build-host password : $BUILD_HOST_PASS, else first line of $BUILD_HOST_PASS_FILE (default /root/work/.build-host)
#   - GitLab token        : $GITLAB_TOKEN, else whatever git's credential helper has for
#                           gitlab.com (configured as `credential.https://gitlab.com.helper`,
#                           a store file). Needs the `api` scope: `write_repository` alone
#                           can push but cannot create a release or upload a package.
# Everything else is config below and overridable by env.
set -euo pipefail

# GitLab addresses a project either by numeric id or by its URL-ENCODED full path,
# so the %2F form is not optional decoration — `zkas-group/zkas-wallet` in a path
# segment is read as two segments and answers 404.
PROJECT="${GL_PROJECT:-zkas-group/zkas-wallet}"
PROJECT_ENC="${PROJECT//\//%2F}"
GL_API="${GL_API:-https://gitlab.com/api/v4}"
GL_WEB="${GL_WEB:-https://gitlab.com}"
# The git remote to push the release commit and tag to. `origin` is still the dead
# GitHub URL in most checkouts; pushing there is pointless, and a new GitHub account
# to replace the suspended one would be ban evasion.
GIT_REMOTE="${GIT_REMOTE:-gitlab}"
# Generic-package coordinates the release assets are uploaded under. The release's
# asset links point at these URLs, so the package name is part of every download
# link ever published — changing it orphans older links.
PKG_NAME="${PKG_NAME:-zkas-wallet}"
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
DO_BUMP=1; DO_DEPLOY=1; DO_PRE=0; FORCE_NOTES=0; VERSION=""
for a in "$@"; do
  case "$a" in
    --build|--build-only) DO_BUMP=0 ;;
    --no-deploy)          DO_DEPLOY=0 ;;
    --pre|--prerelease)   DO_PRE=1 ;;
    --force-notes)        FORCE_NOTES=1 ;;
    -*)                   die "unknown flag: $a" ;;
    *)                    VERSION="$a" ;;
  esac
done
# Allow a prerelease suffix (e.g. 1.0.17-rc1). A suffixed version is a prerelease.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "usage: release.sh [--build] [--no-deploy] [--pre] <x.y.z[-suffix]>"
[[ "$VERSION" == *-* ]] && IS_PRE=1 || IS_PRE=0
# PRE-RELEASES ARE A PROPERTY OF THE TAG HERE, NOT OF A FLAG ON THE RELEASE.
#
# GitHub had a `prerelease` boolean, and `/releases/latest` honoured it, so
# `--pre 1.0.53` could mark a plain version as a release candidate. GitLab's
# release object has no such field — the create/update endpoints take only
# name, tag_name, tag_message, description, ref, milestones, assets:links and
# released_at (verified against the live API: a GET of an existing release
# returns no `prerelease` key, only `upcoming_release`, which means
# released_at is in the future and is a scheduled release, not a candidate).
#
# What replaced it is a string test on the tag. src/desktop.ts offers an update
# only for a tag matching /^v?\d+\.\d+\.\d+$/ — so a bare `v1.0.53` tag is
# pushed at every installed desktop wallet on next launch no matter what the
# release is called. A `--pre` that did not change the tag would therefore be a
# lie that ships a candidate to everyone, which is exactly the failure the flag
# existed to prevent. So it is refused rather than silently ignored.
if [ "$DO_PRE" = 1 ] && [ "$IS_PRE" = 0 ]; then
  die "--pre needs a suffixed version (e.g. $VERSION-rc1).
     GitLab has no prerelease flag; src/desktop.ts decides from the TAG, and a bare
     v$VERSION is offered to every desktop user as a finished build."
fi
TAG="v$VERSION"
# The only marker GitLab leaves room for is the release's own name, which is what
# the Releases page and the RSS feed show. Matches the names the GitHub→GitLab
# migration already wrote for v1.0.52-rc8.
REL_NAME="ZKas Wallet $VERSION$([ "$IS_PRE" = 1 ] && echo ' (pre-release)' || true)"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ---- secrets ----
BUILD_PASS="${BUILD_HOST_PASS:-}"
[ -z "$BUILD_PASS" ] && [ -f "$BUILD_PASS_FILE" ] && BUILD_PASS="$(head -n1 "$BUILD_PASS_FILE")"
[ -n "$BUILD_PASS" ] || die "no build-host password ($BUILD_PASS_FILE or \$BUILD_HOST_PASS)"
GITLAB_TOKEN="${GITLAB_TOKEN:-${GL_TOKEN:-}}"
if [ -z "$GITLAB_TOKEN" ]; then
  # Ask git, rather than hardcoding a path. The token lives wherever
  # `credential.https://gitlab.com.helper` points (here: a `store --file` outside
  # the repo), and asking the helper also picks it up from any other helper the
  # box is configured with. GIT_TERMINAL_PROMPT=0 so a missing credential fails
  # instead of hanging a release on a password prompt.
  GITLAB_TOKEN="$(printf 'protocol=https\nhost=gitlab.com\n\n' \
    | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null \
    | sed -n 's/^password=//p' | head -1 || true)"
fi
if [ -z "$GITLAB_TOKEN" ]; then
  # Last resort: read the store file named by the helper directly, for the case
  # where `git credential fill` is unavailable or the helper line is malformed.
  gl_store="$(git config --get 'credential.https://gitlab.com.helper' 2>/dev/null \
    | sed -nE 's/^store[[:space:]]+--file[[:space:]]*=?[[:space:]]*(.+)$/\1/p')"
  [ -n "$gl_store" ] && [ -f "$gl_store" ] && GITLAB_TOKEN="$(
    sed -nE 's#^https://[^:]+:([^@]+)@gitlab\.com.*#\1#p' "$gl_store" | head -1)"
fi
[ -n "$GITLAB_TOKEN" ] || die "no GitLab token.
     Set \$GITLAB_TOKEN, or store one for git:
       git config --global credential.'https://gitlab.com'.helper 'store --file /root/.git-credentials-gitlab'
       printf 'https://<user>:<glpat>@gitlab.com\\n' >> /root/.git-credentials-gitlab
     The token needs the 'api' scope (releases + package registry), not just write_repository."
command -v sshpass >/dev/null || die "sshpass not installed"
export SSHPASS="$BUILD_PASS"
BH() { sshpass -e ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$BUILD_USER@$BUILD_HOST" "$@"; }
# PRIVATE-TOKEN, not `Authorization: token` — GitLab ignores the GitHub header and
# answers 401 for every write, which looks exactly like a revoked token.
gl_api() { curl -fsS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -H 'Content-Type: application/json' "$@"; }
# Same, but does not fail the script on a non-2xx: used where 404 is an answer
# ("no release for this tag yet") rather than an error.
gl_try() { curl -sS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -H 'Content-Type: application/json' "$@"; }

# ---- 1. version bump + tag ----
if [ "$DO_BUMP" = 1 ]; then
  log "Bumping to $VERSION and tagging $TAG"
  [ "$(git branch --show-current)" = "main" ] || die "not on main"
  git diff --quiet && git diff --cached --quiet || die "working tree dirty — commit or stash first"
  node -e "const f='package.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
  # tauri (desktop): version drives the bundle filenames the macOS workflow emits
  # Tauri drives the desktop bundles, and the WiX/MSI target refuses a pre-release
  # identifier that is not numeric ("optional pre-release identifier in app version
  # must be numeric-only"). So `1.0.17-rc9` fails the Windows build while every
  # other platform succeeds. Feed Tauri a numeric-safe form — 1.0.17-rc9 -> 1.0.17-9
  # — which keeps the builds distinguishable and satisfies MSI. A plain release
  # version passes through untouched.
  TAURI_VERSION="$(printf '%s' "$VERSION" | sed -E 's/-[A-Za-z._-]*([0-9]+)$/-\1/; s/-[A-Za-z._-]+$//')"
  echo "tauri/desktop version: $TAURI_VERSION"
  node -e "const f='src-tauri/tauri.conf.json',p=require('./'+f);p.version='$TAURI_VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
  # android: versionName follows, versionCode auto-increments
  gver="android/app/build.gradle"
  code=$(grep -oE 'versionCode [0-9]+' "$gver" | grep -oE '[0-9]+'); newcode=$((code+1))
  sed -i -E "s/versionCode [0-9]+/versionCode $newcode/; s/versionName \"[^\"]*\"/versionName \"$VERSION\"/" "$gver"
  git add package.json src-tauri/tauri.conf.json "$gver"
  git -c user.name='firecash' -c user.email='dev@firecash.info' commit -q -m "release $VERSION"
  git remote get-url "$GIT_REMOTE" >/dev/null 2>&1 || die "no git remote '$GIT_REMOTE' (add: git remote add gitlab $GL_WEB/$PROJECT.git)"
  git fetch -q "$GIT_REMOTE" main
  [ "$(git merge-base main "$GIT_REMOTE/main")" = "$(git rev-parse "$GIT_REMOTE/main")" ] || die "main is not fast-forward — rebase first"
  git push -q "$GIT_REMOTE" main
  git tag -a "$TAG" -m "zkas-wallet $VERSION"
  git push -q "$GIT_REMOTE" "$TAG"
  echo "pushed $TAG (versionCode $newcode) to $GIT_REMOTE — GitLab CI is now building the Linux desktop targets"
fi

# ---- 2. sync source to the build host ----
log "Syncing source to $BUILD_HOST:$BUILD_DIR"
BH "mkdir -p '$BUILD_DIR'"
# jniLibs is EXCLUDED from --delete on purpose. It holds the compiled on-device
# engine (~50MB of .so across three ABIs), it is gitignored, and it therefore does
# not exist in this checkout — so without this exclude, --delete wiped the engine
# off the build host on every release. build-android.sh then treats a failed
# engine build as "best-effort" and warns instead of stopping, so the run
# completed and shipped a HOSTED-ONLY ~8MB APK that looks like a normal release.
# Rebuilding the engine from scratch needs the Rust toolchain and a ~17GB target
# cache, which is why the loss was expensive as well as silent.
sshpass -e rsync -az --delete \
  --exclude .git --exclude node_modules --exclude dist --exclude release-artifacts \
  --exclude 'android/*/build' --exclude 'android/build' --exclude 'android/.gradle' \
  --exclude 'android/app/src/main/jniLibs' \
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

# An APK that exists is not an APK worth shipping. The engine build is
# best-effort by design, so every way it can fail ends in a working-but-crippled
# hosted-only package, and the ONLY reliable tell is the size: ~70MB with the
# native engine, ~8MB without it. Refuse rather than publish one by accident.
APK_BYTES=$(BH "stat -c %s '$APK_REMOTE'")
APK_MB=$(( APK_BYTES / 1000000 ))
if [ "$APK_MB" -lt 30 ]; then
  die "APK is ${APK_MB}MB — the on-device engine is MISSING (expected ~70MB).
     The build logged 'engine build skipped' and carried on. Check, on $BUILD_HOST:
       - $BUILD_DIR/android/app/src/main/jniLibs/*/libzkas_walletd_mobile.so exist
       - zkas-signer/walletd-mobile/Cargo.toml path-deps point at ../../rk-main/
       - cargo is on PATH and ENGINE_CRATE is set (see /root/zkas/android-env.sh)
     Refusing to publish a hosted-only APK as a release."
fi
log "APK is ${APK_MB}MB — on-device engine present"

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

# ---- 6. upload Android to the GitLab release ----
# Release notes. The desktop builds are ad-hoc signed (macOS, not notarized) or
# unsigned (Windows, Linux), so every OS warns on first launch; the notes say
# exactly what to click, because the README is not what a downloader is looking
# at when the warning appears. Keep in step with README "First launch".
# What actually changed, lifted from CHANGELOG.md for the version being shipped
# (an -rcN carries its base version's section). Without this the release page
# said only how to get past the first-launch warning — true, and nothing about
# the release.
CHANGELOG_SECTION="$(python3 - "$VERSION" <<'PYEOF'
import re, sys, pathlib
version = sys.argv[1].split("-rc")[0]
try:
    text = pathlib.Path("CHANGELOG.md").read_text()
except OSError:
    sys.exit(0)
# Every version in the file, newest first, as (version, lead, highlights).
entries = []
for mm in re.finditer(r"^## (\d+\.\d+\.\d+)\s*$(.*?)(?=^## |\Z)", text, re.S | re.M):
    sec = mm.group(2).strip()
    hh = re.search(r"^### Highlights\s*$(.*?)(?=^### |\Z)", sec, re.S | re.M)
    # Prefer a "### Highlights" block when the version has one. A release page is read
    # by somebody deciding whether to download; 175 lines of detail is a changelog, not
    # release notes, and that is what the link at the end is for. The lead ABOVE the
    # highlights is kept: that is where a release says what it is and any deadline
    # attached to it — 1.0.46 opened with "upgrade before 14 October, about 13:40 UTC",
    # and taking only the bullets published a mandatory security upgrade with no sign
    # that it was either.
    # "### Known issues" rides along with the highlights. The rule above — bullets, not the
    # whole changelog — is right for detail, but a known issue is not detail: it is a caveat
    # about the build being downloaded on the page it is downloaded from. 1.0.52 ships with
    # the in-app node and bridge installers broken (their archives died with the suspended
    # GitHub account), and a download page that does not say so sends people to debug a
    # failure that is already known.
    ki = re.search(r"^### Known issues\s*$(.*?)(?=^### |\Z)", sec, re.S | re.M)
    hl = hh.group(1).strip() if hh else sec
    if ki and hh:
        hl = hl + "\n\n### Known issues\n" + ki.group(1).rstrip()
    entries.append((mm.group(1), sec[: hh.start()].strip() if hh else "", hl))

idx = next((i for i, e in enumerate(entries) if e[0] == version), None)
if idx is not None:
    _, lead, highlights = entries[idx]
    out = [p for p in (lead, highlights) if p]
    # Carry the two PREVIOUS versions' highlights as well.
    #
    # The latest release is where someone upgrading arrives, whatever version they are
    # coming from — and most are not coming from the one before. 1.0.47 shipped with a
    # page describing only its own Android fixes, so the mandatory fork deadline that
    # 1.0.46 led with was nowhere on the page a user would actually open.
    prior = [e for e in entries[idx + 1 : idx + 3] if e[2]]
    for v, plead, phl in prior:
        out.append(f"## Also in {v}")
        # A prior version's lead is dropped unless it carries a deadline: it is written
        # as "this release", which reads wrong under someone else's heading.
        if plead and re.search(r"\bbefore \d|UTC\b", plead):
            out.append(plead)
        out.append(phl)

    # A deadline that has NOT passed stays on the page however many versions back it was
    # announced, because the latest release is the page people open.
    #
    # The window above is two versions, and that is right for ordinary notes. It is wrong
    # for a deadline: 1.0.46 announced the security fork, and by 1.0.49 — published the
    # morning of the cutover, with activation a day away — the warning had aged off the
    # one page a user upgrading would see. Carrying it is not about being tidy; a user who
    # installs the latest build and never learns a deadline exists is the failure.
    cutoff = idx + 3
    carried = []
    for v, plead, _ in entries[cutoff:]:
        if not plead:
            continue
        for dline in re.findall(r"^.*\b(?:20\d\d)\b.*UTC.*$", plead, re.M):
            # Only future dates: a passed deadline is history, not a warning.
            dt = re.search(r"(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d\d)", dline)
            if not dt:
                continue
            import datetime
            months = {m: i + 1 for i, m in enumerate(
                ["January","February","March","April","May","June","July","August","September","October","November","December"])}
            when = datetime.date(int(dt.group(3)), months[dt.group(2)], int(dt.group(1)))
            if when >= datetime.date.today():
                carried.append((v, plead.strip()))
            break
    if carried:
        v, plead = carried[0]
        # Ahead of everything else on the page, including this version's own notes.
        out.insert(0, f"> **Still ahead, announced in {v}:**\n>\n> " + plead.replace("\n", "\n> "))
    if prior:
        # GitLab's blob path is `/-/blob/<ref>/<path>`, not GitHub's `/blob/<ref>/<path>`.
        out.append("Full history: [CHANGELOG.md](https://gitlab.com/zkas-group/zkas-wallet/-/blob/main/CHANGELOG.md)")
    print("\n\n".join(out))
PYEOF
)"

RELEASE_NOTES="$(cat <<EOF
zkas-wallet $VERSION

$CHANGELOG_SECTION

---

**Desktop first launch.** These builds are ad-hoc signed on macOS (not notarized) and unsigned on Windows and Linux, so each OS warns once:

- **macOS** — "Apple could not verify…": click **Done**, then **System Settings → Privacy & Security → Open Anyway** (next to ZKas Wallet) and confirm. On macOS 15 right-click → Open no longer bypasses this; the Settings route is the only one.
- **Windows** — "Windows protected your PC": click **More info → Run anyway**.
- **Linux** — \`.AppImage\`: \`chmod +x\` then run; \`.deb\`: \`sudo apt install ./<file>.deb\`.

**Android** — the APK/AAB below is signed with the project's release key; the Play/AAB build updates over an existing install, the APK needs "install from this source" the first time.

Download only from this release page.
EOF
)"
# GitLab's field is `description`, not GitHub's `body`.
release_desc_json="$(printf '%s' "$RELEASE_NOTES" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')"
rel_name_json="$(printf '%s' "$REL_NAME" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')"

# GitLab releases are addressed by TAG, not by a numeric id, and a release and its
# asset links are separate objects. That removes the race GitHub had: the desktop
# jobs and this script no longer have to agree on who creates the release, because
# create-if-absent is idempotent and each side only adds its own links. So there is
# no "wait up to 10 minutes for CI" loop any more — this used to stall every
# release by its full timeout whenever CI was slow or had not run at all.
log "Publishing the $TAG release and its Android artifacts"
rel_http="$(gl_try -o /tmp/rel-get.json -w '%{http_code}' "$GL_API/projects/$PROJECT_ENC/releases/$TAG")"
if [ "$rel_http" = "404" ]; then
  echo "no release for $TAG yet; creating it"
  REL_NAME_JSON="$rel_name_json" REL_DESC_JSON="$release_desc_json" \
    python3 - "$TAG" > /tmp/rel-new.json <<'PYEOF'
import json, os, sys
print(json.dumps({
    "tag_name": sys.argv[1],
    "name": json.loads(os.environ["REL_NAME_JSON"]),
    "description": json.loads(os.environ["REL_DESC_JSON"]),
}))
PYEOF
  gl_api -X POST "$GL_API/projects/$PROJECT_ENC/releases" --data @/tmp/rel-new.json >/dev/null
  echo "created release $TAG"
elif [ "$rel_http" = "200" ]; then
  # CI creates the release with a placeholder description. Put the first-launch
  # notes on it — but never over notes someone has written by hand.
  cur_body="$(python3 -c 'import json;print(json.load(open("/tmp/rel-get.json")).get("description") or "")' 2>/dev/null || true)"
  # Any one-line CI placeholder, not just one literal string. v1.0.44 shipped with
  # "macOS (Intel) desktop wallet." as its entire release page, because the guard
  # matched one literal and treated every other placeholder as notes somebody had
  # written by hand. Real notes run to many lines; a placeholder is one short line
  # naming a build.
  placeholder=0
  if [ "$(printf '%s' "$cur_body" | wc -l)" -le 1 ] && [ "${#cur_body}" -lt 120 ]; then placeholder=1; fi
  # `--force-notes` overwrites notes this script generated. Needed when the GENERATOR
  # improves after a release is published: 1.0.52-rc9 went out before "### Known issues"
  # was carried onto the page, and its own 6,371-character body then looked hand-written to
  # the test above, so re-running could not correct it. Opt-in, because the default must
  # keep protecting notes a person actually wrote.
  if [ -z "$cur_body" ] || [ "$placeholder" = 1 ] || [ "$FORCE_NOTES" = 1 ]; then
    # PUT, not PATCH: GitLab's update-release verb is PUT. There is no PATCH route at
    # all — a PATCH of a release that exists answers 404, which reads like a wrong tag.
    printf '{"name":%s,"description":%s}' "$rel_name_json" "$release_desc_json" > /tmp/rel-upd.json
    gl_api -X PUT "$GL_API/projects/$PROJECT_ENC/releases/$TAG" --data @/tmp/rel-upd.json >/dev/null \
      && echo "release notes written to $TAG"
  else
    echo "release $TAG already has hand-written notes; left alone"
  fi
else
  die "GET release $TAG answered HTTP $rel_http: $(head -c 300 /tmp/rel-get.json)"
fi

# ASSETS: generic package + an asset link, not a GitHub-style upload.
#
# GitLab has no uploads.github.com. A release's `assets.links` are just LINKS —
# they point at a file that is already hosted somewhere, and creating one uploads
# nothing. The two ways to actually host the bytes on GitLab are the project's
# generic package registry and job artifacts. Job artifacts expire (30 days by
# default) and are scoped to the pipeline that produced them, so a link to one is a
# download that stops working; the generic registry is permanent, is on the Free
# tier, and serves the file anonymously for a public project — verified against the
# live project: an unauthenticated GET of
#   $GL_API/projects/$PROJECT_ENC/packages/generic/zkas-wallet/1.0.51/zkas-wallet-1.0.51.apk
# answers 200, 59,890,885 bytes, Content-Type application/vnd.android.package-archive.
# So: PUT the file into the registry, then point a link at it. This is also the
# shape the GitHub→GitLab migration already used for v1.0.51 and v1.0.52-rc8, so
# older and newer releases stay consistent.
#
# Re-runs: a second PUT of the same name+version+filename is allowed by default and
# supersedes the earlier file (GitLab keeps both package_files and serves the newest),
# but a link whose NAME or URL already exists on the release is rejected 400, so the
# old link is deleted first.
PKG_BASE="$GL_API/projects/$PROJECT_ENC/packages/generic/$PKG_NAME/$VERSION"
upload() { # <file>
  local f="$1" name code
  name="$(basename "$f")"
  [ -f "$f" ] || die "missing artifact $f"
  code="$(curl -sS -o /tmp/rel-up.json -w '%{http_code}' \
    -H "PRIVATE-TOKEN: $GITLAB_TOKEN" --upload-file "$f" "$PKG_BASE/$name")"
  # 201 Created on success. A 2xx that is not 201 is still a success; anything else is not.
  case "$code" in
    2*) ;;
    *) die "package upload of $name failed (HTTP $code): $(head -c 300 /tmp/rel-up.json)" ;;
  esac
  # Drop any existing link with this name or URL so the release ends up with
  # exactly one link per artifact however many times this is re-run.
  gl_api "$GL_API/projects/$PROJECT_ENC/releases/$TAG/assets/links" \
    | NAME="$name" URL="$PKG_BASE/$name" python3 -c '
import json, os, sys
name, url = os.environ["NAME"], os.environ["URL"]
for l in json.load(sys.stdin):
    if l.get("name") == name or l.get("url") == url:
        print(l["id"])' \
    | while read -r lid; do
        gl_api -X DELETE "$GL_API/projects/$PROJECT_ENC/releases/$TAG/assets/links/$lid" >/dev/null || true
      done
  # link_type "package" is what GitLab shows under "Other"/package assets and is
  # what the migrated releases use. (`direct_asset_path` would additionally give a
  # stable /-/releases/<tag>/downloads/<path> permalink; nothing published points
  # at one, so it is left off rather than introducing a second URL shape.)
  NAME="$name" URL="$PKG_BASE/$name" python3 -c '
import json, os
print(json.dumps({"name": os.environ["NAME"], "url": os.environ["URL"], "link_type": "package"}))' \
    > /tmp/rel-link.json
  gl_api -X POST "$GL_API/projects/$PROJECT_ENC/releases/$TAG/assets/links" --data @/tmp/rel-link.json >/dev/null
  echo "uploaded + linked $name"
}
upload "$OUT/zkas-wallet-$VERSION.apk"
upload "$OUT/zkas-wallet-$VERSION.aab"
upload "$OUT/web-dist-$VERSION.tgz"

log "Release $TAG done"
echo "  page    : $GL_WEB/$PROJECT/-/releases/$TAG"
echo "  desktop : GitLab CI/CD → $GL_WEB/$PROJECT/-/pipelines (Linux x86_64/aarch64 only)"
echo "  android : APK + AAB uploaded to release $TAG"
echo "  web     : $([ "$DO_DEPLOY" = 1 ] && echo 'deployed to wallet.zkas.info' || echo 'built, not deployed (--no-deploy)')"
