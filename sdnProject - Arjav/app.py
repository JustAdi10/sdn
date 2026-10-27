"""Tiny web UI server. Run: python3 app.py  ->  http://localhost:8000"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from sdn import Network

net = Network()
HTML = Path(__file__).with_name("index.html")


class H(BaseHTTPRequestHandler):
    def _send(self, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/state":
            self._send(net.analysis())
        else:
            self._send(HTML.read_bytes(), "text/html")

    def do_POST(self):
        global net
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/api/start":
            net.start()
        elif self.path == "/api/stop":
            net.stop()
        elif self.path == "/api/reset":
            net.reset()
        elif self.path == "/api/monitor":
            net.ctl.select(body.get("flows", []))
        elif self.path == "/api/rate":
            net.rates[body["name"]] = max(0, min(500, float(body["pps"])))
        self._send({"ok": True})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print("SDN demo on http://localhost:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), H).serve_forever()
