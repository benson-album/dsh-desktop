#!/usr/bin/env bash
# dsh-desktop 壳包发布脚本（macOS 本地打 x64 + arm64 双架构壳）。
# 壳包与内容包隔离发布（技术文档 dsh-shell-release-v0.3.0）：
#   - 壳 tag：dsh-desktop-v<version>
#   - 壳资产：dsh-desktop-<os>-<arch>-<version>.zip（用户视角命名；os 用 mac/win/linux）
#   - 不生成/不上传 latest.json（内容升级清单不受影响）
#
# Windows / Linux 壳包由 CI（.github/workflows/build-shell.yml）在对应
# runner 上构建——macOS 主机无法可靠交叉打包。
#
# 用法：
#   bash scripts/publish-shell.sh <version> [--repo owner/repo] [--dry-run]
#   GH_TOKEN=<token>   # 非 dry-run 时需要（gh CLI）
#
# 示例：
#   bash scripts/publish-shell.sh 0.3.0 --repo benson-album/dsh-desktop --dry-run
#   bash scripts/publish-shell.sh 0.3.0
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法: publish-shell.sh <version> [--repo owner/repo] [--dry-run]}"
REPO="benson-album/dsh-desktop"
DRY_RUN=false
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?--repo 需要 owner/repo}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done
TAG="dsh-desktop-v${VERSION}"
OUT_DIR="build/shell-artifacts"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# 前置：内置 bundle（首次解包必需）——缺失时提示
BUNDLE="build/harness-bundle.tar.gz"
if [[ ! -f "$BUNDLE" ]]; then
  echo "警告: 缺少 $BUNDLE（首次解包内容）。建议先执行 bash scripts/bundle-harness.sh" >&2
fi

echo "== 壳编译（tsc）"
pnpm build >/dev/null

# macOS 双架构：x64 与 arm64 分别打
# 注意：electronDist 指向本机 x64 Electron，arm64 包当前为 Rosetta 兼容包
# （可运行但非原生；原生 arm64 由后续 CI macos-14 矩阵补上）。
ARCHES=(x64 arm64)
for ARCH in "${ARCHES[@]}"; do
  echo "== 打包 darwin-$ARCH 壳"
  # artifactName 区分架构（默认 <productName>-<version>-mac.zip 无架构后缀会互相覆盖）
  electron_config_cache="$PWD/.electron-cache" \
  ELECTRON_BUILDER_CACHE="$PWD/.builder-cache" \
    ./node_modules/.bin/electron-builder --mac zip --"$ARCH" \
      -c.artifactName="DeepSeek-Harness-${VERSION}-${ARCH}.zip"
  RET=$?
  if [[ $RET -ne 0 ]]; then echo "electron-builder --mac --$ARCH 失败（exit $RET）" >&2; exit 1; fi

  SRC="release/DeepSeek-Harness-${VERSION}-${ARCH}.zip"
  if [[ ! -f "$SRC" ]]; then
    echo "未找到 darwin-$ARCH 壳产物: $SRC" >&2
    exit 1
  fi
  ASSET="dsh-desktop-mac-${ARCH}-${VERSION}.zip"
  cp "$SRC" "$OUT_DIR/$ASSET"
  echo "== 产物: $OUT_DIR/$ASSET ($(du -h "$OUT_DIR/$ASSET" | cut -f1))"
done

if [[ "$DRY_RUN" == true ]]; then
  echo "== dry-run 完成（未上传）。产物："
  ls -lh "$OUT_DIR"
  exit 0
fi

# 上传（仅资产，无清单）
command -v gh >/dev/null 2>&1 || { echo "需要 gh CLI" >&2; exit 1; }
: "${GH_TOKEN:?非 dry-run 需要设置 GH_TOKEN}"

echo "== 创建/更新 Release $TAG @ $REPO"
gh release create "$TAG" "$OUT_DIR"/*.zip \
  --repo "$REPO" \
  --title "$TAG" \
  --notes "dsh-desktop 壳包（macOS x64 + arm64）。Windows/Linux 壳见 CI 构建。\n安装：解压拖入 Applications（未签名需右键打开）。" \
  || { gh release upload "$TAG" "$OUT_DIR"/*.zip --repo "$REPO" --clobber; }

echo "== 壳发布完成: https://github.com/${REPO}/releases/tag/${TAG}"
