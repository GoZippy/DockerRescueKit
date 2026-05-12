#!/usr/bin/env bash
# start.sh — Start DockerRescueKit locally for development (Linux / macOS / WSL)
# Backend:  http://localhost:42880
# Frontend: http://localhost:5173  (Vite dev server, proxies /api → backend)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$ROOT/.local-data"
BACKEND_LOG="$DATA/backend.log"
VITE_LOG="$DATA/vite.log"

# ── Ensure data directory ─────────────────────────────────────────────────────
mkdir -p "$DATA"

# ── Helpers ───────────────────────────────────────────────────────────────────
kill_port() {
    local port="$1"
    local pids
    # lsof works on macOS; fuser on Linux; ss on newer Linux without lsof
    if command -v lsof &>/dev/null; then
        pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    elif command -v fuser &>/dev/null; then
        pids=$(fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' || true)
    else
        pids=$(ss -tlnp 2>/dev/null | awk -v p=":$port " '$4 ~ p {match($6,/pid=([0-9]+)/,a); print a[1]}' || true)
    fi
    for pid in $pids; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null && echo "  Killed PID $pid (was on :$port)"
    done
}

open_browser() {
    local url="$1"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open "$url"
    elif command -v xdg-open &>/dev/null; then
        xdg-open "$url" &>/dev/null &
    elif command -v wslview &>/dev/null; then
        # WSL with wslu package
        wslview "$url"
    else
        echo "  (Cannot auto-open browser — visit $url manually)"
    fi
}

# ── Kill existing processes ───────────────────────────────────────────────────
echo "[1/5] Clearing ports 42880 and 5173..."
kill_port 42880
kill_port 5173

# Also kill any node process running the backend entry point
pkill -f 'dist/backend/src/index.js' 2>/dev/null || true

# ── Build backend ─────────────────────────────────────────────────────────────
echo "[2/5] Building backend..."
(cd "$ROOT/packages/backend" && npm run build --silent)
echo "  Build complete."

# ── Start backend in background ───────────────────────────────────────────────
echo "[3/5] Starting backend (log: $BACKEND_LOG)..."
(
    export DRK_DATA_DIR="$DATA"
    export PORT=42880
    export NODE_ENV=development
    cd "$ROOT/packages/backend"
    nohup node dist/backend/src/index.js >> "$BACKEND_LOG" 2>&1
) &
BACKEND_PID=$!
echo "  Backend PID: $BACKEND_PID"
echo "[wait] 2 s for backend to bind..."
sleep 2

# ── Start Vite dev server in background ───────────────────────────────────────
echo "[4/5] Starting Vite dev server (log: $VITE_LOG)..."
(
    cd "$ROOT/packages/extension"
    nohup npx vite --port 5173 >> "$VITE_LOG" 2>&1
) &
VITE_PID=$!
echo "  Vite PID: $VITE_PID"
echo "[wait] 2 s for Vite to compile..."
sleep 2

# ── Open browser ─────────────────────────────────────────────────────────────
echo "[5/5] Opening browser..."
open_browser "http://localhost:5173"

echo ""
echo "RescueKit started."
echo "  Backend : http://localhost:42880"
echo "  UI      : http://localhost:5173"
echo ""
echo "Logs:"
echo "  Backend : $BACKEND_LOG"
echo "  Vite    : $VITE_LOG"
echo ""
echo "Run ./stop.sh (or Ctrl-C parent shell + pkill -f dist/backend) to stop."
