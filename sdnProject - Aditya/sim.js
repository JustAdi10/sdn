// SDN simulation: 2 switches, 4 hosts, 1 server, 1 controller.
//
//   h1 ─┐                 ┌─ h3
//   h2 ─┼─ s1 ═══════ s2 ─┤
//  srv ─┘                 └─ h4
//
// Switches keep OpenFlow-style flow tables with per-entry packet/byte counters.
// A table miss raises packet-in; the controller picks a shortest path and
// installs an entry on each switch along it. The controller then polls flow
// stats from the switches and keeps history for the flows it is told to watch.

const LINKS = [["h1", "s1"], ["h2", "s1"], ["srv", "s1"], ["s1", "s2"], ["s2", "h3"], ["s2", "h4"]];
const HOSTS = ["h1", "h2", "h3", "h4", "srv"];

class Switch {
  constructor(name, ctl) { this.name = name; this.ctl = ctl; this.table = new Map(); }
  forward(pkt) {
    const key = pkt.flow;
    let e = this.table.get(key);
    if (!e) { this.ctl.packetIn(this, pkt); e = this.table.get(key); }
    e.packets++; e.bytes += pkt.size;
  }
  statsReply() { // like OFPMP_FLOW reply
    const out = {};
    for (const [k, e] of this.table) out[k] = { packets: e.packets, bytes: e.bytes };
    return out;
  }
}

class Controller {
  constructor() {
    this.adj = {};
    for (const [a, b] of LINKS) { (this.adj[a] ??= []).push(b); (this.adj[b] ??= []).push(a); }
    this.switches = { s1: new Switch("s1", this), s2: new Switch("s2", this) };
    this.reset();
  }
  reset() {
    for (const s of Object.values(this.switches)) s.table.clear();
    this.packetIns = 0; this.monitored = new Set(); this.stats = {}; this.history = {};
    this.prev = null;
  }
  path(src, dst) {
    const prev = { [src]: null }, q = [src];
    while (q.length) {
      const n = q.shift();
      if (n === dst) break;
      for (const m of this.adj[n]) if (!(m in prev)) { prev[m] = n; q.push(m); }
    }
    const p = []; for (let n = dst; n; n = prev[n]) p.unshift(n);
    return p;
  }
  packetIn(sw, pkt) {
    this.packetIns++;
    for (const n of this.path(pkt.src, pkt.dst)) {
      const s = this.switches[n];
      if (s && !s.table.has(pkt.flow)) s.table.set(pkt.flow, { packets: 0, bytes: 0 });
    }
  }
  poll(now) { // stats request to every switch
    const replies = {};
    for (const [n, s] of Object.entries(this.switches)) replies[n] = s.statsReply();
    const dt = this.prev ? (now - this.prev.t) / 1000 : 0;
    for (const [n, tbl] of Object.entries(replies)) {
      for (const [k, v] of Object.entries(tbl)) {
        const p = this.prev?.r[n]?.[k];
        const rec = (this.stats[k] ??= { sw: {} });
        rec.sw[n] = { ...v, pps: p && dt ? (v.packets - p.packets) / dt : 0, bps: p && dt ? ((v.bytes - p.bytes) * 8) / dt : 0 };
        if (this.monitored.has(k) && n === rec.ingress) {
          const h = (this.history[k] ??= []);
          h.push({ t: now, pps: rec.sw[n].pps, bps: rec.sw[n].bps, packets: v.packets, bytes: v.bytes });
          if (h.length > 90) h.shift();
        }
      }
    }
    this.prev = { t: now, r: replies };
  }
}

// name, src, dst, proto, dport, pkt size, default pps
const FLOWS = [
  ["web",   "h1", "srv", "tcp", 80,   1200, 60],
  ["tls",   "h2", "srv", "tcp", 443,  900,  40],
  ["dns",   "h3", "srv", "udp", 53,   90,   25],
  ["video", "h1", "h4",  "udp", 5004, 1300, 90],
  ["ssh",   "h2", "h3",  "tcp", 22,   180,  12],
  ["bulk",  "h4", "srv", "tcp", 873,  1450, 30],
].map(([name, src, dst, proto, dport, size, pps]) => ({
  name, src, dst, proto, dport, size, pps, acc: 0, key: `${src}>${dst}:${proto}/${dport}`,
}));

class Network {
  constructor() { this.ctl = new Controller(); this.running = false; this.flows = FLOWS.map(f => ({ ...f })); this.timer = null; this.t0 = 0; }
  start() {
    if (this.running) return;
    this.running = true; this.t0 ||= Date.now();
    let last = Date.now(), lastPoll = last;
    this.timer = setInterval(() => {
      const now = Date.now(), dt = (now - last) / 1000; last = now;
      for (const f of this.flows) {
        f.acc += f.pps * dt;
        while (f.acc >= 1) {
          f.acc--;
          const size = Math.max(40, Math.round(f.size * (0.85 + Math.random() * 0.3)));
          const pkt = { src: f.src, dst: f.dst, size, flow: f.key };
          for (const n of this.ctl.path(f.src, f.dst)) this.ctl.switches[n]?.forward(pkt);
        }
      }
      if (now - lastPoll >= 1000) { lastPoll = now; this.ctl.poll(now); }
    }, 50);
  }
  stop() { clearInterval(this.timer); this.running = false; }
  reset() { this.stop(); this.ctl.reset(); this.t0 = 0; for (const f of this.flows) f.acc = 0; }
  state() {
    const c = this.ctl;
    const flows = this.flows.map(f => {
      const path = c.path(f.src, f.dst), rec = c.stats[f.key];
      const ing = path.find(n => c.switches[n]);
      if (rec) rec.ingress = ing;
      const s = rec?.sw[ing] || { packets: 0, bytes: 0, pps: 0, bps: 0 };
      return { name: f.name, key: f.key, src: f.src, dst: f.dst, proto: f.proto, dport: f.dport, path, configuredPps: f.pps,
        installed: !!rec, packets: s.packets, bytes: s.bytes, pps: s.pps, bps: s.bps,
        perSwitch: rec ? Object.fromEntries(Object.entries(rec.sw).map(([n, v]) => [n, { packets: v.packets, bytes: v.bytes }])) : {},
        monitored: c.monitored.has(f.key), history: (c.history[f.key] || []).map(h => ({ t: h.t, bps: h.bps, pps: h.pps })) };
    });
    return { running: this.running, uptime: this.t0 ? (Date.now() - this.t0) / 1000 : 0, packetIns: c.packetIns,
      flowEntries: Object.values(c.switches).reduce((a, s) => a + s.table.size, 0), flows, analysis: this.analyse(flows) };
  }
  analyse(flows) {
    const out = [], live = flows.filter(f => f.installed && f.packets > 0);
    if (live.length < 2) return ["Waiting for traffic… start the generator."];
    const totB = live.reduce((a, f) => a + f.bytes, 0), totP = live.reduce((a, f) => a + f.packets, 0);
    const top = [...live].sort((a, b) => b.bytes - a.bytes);
    out.push(`TOP TALKER  ${top[0].name} carries ${(100 * top[0].bytes / totB).toFixed(0)}% of bytes (${top[0].key})`);
    const chatty = [...live].sort((a, b) => b.packets - a.packets)[0];
    if (chatty !== top[0]) out.push(`MOST PACKETS  ${chatty.name} sends the most packets (${chatty.packets}) but is not the byte leader`);
    const small = [...live].sort((a, b) => a.bytes / a.packets - b.bytes / b.packets)[0];
    const big = top.reduce((m, f) => (f.bytes / f.packets > m.bytes / m.packets ? f : m));
    out.push(`PACKET SIZE  avg ${Math.round(totB / totP)} B overall; smallest ${small.name} (${Math.round(small.bytes / small.packets)} B), largest ${big.name} (${Math.round(big.bytes / big.packets)} B)`);
    const x = live.filter(f => f.path.includes("s1") && f.path.includes("s2"));
    const trunkB = x.reduce((a, f) => a + f.bytes, 0);
    out.push(`TRUNK s1↔s2  ${x.length}/${live.length} flows cross it, ${(100 * trunkB / totB).toFixed(0)}% of bytes`);
    const bad = x.filter(f => f.perSwitch.s1 && f.perSwitch.s2 && Math.abs(f.perSwitch.s1.packets - f.perSwitch.s2.packets) > 20);
    out.push(bad.length ? `CHECK  counter mismatch between switches on ${bad.map(f => f.name).join(", ")}` : "CHECK  per-switch counters agree on all trunk flows");
    const w = flows.filter(f => f.monitored && f.history.length > 5);
    for (const f of w) {
      const h = f.history.slice(-30), mean = h.reduce((a, p) => a + p.bps, 0) / h.length, last = h.at(-1).bps;
      if (mean > 0 && last > 1.4 * mean) out.push(`BURST  ${f.name} at ${(last / 1e6).toFixed(2)} Mb/s, ${(last / mean).toFixed(1)}× its recent mean`);
    }
    return out;
  }
}

module.exports = { Network, HOSTS, LINKS };
