#!/usr/bin/env python3
"""Test-instance server for the zkas wallet SPA.

Serves the static build from dist/ (with SPA fallback) and reverse-proxies
/daemon/* to the production walletd, stripping the Origin header so the
daemon's --allow-origin allowlist doesn't reject this test origin.

No content injection: index.html is served byte-identical to dist/.
"""
import http.server, socketserver, ssl, urllib.request, urllib.error, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
UPSTREAM = "https://wallet.zkas.info/daemon"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 48371

HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "te",
              "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIST, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _proxy(self):
        path = self.path[len("/daemon"):] or "/"
        url = UPSTREAM + path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=self.command)
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in HOP_BY_HOP or lk in ("host", "origin", "referer", "content-length"):
                continue
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context()) as r:
                self.send_response(r.status)
                for k, v in r.getheaders():
                    if k.lower() not in HOP_BY_HOP:
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(r.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(("upstream error: %s" % e).encode())

    def _serve_index(self):
        with open(os.path.join(DIST, "index.html"), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/daemon"):
            return self._proxy()
        rel = self.path.split("?")[0].lstrip("/")
        if rel in ("", "index.html"):
            return self._serve_index()
        if os.path.isfile(os.path.join(DIST, rel)):
            return super().do_GET()
        return self._serve_index()  # SPA fallback

    do_POST = _proxy
    do_PUT = _proxy
    do_DELETE = _proxy
    do_PATCH = _proxy


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler) as srv:
    print(f"serving {DIST} on 0.0.0.0:{PORT}, /daemon -> {UPSTREAM}")
    srv.serve_forever()
