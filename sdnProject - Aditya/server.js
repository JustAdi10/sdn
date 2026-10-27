// Zero-dependency server. Run: node server.js  ->  http://localhost:8100
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Network } = require("./sim");

const net = new Network();
const page = path.join(__dirname, "public", "index.html");
const send = (res, body, type = "application/json") => {
  res.writeHead(200, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http.createServer((req, res) => {
  if (req.method === "GET") {
    return req.url === "/api/state" ? send(res, net.state()) : send(res, fs.readFileSync(page), "text/html");
  }
  let raw = "";
  req.on("data", d => (raw += d));
  req.on("end", () => {
    const b = raw ? JSON.parse(raw) : {};
    switch (req.url) {
      case "/api/start": net.start(); break;
      case "/api/stop": net.stop(); break;
      case "/api/reset": net.reset(); break;
      case "/api/monitor": net.ctl.monitored = new Set(b.flows || []); break;
      case "/api/rate": { const f = net.flows.find(f => f.name === b.name); if (f) f.pps = Math.max(0, Math.min(400, +b.pps)); break; }
    }
    send(res, { ok: true });
  });
}).listen(8100, "127.0.0.1", () => console.log("SDN console on http://localhost:8100"));
