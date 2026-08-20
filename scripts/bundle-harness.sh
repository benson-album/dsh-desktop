#!/usr/bin/env bash
# 把构建好的 harness checkout（源码 + node_modules + .git + 构建产物）打包为内置 bundle。
# 产物为单个 tar.gz 归档（build/harness-bundle.tar.gz）：
#   - 单文件可避开 electron-builder 对 extraResources 中 node_modules 目录的排除
#   - tar 保留 pnpm 的符号链接与权限
# 用法：bash scripts/bundle-harness.sh [参考checkout路径]
# 参考 checkout 必须是**完整 git 仓库**（含 .git）——内置版的 .git 是后续
# 自动更新的基础，缺失会导致首次运行后无法检测/构建新版本（not-a-repo）。
# 默认取 workspace 内的隔离构建克隆（.bootstrap-test/harness，git 仓库）；
# 可用环境变量 DSH_BUNDLE_REF 或第一个参数覆盖。
set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_REF="$(pwd)/.bootstrap-test/harness"
REF="${DSH_BUNDLE_REF:-${1:-$DEFAULT_REF}}"
STAGE="build/harness-bundle"
OUT="build/harness-bundle.tar.gz"

if [[ ! -d "$REF/apps/cli/lib" || ! -d "$REF/node_modules" ]]; then
  echo "参考 checkout 缺少构建产物或依赖: $REF（请先 pnpm build）" >&2
  exit 1
fi
if [[ ! -d "$REF/.git" ]]; then
  echo "参考 checkout 不是 git 仓库（缺少 .git）: $REF" >&2
  echo "内置版必须携带 .git，否则自动更新不可用。请改用 git 克隆，例如：" >&2
  echo "  DSH_BUNDLE_REF=~/path/to/git-clone bash scripts/bundle-harness.sh" >&2
  exit 1
fi
echo "== 参考 checkout: $REF (HEAD=$(git -C "$REF" rev-parse --short HEAD 2>/dev/null || echo '?'), .git 将一并内置)"

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"
echo "== bundling harness from $REF"
rsync -a \
  --exclude '**/*.tsbuildinfo' \
  --exclude '**/*.tsbuildinfo.*' \
  --exclude 'node_modules/.cache' \
  --exclude '.bootstrap-test' \
  --exclude '.smoke' \
  --exclude 'release' \
  "$REF"/ "$STAGE/"

echo "== archiving (tar.gz, keeps symlinks)"
tar -czf "$OUT" -C "$STAGE" .
rm -rf "$STAGE"
echo "== bundle ready: $(du -sh "$OUT" | cut -f1)"
