import ssl
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://ns.recblue.workers.dev"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
USE_TLS = len(sys.argv) > 2 and sys.argv[2] == "--tls"
CERT = sys.argv[3] if USE_TLS else None
KEY = sys.argv[4] if USE_TLS else None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[{self.address_string()}] {fmt % args}", flush=True)

    def _forward(self, method):
        body = None
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            body = self.rfile.read(length)
        url = UPSTREAM + self.path
        headers = {
            "Host": "ns.recblue.workers.dev",
            "User-Agent": self.headers.get("User-Agent", "RecRoom-local-test"),
            "Accept": self.headers.get("Accept", "*/*"),
        }
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        print(f"REQUEST {method} {self.path} host={self.headers.get('Host')} ua={headers['User-Agent']}", flush=True)
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=30) as resp:
                data = resp.read()
                status = resp.status
                ctype = resp.headers.get("Content-Type", "application/json")
                print(f"RESPONSE {status} {len(data)} bytes ctype={ctype}", flush=True)
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as exc:
            data = exc.read()
            print(f"HTTPERROR {exc.code} {len(data)} bytes", flush=True)
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            print(f"ERROR {type(exc).__name__}: {exc}", flush=True)
            data = str(exc).encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def do_GET(self):
        self._forward("GET")

    def do_HEAD(self):
        self._forward("HEAD")

    def do_POST(self):
        self._forward("POST")


if __name__ == "__main__":
    print(f"listening on 0.0.0.0:{PORT} tls={USE_TLS}, upstream={UPSTREAM}", flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    if USE_TLS:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
