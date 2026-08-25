#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '%s\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail '未找到 Node.js。请先安装 Node 24。'
command -v npm >/dev/null 2>&1 || fail '未找到 npm。请先安装 Node 24。'
NODE_MAJOR="$(node -p 'process.versions.node.split(`.`)[0]')"
[[ "$NODE_MAJOR" == '24' ]] || fail "当前 Node 为 $(node -v)，v0.1 需要 Node 24。"

if [[ ! -f backend/.env.local ]]; then
  cp backend/.env.example backend/.env.local
  chmod 600 backend/.env.local
  say '已创建 backend/.env.local（安全默认：演示模式、定时器关闭、连接器关闭）。'
else
  chmod 600 backend/.env.local
  say '保留现有 backend/.env.local。'
fi

mkdir -p backend/data .runtime
chmod 700 backend/data .runtime

say '安装后端依赖…'
(cd backend && npm ci)
say '安装前端依赖…'
(cd frontend && npm ci)

say '构建前端与校验后端 TypeScript…'
(cd frontend && npm run build)
(cd backend && npm run build)

if [[ "$(uname -s)" == 'Darwin' ]] && command -v swiftc >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1; then
  if bash backend/scripts/build-calendar-reader.sh; then
    say 'Apple Calendar helper 已构建。首次连接时仍需在系统设置授予日历权限。'
  else
    say 'WARNING: Calendar helper 构建失败；核心工作台仍可运行，Apple Calendar 将显示未连接。'
  fi
else
  say 'WARNING: 未发现 macOS Swift 工具链；跳过 Apple Calendar helper。'
fi

if [[ "${RUN_TESTS:-0}" == '1' ]]; then
  say '运行完整测试…'
  (cd backend && npm test)
  (cd frontend && npm test)
fi

say ''
say '安装完成。运行 ./Start.command 或 ./scripts/start.sh。'
