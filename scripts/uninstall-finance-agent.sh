#!/usr/bin/env bash
set -euo pipefail
LABEL='io.localcreator.workbench.finance'
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo 'Removed the local MoneyCats LaunchAgent. Existing finance summaries were not deleted.'
