r"""Minimal SDN simulation: 2 switches, 4 hosts, 1 server, 1 controller.

Topology:   h1 --\                 /-- h3
                  s1 ========== s2 --- h4
            h2 --/                 \-- srv

Switches hold OpenFlow-style flow tables with per-entry packet/byte counters.
On a table miss the switch sends a packet-in to the controller, which computes
a path and installs flow entries along it. The controller polls flow stats
from every switch and keeps a time series for the flows the user selects.
"""
import random
import threading
import time
from collections import deque

HOSTS = {"h1": "10.0.0.1", "h2": "10.0.0.2", "h3": "10.0.0.3", "h4": "10.0.0.4", "srv": "10.0.0.100"}
LINKS = [("h1", "s1"), ("h2", "s1"), ("s1", "s2"), ("s2", "h3"), ("s2", "h4"), ("s2", "srv")]


class Switch:
    def __init__(self, name, controller):
        self.name, self.controller = name, controller
        self.table = {}  # match(tuple) -> {"next": node, "packets": int, "bytes": int}
        self.lock = threading.Lock()

    def receive(self, pkt):
        match = (pkt["src"], pkt["dst"], pkt["proto"], pkt["dport"])
        with self.lock:
            entry = self.table.get(match)
        if entry is None:  # table miss -> packet-in
            self.controller.packet_in(self, pkt)
            with self.lock:
                entry = self.table.get(match)
        with self.lock:
            entry["packets"] += 1
            entry["bytes"] += pkt["size"]
        return entry["next"]

    def flow_stats(self):  # OFPMP_FLOW stats reply
        with self.lock:
            return {m: (e["packets"], e["bytes"]) for m, e in self.table.items()}


class Controller:
    def __init__(self):
        self.adj = {}
        for a, b in LINKS:
            self.adj.setdefault(a, []).append(b)
            self.adj.setdefault(b, []).append(a)
        self.switches = {n: Switch(n, self) for n in ("s1", "s2")}
        self.packet_ins = 0
        self.monitored = set()   # flow keys chosen in the UI
        self.history = {}        # flow key -> deque[(t, packets, bytes)]
        self.latest = {}         # flow key -> (packets, bytes) at ingress switch
        self.lock = threading.Lock()

    def path(self, src, dst):  # BFS shortest path
        prev, q = {src: None}, deque([src])
        while q:
            n = q.popleft()
            for m in self.adj[n]:
                if m not in prev:
                    prev[m] = n
                    q.append(m)
        p, n = [], dst
        while n:
            p.append(n)
            n = prev[n]
        return p[::-1]

    def packet_in(self, sw, pkt):
        self.packet_ins += 1
        p = self.path(pkt["src"], pkt["dst"])
        match = (pkt["src"], pkt["dst"], pkt["proto"], pkt["dport"])
        for i, node in enumerate(p):  # flow-mod on each switch along the path
            if node in self.switches:
                s = self.switches[node]
                with s.lock:
                    s.table.setdefault(match, {"next": p[i + 1], "packets": 0, "bytes": 0})

    def poll(self):
        """Flow-stats request to every switch; record selected flows from their ingress switch."""
        now = time.time()
        with self.lock:
            for sw in self.switches.values():
                for match, (pk, by) in sw.flow_stats().items():
                    key = fkey(match)
                    if self.path(match[0], match[1])[1] != sw.name:
                        continue  # count each flow once, at its ingress switch
                    self.latest[key] = (pk, by)
                    if key in self.monitored:
                        self.history.setdefault(key, deque(maxlen=120)).append((now, pk, by))

    def select(self, keys):
        with self.lock:
            self.monitored = set(keys)
            for k in list(self.history):
                if k not in self.monitored:
                    del self.history[k]


def fkey(m):
    return f"{m[0]}>{m[1]}:{m[2]}/{m[3]}"


class Network:
    # name, src, dst, proto, dport, packets/sec, (min,max) packet size
    FLOWS = [
        ("HTTP",  "h1", "srv", "tcp", 80,   40, (400, 1500)),
        ("HTTPS", "h2", "srv", "tcp", 443,  25, (300, 1500)),
        ("DNS",   "h3", "srv", "udp", 53,   15, (60, 120)),
        ("SSH",   "h4", "srv", "tcp", 22,   8,  (80, 200)),
        ("ICMP",  "h3", "h1",  "icmp", 0,   5,  (64, 98)),
        ("VIDEO", "h2", "h4",  "udp", 5004, 60, (1000, 1400)),
    ]

    def __init__(self):
        self.ctl = Controller()
        self.running = False
        self.rates = {f[0]: f[5] for f in self.FLOWS}
        self.sent = 0
        self.thread = None

    def inject(self, src, dst, proto, dport, size):
        pkt = dict(src=src, dst=dst, proto=proto, dport=dport, size=size)
        node = self.ctl.adj[src][0]
        while node in self.ctl.switches:
            node = self.ctl.switches[node].receive(pkt)
        self.sent += 1

    def _loop(self):
        tick, last_poll = 0.1, 0
        while self.running:
            for name, s, d, pr, dp, _, (lo, hi) in self.FLOWS:
                n = self.rates[name] * tick
                n = int(n) + (random.random() < n - int(n))
                for _ in range(n):
                    self.inject(s, d, pr, dp, random.randint(lo, hi))
            if time.time() - last_poll >= 1:
                self.ctl.poll()
                last_poll = time.time()
            time.sleep(tick)

    def start(self):
        if not self.running:
            self.running = True
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()

    def stop(self):
        self.running = False

    def reset(self):
        self.stop()
        if self.thread:
            self.thread.join()
        self.ctl, self.sent = Controller(), 0

    def analysis(self):
        """Summarise the controller's collected statistics."""
        flows = []
        for key, (pk, by) in self.ctl.latest.items():
            rate = None
            h = self.ctl.history.get(key)
            if h and len(h) >= 2:
                (t0, p0, b0), (t1, p1, b1) = h[max(0, len(h) - 6)], h[-1]
                if t1 > t0:
                    rate = {"pps": (p1 - p0) / (t1 - t0), "bps": 8 * (b1 - b0) / (t1 - t0)}
            flows.append({"key": key, "packets": pk, "bytes": by, "avg_size": by / pk if pk else 0,
                          "monitored": key in self.ctl.monitored, "rate": rate})
        flows.sort(key=lambda f: -f["bytes"])
        tot_b = sum(f["bytes"] for f in flows) or 1
        tot_p = sum(f["packets"] for f in flows)
        by_src, by_proto = {}, {}
        for f in flows:
            src, rest = f["key"].split(">")
            proto = rest.split(":")[1].split("/")[0]
            by_src[src] = by_src.get(src, 0) + f["bytes"]
            by_proto[proto] = by_proto.get(proto, 0) + f["bytes"]
        for f in flows:
            f["share"] = f["bytes"] / tot_b
        return {
            "flows": flows, "total_packets": tot_p, "total_bytes": tot_b if flows else 0,
            "top_talker": max(by_src, key=by_src.get) if by_src else None,
            "by_src": by_src, "by_proto": by_proto,
            "elephants": [f["key"] for f in flows if f["share"] > 0.3],
            "packet_ins": self.ctl.packet_ins, "running": self.running,
            "rates": self.rates,
            "tables": {n: len(s.table) for n, s in self.ctl.switches.items()},
            "series": {k: [(round(t - h[-1][0], 1), p, b) for t, p, b in h] for k, h in self.ctl.history.items()},
        }


if __name__ == "__main__":  # headless run + report
    net = Network()
    net.start()
    time.sleep(1.2)
    net.ctl.select(["h1>srv:tcp/80", "h2>h4:udp/5004", "h3>srv:udp/53"])
    time.sleep(8)
    net.stop()
    net.ctl.poll()
    a = net.analysis()
    print(f"{'flow':26}{'packets':>9}{'bytes':>11}{'avg B':>7}{'share':>7}  rate")
    for f in a["flows"]:
        r = f"{f['rate']['pps']:.0f} pps, {f['rate']['bps']/1e6:.2f} Mbit/s" if f["rate"] else ""
        print(f"{f['key']:26}{f['packets']:>9}{f['bytes']:>11}{f['avg_size']:>7.0f}{f['share']:>7.1%}  {r}")
    print(f"\ntotal: {a['total_packets']} pkts, {a['total_bytes']} B | packet-ins: {a['packet_ins']} "
          f"| top talker: {a['top_talker']} | elephant flows: {a['elephants']}")
