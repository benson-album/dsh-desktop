#!/usr/bin/env bash
# 首次运行冒烟：模拟全新机器（空 DSH_APP_HOME），验证内置 bundle 解包 + 启动。
# 打包后运行：scripts/smoke-firstrun.sh
set -euo pipefail
cd "$(dirname "$0")/.."

APP_BIN="release/mac/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
if [[ ! -x "$APP_BIN" ]]; then
  echo "先打包：pnpm pack:dir（含内置 bundle）" >&2
  exit 1
fi

rm -rf .smoke-firstrun
mkdir -p .smoke-firstrun

echo "== 首次运行冒烟：空 APP_HOME，解包内置版（无 git、无网络）"
DSH_APP_HOME="$PWD/.smoke-firstrun/app" \
DSH_HOME="$PWD/.smoke-firstrun/dsh-home" \
DSH_AGENTS_HOME="$PWD/.smoke-firstrun/agents" \
  "$APP_BIN" --smoke --no-sandbox --user-data-dir="$PWD/.smoke-firstrun/user-data" 2>&1 | tail -6

echo "== 验证解包结果"
test -f "$PWD/.smoke-firstrun/app/harness/apps/cli/lib/bin.js" && echo "RUN_DIR_OK (bin)"
test -d "$PWD/.smoke-firstrun/app/harness/.git" && echo "RUN_DIR_OK (.git)"
test -f "$PWD/.smoke-firstrun/app/harness/apps/web/dist/index.html" && echo "RUN_DIR_OK (dist)"
test -d "$PWD/.smoke-firstrun/app/harness/node_modules" && echo "RUN_DIR_OK (node_modules)"
echo "== 数据隔离确认（未触碰真实 ~/.dsh 与开发 checkout）"
echo "done"
