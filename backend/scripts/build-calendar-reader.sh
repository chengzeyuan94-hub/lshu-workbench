#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/calendar-reader.swift"
PLIST="$ROOT/native/calendar-reader.Info.plist"
ENT="$ROOT/native/calendar-reader.entitlements"
OUT_DIR="$ROOT/native/bin"
OUT="$OUT_DIR/calendar-reader"
IDENTITY="com.lshu.workbench.calendar-reader"
mkdir -p "$OUT_DIR"
swiftc -O \
  -module-name CalendarReader \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
  -o "$OUT" \
  "$SRC"
chmod 700 "$OUT"
codesign --force --sign - --identifier "$IDENTITY" --entitlements "$ENT" "$OUT" >/dev/null
echo "built $OUT identity=$IDENTITY"
