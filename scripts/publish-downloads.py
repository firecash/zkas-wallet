#!/usr/bin/env python3
"""Regenerate the wallet download pages and update feed on zkas.info.

    python3 scripts/publish-downloads.py [/var/www/zkas.info/html/downloads/wallet]

Run on VPS1 after copying a release's files into <root>/<version>/. It writes:

  <root>/<version>/SHA256SUMS   checksums of every file in that folder
  <root>/<version>/index.html   the release page (what the in-app updater links to)
  <root>/index.html             every release, newest first
  <root>/releases.json          the feed src/desktop.ts reads:
                                {"releases":[{"version","url","prerelease","date","files"}]}

Releases are no longer on a forge: GitHub and GitLab both blocked the account in
October 2026. Everything here is derived from the folders on disk, so re-running it
is always safe and a release is published by adding its folder.
"""
import hashlib
import html
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/var/www/zkas.info/html/downloads/wallet"
BASE_URL = "https://zkas.info/downloads/wallet/"
SOURCE_URL = "https://zkas.info/code/wallet"
# Signed Radicle release records (rad-artifact), looked up by tag. Only zkas.info names here:
# nginx on VPS1 maps /code/... to wherever the seed lives, so a move changes nginx only.
RADICLE_API = "https://zkas.info/code/api/repos/zkas-wallet/releases"
RADICLE_RELEASES = "https://zkas.info/code/wallet/releases"
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$")

# (filename suffix, platform label), in display order.
PLATFORMS = [
    ("-windows-x86_64-setup.exe", "Windows (64-bit installer)"),
    ("-macos-aarch64.dmg", "macOS, Apple Silicon (.dmg)"),
    ("-macos-aarch64.zip", "macOS, Apple Silicon (.zip)"),
    ("-macos-x86_64.dmg", "macOS, Intel (.dmg)"),
    ("-macos-x86_64.zip", "macOS, Intel (.zip)"),
    ("-linux-x86_64.AppImage", "Linux (AppImage)"),
    ("-linux-x86_64.deb", "Linux (Debian/Ubuntu .deb)"),
    ("-android.apk", "Android (APK)"),
    ("-web.tgz", "Web app bundle (self-hosting)"),
]


def version_key(v):
    m = VERSION_RE.match(v)
    triple = tuple(int(x) for x in m.group(1, 2, 3))
    pre = m.group(4)
    # A final release outranks its own pre-releases; pre-releases order by trailing number.
    pre_n = int(re.search(r"(\d+)$", pre).group(1)) if pre and re.search(r"(\d+)$", pre) else 0
    return (triple, 0 if pre else 1, pre_n)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def label_for(name):
    for suffix, label in PLATFORMS:
        if name.endswith(suffix):
            return label
    return name


def order_for(name):
    for i, (suffix, _) in enumerate(PLATFORMS):
        if name.endswith(suffix):
            return i
    return len(PLATFORMS)


STYLE = """
:root{--bg:#0b0f0c;--card:#121a14;--fg:#e6efe8;--dim:#9db3a3;--acc:#38d27a;--line:#24342a}
@media (prefers-color-scheme: light){:root{--bg:#f6faf7;--card:#fff;--fg:#0f1a13;--dim:#4d6455;--acc:#14843f;--line:#d6e3da}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px max(16px,env(safe-area-inset-left))}
h1{font-size:26px;margin:0 0 4px}p{color:var(--dim);margin:6px 0 18px}a{color:var(--acc)}
.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim);margin-left:8px;vertical-align:middle}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td,th{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
tr:last-child td{border-bottom:0}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);word-break:break-all}
.wrap{overflow-x:auto}.note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:var(--dim);margin:18px 0}
"""


def page(title, body):
    return (
        "<!doctype html><html lang=en><head><meta charset=utf-8>"
        '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
        f"<title>{html.escape(title)}</title><style>{STYLE}</style></head>"
        f"<body><main>{body}</main></body></html>\n"
    )


def radicle_release_ids():
    """tag name -> Radicle release id; empty if the node cannot be reached."""
    try:
        with urllib.request.urlopen(RADICLE_API, timeout=15) as r:
            data = json.load(r)
        return {x["tagName"]: x.get("id") or x.get("releaseId") for x in data if x.get("tagName") and (x.get("id") or x.get("releaseId"))}
    except Exception as e:  # the pages must still publish when the seed is down
        print(f"note: no Radicle release ids ({e})")
        return {}


def main():
    rad_ids = radicle_release_ids()
    releases = []
    for v in sorted((d for d in os.listdir(ROOT) if VERSION_RE.match(d) and os.path.isdir(os.path.join(ROOT, d))),
                    key=version_key, reverse=True):
        d = os.path.join(ROOT, v)
        names = sorted((n for n in os.listdir(d) if n.startswith("ZKas-Wallet-")), key=order_for)
        if not names:
            continue
        files = []
        for n in names:
            p = os.path.join(d, n)
            files.append({"name": n, "label": label_for(n), "size": os.path.getsize(p), "sha256": sha256(p),
                          "url": f"{BASE_URL}{v}/{n}"})
        with open(os.path.join(d, "SHA256SUMS"), "w") as f:
            f.writelines(f"{x['sha256']}  {x['name']}\n" for x in files)
        date = datetime.fromtimestamp(max(os.path.getmtime(os.path.join(d, n)) for n in names), timezone.utc)
        pre = bool(VERSION_RE.match(v).group(4))
        rad_id = rad_ids.get(f"v{v}")
        rad_url = f"{RADICLE_RELEASES}/{rad_id}" if rad_id else None
        rel = {"version": v, "url": f"{BASE_URL}{v}/", "prerelease": pre, "date": date.strftime("%Y-%m-%d"),
               "radicle": rad_url,
               "files": [{k: x[k] for k in ("name", "size", "sha256", "url")} for x in files]}
        releases.append(rel)

        rows = "".join(
            f"<tr><td>{html.escape(x['label'])}</td><td><a href=\"{html.escape(x['name'])}\">{html.escape(x['name'])}</a>"
            f"<br><code>sha256 {x['sha256']}</code></td><td>{human(x['size'])}</td></tr>" for x in files)
        tag = '<span class="tag">pre-release</span>' if pre else ""
        mac = any("-macos-" in x["name"] for x in files)
        body = (
            f"<h1>ZKas Wallet {html.escape(v)}{tag}</h1>"
            f"<p>Released {rel['date']} · <a href=\"SHA256SUMS\">SHA256SUMS</a> · "
            f"<a href=\"{SOURCE_URL}\">source code</a> · "
            + (f"<a href=\"{rad_url}\">signed release on Radicle</a> · " if rad_url else "")
            + "<a href=\"../\">all releases</a></p>"
            f"<div class=wrap><table><tr><th>Platform</th><th>File</th><th>Size</th></tr>{rows}</table></div>"
            + ("<div class=note>macOS: the app is not notarized yet. On first launch macOS refuses it; open "
               "System Settings → Privacy &amp; Security and click <b>Open Anyway</b>.</div>" if mac else "")
            + "<div class=note>Check a download: <code>sha256sum &lt;file&gt;</code> (Linux), "
              "<code>shasum -a 256 &lt;file&gt;</code> (macOS), <code>certutil -hashfile &lt;file&gt; SHA256</code> "
              "(Windows) and compare with the value above.</div>")
        with open(os.path.join(d, "index.html"), "w") as f:
            f.write(page(f"ZKas Wallet {v}", body))

    rows = "".join(
        f"<tr><td><a href=\"{r['version']}/\">{r['version']}</a>{'<span class=tag>pre-release</span>' if r['prerelease'] else ''}"
        f"</td><td>{r['date']}</td><td>{len(r['files'])} files</td></tr>" for r in releases)
    body = ("<h1>ZKas Wallet downloads</h1>"
            f"<p>Every release, newest first. Source: <a href=\"{SOURCE_URL}\">zkas.info/code/wallet</a> · "
            f"<a href=\"{RADICLE_RELEASES}\">signed releases on Radicle</a>.</p>"
            f"<div class=wrap><table><tr><th>Version</th><th>Date</th><th>Files</th></tr>{rows}</table></div>")
    with open(os.path.join(ROOT, "index.html"), "w") as f:
        f.write(page("ZKas Wallet downloads", body))

    tmp = os.path.join(ROOT, ".releases.json.tmp")
    with open(tmp, "w") as f:
        json.dump({"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "releases": releases}, f, indent=1)
    os.replace(tmp, os.path.join(ROOT, "releases.json"))
    for dirpath, _, fnames in os.walk(ROOT):
        os.chmod(dirpath, 0o755)
        for n in fnames:
            os.chmod(os.path.join(dirpath, n), 0o644)
    print(f"{len(releases)} release(s): " + ", ".join(r["version"] for r in releases))


if __name__ == "__main__":
    main()
