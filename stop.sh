#!/usr/bin/env bash
# stop.sh — Stop all DockerRescueKit local dev processes (Linux / macOS / WSL)
set -euo pipefail

kill_port() {
    local port="$1"
    local pids
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

echo "Stopping RescueKit..."
echo "  Clearing port 42880 (backend)..."
kill_port 42880
pkill -f 'dist/backend/src/index.js' 2>/dev/null || true

echo "  Clearing port 5173 (Vite)..."
kill_port 5173
pkill -f 'vite.*--port 5173' 2>/dev/null || true

echo ""
echo "RescueKit stopped."
