#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"

if [[ -z "$NPM_BIN" ]]; then
  print -u2 'npm not found; install Node.js 24 first'
  exit 127
fi

cd "$BACKEND_DIR"
exec "$NPM_BIN" run finance:sync -- --trigger launchd
