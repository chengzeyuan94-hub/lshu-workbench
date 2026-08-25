#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(uname -s)" == 'Darwin' ]] || { echo 'Finance LaunchAgent only supports macOS.' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/backend/.env.local"
[[ -f "$ENV_FILE" ]] || { echo 'Run ./scripts/setup.sh first.' >&2; exit 1; }

for KEY in MONEYCATS_DB_PATH MONEYCATS_ALLOWED_ROOT; do
  if ! awk -F= -v key="$KEY" '$1 == key && length($2) > 0 { found=1 } END { exit !found }' "$ENV_FILE"; then
    echo "Configure $KEY in backend/.env.local first (value will not be printed)." >&2
    exit 1
  fi
done

NPM_BIN="$(command -v npm || true)"
[[ -n "$NPM_BIN" ]] || { echo 'npm not found.' >&2; exit 1; }
LABEL='io.localcreator.workbench.finance'
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/LocalCreatorWorkbench"
mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
chmod 700 "$LOG_DIR"

xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
RUNNER="$(xml_escape "$ROOT/backend/scripts/run-moneycats-sync.sh")"
NPM_ESC="$(xml_escape "$NPM_BIN")"
PATH_ESC="$(xml_escape "$(dirname "$NPM_BIN"):/usr/bin:/bin:/usr/sbin:/sbin")"
OUT_ESC="$(xml_escape "$LOG_DIR/finance.stdout.log")"
ERR_ESC="$(xml_escape "$LOG_DIR/finance.stderr.log")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$RUNNER</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>NPM_BIN</key><string>$NPM_ESC</string>
    <key>PATH</key><string>$PATH_ESC</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$OUT_ESC</string>
  <key>StandardErrorPath</key><string>$ERR_ESC</string>
</dict></plist>
EOF
chmod 600 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo 'Installed local MoneyCats sync at 10:00 daily. No AI is involved.'
