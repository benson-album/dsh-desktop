#!/usr/bin/env bash
# 端到端冒烟测试：把数据目录全部重定向到 .smoke/ 下，不触碰真实 ~/.dsh。
# 用法：scripts/smoke.sh [--packaged] [--harness <dir>]
set -euo pipefail
cd "$(dirname "$0")/.."

HARNESS="${DSH_APP_HARNESS:-/Users/chinasir/Documents/GitHub/deepseek-harness}"
APP_BIN="./node_modules/.bin/electron"
EXTRA_ARGS=()

if [[ "${1:-}" == "--packaged" ]]; then
  APP_BIN="release/mac/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
  shift
fi
if [[ "${1:-}" == "--harness" ]]; then
  HARNESS="$2"
  shift 2
fi

# 受限环境（CI/沙箱）需要：no-sandbox + 用户数据目录重定向
EXTRA_ARGS+=(--no-sandbox --user-data-dir="$PWD/.smoke/user-data")

mkdir -p .smoke/app
cat > .smoke/app/settings.json <<EOF
{
  "harnessDir": "$HARNESS",
  "channel": "tag",
  "tagPrefix": "dsh-v",
  "autoCheck": false,
  "backendPort": 0
}
EOF

echo "== smoke: harness=$HARNESS app=$APP_BIN"
DSH_APP_HOME="$PWD/.smoke/app" \
DSH_HOME="$PWD/.smoke/dsh-home" \
DSH_AGENTS_HOME="$PWD/.smoke/agents" \
  "$APP_BIN" . --smoke "${EXTRA_ARGS[@]}"
