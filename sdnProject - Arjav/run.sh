#!/usr/bin/env bash
# Start the SDN demo: server, traffic, and open the UI.
cd "$(dirname "$0")" || exit 1
PORT=8000
URL="http://localhost:$PORT"

if ! command -v python3 >/dev/null; then echo "python3 is required"; exit 1; fi

if curl -sf "$URL/api/state" >/dev/null; then echo "Port $PORT already in use (another demo running?)"; exit 1; fi

python3 app.py &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM

for _ in $(seq 20); do
  curl -sf "$URL/api/state" >/dev/null && break
  sleep 0.3
done || true

if ! curl -sf "$URL/api/state" >/dev/null; then echo "server failed to start (port $PORT busy?)"; exit 1; fi

curl -s -XPOST "$URL/api/start" >/dev/null
# monitor a few flows by default
curl -s -XPOST "$URL/api/monitor" -d '{"flows":["h1>srv:tcp/80","h2>h4:udp/5004","h3>srv:udp/53"]}' >/dev/null

echo "Traffic running. UI: $URL  (Ctrl+C to stop)"
(xdg-open "$URL" || open "$URL") >/dev/null 2>&1 || true
wait $SERVER
