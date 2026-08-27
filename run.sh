#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting API server (server/http.js) on :8787..."
npm run server &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

echo "Starting Vite dev server..."
npm run dev
