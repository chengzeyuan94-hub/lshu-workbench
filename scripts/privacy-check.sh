#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAILED=0

report() {
  printf 'PRIVACY CHECK FAILED: %s\n' "$1" >&2
  FAILED=1
}

FORBIDDEN_FILES="$(find . -path './.git' -prune -o -type f \( -name '.env.local' -o -name '*.db' -o -name '*.db-*' -o -name '*.sqlite' -o -name '*.wal' -o -name '*.shm' -o -name '*.bak' -o -name '*.log' -o -name '.DS_Store' -o -name '*.tsbuildinfo' \) -print)"
[[ -z "$FORBIDDEN_FILES" ]] || report '发现运行时、数据库、日志或系统文件'

FORBIDDEN_DIRS="$(find . -path './.git' -prune -o -type d \( -name node_modules -o -name dist -o -name logs -o -name backups \) -print)"
[[ -z "$FORBIDDEN_DIRS" ]] || report '发现依赖、构建、日志或备份目录'

SECRET_PATTERN='/Users/carlos|658af970000000002001d6c2|sk-[A-Za-z0-9_-]{12,}|DEEPSEEK_API_KEY=[^[:space:]]+|CIMIDATA_APP_SECRET=[^[:space:]]+'
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git grep -nE "$SECRET_PATTERN" -- . \
    ':(exclude)scripts/privacy-check.sh' ':(exclude)backend/.env.example' >/dev/null \
    && report '发现个人路径、真实账号或疑似凭证' || true
elif command -v rg >/dev/null 2>&1; then
  rg -n -uu "$SECRET_PATTERN" . \
    --glob '!scripts/privacy-check.sh' --glob '!backend/.env.example' >/dev/null \
    && report '发现个人路径、真实账号或疑似凭证' || true
else
  grep -R --exclude-dir=.git -E '/Users/carlos|658af970000000002001d6c2|sk-[A-Za-z0-9_-]{12,}' . >/dev/null 2>&1 && report '发现个人路径、真实账号或疑似凭证' || true
fi

if [[ "$FAILED" == '0' ]]; then
  printf 'Privacy check passed: no private runtime data or obvious credentials found.\n'
fi
exit "$FAILED"
