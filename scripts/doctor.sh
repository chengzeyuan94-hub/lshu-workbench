#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAILED=0

line() { printf '%-28s %s\n' "$1" "$2"; }
required() { line "$1" "$2"; [[ "$2" == OK* ]] || FAILED=1; }
has() { command -v "$1" >/dev/null 2>&1; }

if has node; then
  NODE_VERSION="$(node -v)"
  [[ "$NODE_VERSION" == v24.* ]] && required 'Node 24' "OK ($NODE_VERSION)" || required 'Node 24' "MISSING ($NODE_VERSION)"
else
  required 'Node 24' 'MISSING'
fi
has npm && required 'npm' "OK ($(npm -v))" || required 'npm' 'MISSING'
[[ -f backend/.env.local ]] && required '本地配置' 'OK (存在，内容不回显)' || required '本地配置' 'MISSING (运行 setup)'
[[ -d backend/node_modules && -d frontend/node_modules ]] && required '依赖' 'OK' || required '依赖' 'MISSING (运行 setup)'
[[ -f frontend/dist/index.html ]] && required '前端构建' 'OK' || required '前端构建' 'MISSING (运行 setup)'

line 'Apple Calendar helper' "$([[ -x backend/native/bin/calendar-reader ]] && echo 'OPTIONAL OK' || echo 'OPTIONAL unavailable')"
line 'Things 3' "$([[ -d /Applications/Things3.app ]] && echo 'OPTIONAL OK' || echo 'OPTIONAL unavailable')"
line 'OpenCLI' "$(has opencli && echo 'OPTIONAL OK' || echo 'OPTIONAL unavailable')"
line '飞书 CLI' "$(has lark-cli && echo 'OPTIONAL OK' || echo 'OPTIONAL unavailable')"
line 'pdftotext' "$(has pdftotext && echo 'OPTIONAL OK' || echo 'OPTIONAL unavailable')"

configured() {
  local key="$1"
  if [[ -f backend/.env.local ]] && awk -F= -v key="$key" '$1 == key && length($2) > 0 { found=1 } END { exit !found }' backend/.env.local; then
    echo 'configured (value hidden)'
  else
    echo 'not configured'
  fi
}
line 'DeepSeek' "OPTIONAL $(configured DEEPSEEK_API_KEY)"
line '次幂数据' "OPTIONAL $(configured CIMIDATA_APP_SECRET)"
line 'MoneyCats' "OPTIONAL $(configured MONEYCATS_DB_PATH)"

PORT_VALUE="$(awk -F= '/^PORT=[0-9]+$/ { print $2; exit }' backend/.env.local 2>/dev/null || true)"
PORT_VALUE="${PORT_VALUE:-3456}"
if curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:${PORT_VALUE}/api/health" >/dev/null 2>&1; then
  line '运行状态' "OK (127.0.0.1:${PORT_VALUE})"
else
  line '运行状态' 'stopped'
fi

exit "$FAILED"
