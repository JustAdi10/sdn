# SDN Project - Aditya

## 1. Aim

Create and operate a software-defined network containing two switches, four hosts, one server, and one SDN controller. The controller monitors selected network flows by collecting packet and byte counters, while generated traffic is used to evaluate the network and analyse the collected statistics.

This project was implemented on a cloud Ubuntu server accessed over SSH. It did **not** use Cisco Packet Tracer. The network was created with Mininet, the switches used OpenFlow, and the controller application was written with the Ryu SDN framework.

## 2. System architecture

```text
                         Ryu SDN controller
                              OpenFlow
                           /            \
                          /              \
       h1 -----------    s1  =========  s2    ----------- h3
       h2 -----------     |   trunk link   |  ----------- h4
       server -----------/                 \
```

- **s1 and s2**: Open vSwitch switches managed by the Ryu controller.
- **h1-h4**: Mininet hosts used to generate and receive traffic.
- **server**: A Mininet host representing the application/server endpoint.
- **Controller**: Ryu, connected to the switches through OpenFlow.
- **Cloud environment**: Ubuntu server reached through SSH; Mininet and Open vSwitch ran remotely.

The project directory contains the FLOWSCOPE web console, which visualises the same logical model: two switches, four hosts, one server, one controller, flow entries, traffic generation, and packet/byte statistics.

## 3. Topology and flow model

| Device | Mininet name | Role |
|---|---|---|
| Host 1 | `h1` | Client connected to `s1` |
| Host 2 | `h2` | Client connected to `s1` |
| Server | `srv` | Server endpoint connected to `s1` |
| Switch 1 | `s1` | Access switch and left side of the trunk |
| Switch 2 | `s2` | Access switch and right side of the trunk |
| Host 3 | `h3` | Client connected to `s2` |
| Host 4 | `h4` | Client connected to `s2` |

The monitored flows use OpenFlow-style match fields such as source, destination, protocol, and destination port. Example flows include:

- `h1 -> srv`, TCP port 80: web traffic
- `h2 -> srv`, TCP port 443: TLS traffic
- `h3 -> srv`, UDP port 53: DNS traffic
- `h1 -> h4`, UDP port 5004: video traffic
- `h2 -> h3`, TCP port 22: SSH traffic
- `h4 -> srv`, TCP port 873: bulk transfer traffic

## 4. Cloud-server setup

After connecting to the Ubuntu cloud server over SSH, install the required packages:

```bash
sudo apt update
sudo apt install -y mininet openvswitch-switch python3-pip git curl
pip3 install ryu
```

Verify the tools:

```bash
mn --version
ovs-vsctl --version
ryu-manager --version
```

Mininet creates the hosts, links, and Open vSwitch instances. Ryu is started as a separate process and accepts OpenFlow switch connections, normally on TCP port `6653`.

## 5. Ryu controller responsibilities

The Ryu application performs four main tasks:

1. Accepts OpenFlow connections from `s1` and `s2`.
2. Installs forwarding rules when a flow is first observed, using `PacketIn` events and a shortest-path decision.
3. Requests flow statistics periodically with OpenFlow flow-statistics messages.
4. Records packet counts, byte counts, packet rates, and byte rates for selected flows.

A flow entry is identified by its match, for example:

```text
source host -> destination host : protocol / destination port
```

The controller uses the counters returned by the switches to calculate rates between polling intervals:

```text
packet rate = (new packets - previous packets) / elapsed time
byte rate   = (new bytes - previous bytes) * 8 / elapsed time
```

Only selected flow keys are placed in the monitoring set. This keeps the analysis focused while still allowing the controller to install and account for other forwarding flows.

## 6. Running the experiment

Start the Ryu controller on the cloud server:

```bash
ryu-manager --verbose flow_monitor.py
```

Start the Mininet topology in a second SSH session. The exact topology script may be named differently in the deployment, but it should create `h1`, `h2`, `h3`, `h4`, `srv`, `s1`, and `s2`, and connect the switches to the Ryu controller:

```bash
sudo mn -c
sudo python3 topology.py
```

From the Mininet CLI, inspect the topology and generate traffic:

```text
mininet> nodes
mininet> net
mininet> h1 ping -c 5 srv
mininet> h2 ping -c 5 h3
mininet> h1 iperf -s &
mininet> h2 iperf -c h1 -t 20
```

The traffic generator can also create repeated TCP and UDP flows at configurable packet rates. The controller polls the switches while traffic is running, so the resulting counters can be compared across flows and switches.

To inspect the OpenFlow tables directly:

```bash
sudo ovs-ofctl -O OpenFlow13 dump-flows s1
sudo ovs-ofctl -O OpenFlow13 dump-flows s2
```

Use the OpenFlow version configured by the topology and controller if it differs from `OpenFlow13`.

## 7. FLOWSCOPE project console

The files in this directory provide a browser-based console for demonstrating the monitoring workflow:

- `server.js`: starts the local HTTP API on `127.0.0.1:8100`.
- `sim.js`: models the two-switch network, flow tables, packet-in events, statistics polling, and analysis.
- `public/index.html`: displays the topology, flow table, traffic generator, counters, rates, trends, and analysis messages.
- `run.sh`: starts the console, begins traffic generation, selects monitored flows, and opens the browser when supported.

Run the console from this directory:

```bash
./run.sh
```

Then open `http://localhost:8100`. The console starts with representative web, TLS, DNS, video, SSH, and bulk-transfer flows. Use the **Run**, **Halt**, and **Reset** controls to manage the experiment, adjust packets per second, and select flows for monitoring.

The console is a visual and executable representation of the SDN monitoring concepts used in the cloud experiment. The live cloud deployment used Mininet, Open vSwitch, Ryu, and OpenFlow; the console provides a lightweight way to inspect the same topology and statistics workflow without requiring the cloud network to be running.

## 8. Results and analysis

The experiment demonstrates that an SDN controller can observe traffic centrally without placing monitoring logic on every host. The collected flow statistics show:

- packet and byte totals for each installed flow;
- packet and bit rates calculated from successive statistics replies;
- the path taken through `s1` and `s2`;
- traffic crossing the `s1-s2` trunk;
- differences between packet-heavy and byte-heavy flows;
- changes in monitored traffic, including bursts relative to a recent average.

The per-switch counters also provide a consistency check. A flow crossing the trunk should have corresponding counters on both switches, subject to the direction and point at which the flow is measured. This makes the controller useful not only for forwarding decisions but also for traffic visibility and basic network analysis.

## 9. Conclusion

The project implemented an SDN network on a cloud Ubuntu server accessed through SSH. Mininet supplied the virtual hosts and topology, Open vSwitch provided OpenFlow-capable switches, and Ryu acted as the controller. Traffic was generated between hosts and the server, while the controller collected packet and byte statistics for selected flows. The FLOWSCOPE console in this directory presents the topology, flow counters, traffic controls, and analysis in a compact browser interface.
