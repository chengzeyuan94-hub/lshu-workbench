#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d backend/node_modules || ! -d frontend/node_modules || ! -f frontend/dist/index.html ]]; then
  bash scripts/setup.sh
fi

PORT_VALUE="$(awk -F= '/^PORT=[0-9]+$/ { print $2; exit }' backend/.env.local 2>/dev/null || true)"
PORT_VALUE="${PORT_VALUE:-3456}"
HEALTH="http://127.0.0.1:${PORT_VALUE}/api/health"
HOME_URL="http://127.0.0.1:${PORT_VALUE}/"

if curl -fsS --noproxy '*' --max-time 2 "$HEALTH" >/dev/null 2>&1; then
  printf '工作台已在运行：%s\n' "$HOME_URL"
  if [[ "${OPEN_BROWSER:-1}" == '1' && "$(uname -s)" == 'Darwin' ]]; then
    open "$HOME_URL" || true
  fi
  exit 0
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT_VALUE" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'ERROR: 端口 %s 已被其他程序占用。\n' "$PORT_VALUE" >&2
  exit 1
fi

mkdir -p .runtime
chmod 700 .runtime
FINGERPRINT="v$(tr -d '[:space:]' < VERSION)"

cleanup() {
  rm -f .runtime/backend.pid
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

(cd backend && exec env WORKBENCH_SOURCE_FINGERPRINT="$FINGERPRINT" node --import tsx src/index.ts) &
BACKEND_PID=$!
printf '%s\n' "$BACKEND_PID" > .runtime/backend.pid
chmod 600 .runtime/backend.pid

for _ in $(seq 1 40); do
  if curl -fsS --noproxy '*' --max-time 2 "$HEALTH" >/dev/null 2>&1; then
    printf 'L叔工作台 v%s 已启动：%s\n' "$(cat VERSION)" "$HOME_URL"
    if [[ "${OPEN_BROWSER:-1}" == '1' && "$(uname -s)" == 'Darwin' ]]; then
      open "$HOME_URL" || true
    fi
    wait "$BACKEND_PID"
    exit $?
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    wait "$BACKEND_PID" || true
    printf 'ERROR: 后端提前退出。请运行 ./scripts/doctor.sh。\n' >&2
    exit 1
  fi
  sleep 0.5
done

printf 'ERROR: 40 次探测后仍未通过健康检查：%s\n' "$HEALTH" >&2
exit 1
