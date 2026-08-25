#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.runtime/backend.pid"
if [[ ! -f "$PID_FILE" ]]; then
  printf '没有由本项目记录的运行进程。\n'
  exit 0
fi

PID="$(tr -cd '0-9' < "$PID_FILE")"
if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
  COMMAND="$(ps -p "$PID" -o command= 2>/dev/null || true)"
  if [[ "$COMMAND" == *'tsx src/index.ts'* ]]; then
    kill "$PID"
    printf '已停止工作台进程 %s。\n' "$PID"
  else
    printf '拒绝停止：PID %s 已不是工作台进程。\n' "$PID" >&2
    exit 1
  fi
fi
rm -f "$PID_FILE"
