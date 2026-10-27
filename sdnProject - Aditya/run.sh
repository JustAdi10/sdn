#!/usr/bin/env bash
# Start FLOWSCOPE: launches the server, starts traffic, opens the UI.
cd "$(dirname "$0")" || exit 1
URL="http://localhost:8100"

command -v node >/dev/null || { echo "node is required"; exit 1; }
curl -sf "$URL/api/state" >/dev/null && { echo "Port 8100 already in use (already running?)"; exit 1; }

node server.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM

for _ in $(seq 20); do curl -sf "$URL/api/state" >/dev/null && break; sleep 0.3; done
curl -sf "$URL/api/state" >/dev/null || { echo "server failed to start"; exit 1; }

curl -s -XPOST "$URL/api/start" >/dev/null
curl -s -XPOST "$URL/api/monitor" -d '{"flows":["h1>srv:tcp/80","h1>h4:udp/5004","h3>srv:udp/53"]}' >/dev/null

echo "Running. UI: $URL  (Ctrl+C to stop)"
(xdg-open "$URL" || open "$URL") >/dev/null 2>&1 || true
wait $SERVER
