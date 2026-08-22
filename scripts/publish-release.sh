#!/usr/bin/env bash
# dsh-desktop 发布脚本：把构建好的 harness checkout 打包为「内容 tar.gz」产物
# （顶层为内容本身：apps/ package.json node_modules version.json …），生成
# latest.json 更新清单（schemaVersion 协议，见技术文档 §4/§13），并上传到
# GitHub Releases（资产先、清单后，避免不一致窗口）。
#
# 产物用 tar.gz 而非 zip：node_modules 海量小文件 + pnpm 符号链接下，tar 比
# zip 快一个数量级，且 darwin/win32/linux 的系统 tar 均原生支持解压（设备端
# 不依赖 unzip）。
#
# 用法：
#   bash scripts/publish-release.sh <version> [--repo owner/repo] [--dry-run]
#   DSH_RELEASE_REF=<构建好的 checkout 路径>   # 默认 .bootstrap-test/harness
#   GH_TOKEN=<token>                           # 非 dry-run 时需要（gh CLI）
#
# 示例：
#   bash scripts/publish-release.sh 0.2.0 --repo benson-album/dsh-desktop
#   bash scripts/publish-release.sh 0.2.0 --dry-run
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法: publish-release.sh <version> [--repo owner/repo] [--dry-run]}"
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
TAG="dsh-v${VERSION}"

REF="${DSH_RELEASE_REF:-$(pwd)/.bootstrap-test/harness}"
if [[ ! -d "$REF/apps/cli/lib" || ! -d "$REF/node_modules" ]]; then
  echo "参考 checkout 缺少构建产物或依赖: $REF（请先 pnpm build）" >&2
  exit 1
fi

# 平台/架构（协议 §13：os=process.platform, arch=process.arch）
OS="$(node -e 'process.stdout.write(process.platform)')"
ARCH="$(node -e 'process.stdout.write(process.arch)')"
ASSET="DeepSeek-Harness-${VERSION}-${OS}-${ARCH}.tar.gz"
OUT_DIR="build/release-artifacts"
STAGE="build/release-stage"
rm -rf "$STAGE" "$OUT_DIR"
mkdir -p "$STAGE" "$OUT_DIR"
echo "== 打包 $TAG ($OS-$ARCH) 来自 $REF"

# 1. 参考 checkout 复制到 stage（tar 管道：node_modules 海量小文件下比 rsync 快一个数量级）
tar -C "$REF" \
  --exclude='**/*.tsbuildinfo' \
  --exclude='**/*.tsbuildinfo.*' \
  --exclude='node_modules/.cache' \
  --exclude='.bootstrap-test' \
  --exclude='.smoke' \
  --exclude='.smoke-firstrun' \
  --exclude='.e2e' \
  --exclude='release' \
  -cf - . | tar -xf - -C "$STAGE"

# 2. 写入 version.json（设备端 release 通道版本判定依据，见技术文档 §5）
COMMIT="$(git -C "$REF" rev-parse HEAD 2>/dev/null || true)"
node -e "
const fs = require('node:fs')
fs.writeFileSync(process.argv[1] + '/version.json',
  JSON.stringify({ version: process.argv[2], commit: process.argv[3] || '' }, null, 2) + '\n')
" "$STAGE" "$VERSION" "$COMMIT"

# 3. 打包内容 tar.gz（顶层为内容本身，与内置 bundle 语义一致；-z 保留符号链接）
ROOT="$(pwd)"
# gzip -1 最快压缩：Windows runner 上默认压缩级别压缩海量小文件极慢（实测 1h+ 卡死）。
# 用管道（tar -cf - | gzip）：bsdtar/gnu tar + gzip 三平台一致（-I 在 bsdtar 是 gzip 别名，不可用）
GZIP_LEVEL="${DSH_RELEASE_GZIP_LEVEL:-1}"
(cd "$STAGE" && tar -cf - . | gzip -${GZIP_LEVEL} > "${ROOT}/${ASSET}")
rm -rf "$STAGE"
# Windows (git bash) 有 sha256sum 无 shasum；macOS/Linux 反之——双保险
SHA="$( (shasum -a 256 "${ROOT}/${ASSET}" || sha256sum "${ROOT}/${ASSET}") | cut -d' ' -f1)"
SIZE="$(stat -f%z "${ROOT}/${ASSET}" 2>/dev/null || stat -c%s "${ROOT}/${ASSET}")"
mv "${ROOT}/${ASSET}" "$OUT_DIR/"
echo "== 产物: $OUT_DIR/$ASSET ($(du -h "$OUT_DIR/$ASSET" | cut -f1), sha256=$SHA)"

# 4. 生成 latest.json（URL 指向 GitHub Release 资产）
cat > "$OUT_DIR/latest.json" <<EOF
{
  "schemaVersion": 1,
  "version": "${VERSION}",
  "tag": "${TAG}",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "assets": [
    {
      "name": "${ASSET}",
      "url": "https://github.com/${REPO}/releases/download/${TAG}/${ASSET}",
      "sha256": "${SHA}",
      "size": ${SIZE},
      "os": "${OS}",
      "arch": "${ARCH}"
    }
  ]
}
EOF
echo "== 清单: $OUT_DIR/latest.json"

if [[ "$DRY_RUN" == true ]]; then
  echo "== dry-run 完成（未上传）。产物："
  ls -lh "$OUT_DIR"
  exit 0
fi

# 5. 上传：先资产、后清单（顺序保证，见技术文档 §3.1）
command -v gh >/dev/null 2>&1 || { echo "需要 gh CLI（或设置 GH_TOKEN 后使用）" >&2; exit 1; }
: "${GH_TOKEN:?非 dry-run 需要设置 GH_TOKEN（GitHub 个人访问令牌）}"

echo "== 创建/更新 Release $TAG @ $REPO"
gh release create "$TAG" "$OUT_DIR/$ASSET" \
  --repo "$REPO" \
  --title "$TAG" \
  --notes "dsh-desktop 自动发布产物（harness $VERSION）" \
  || gh release upload "$TAG" "$OUT_DIR/$ASSET" --repo "$REPO" --clobber

echo "== 上传清单 latest.json"
gh release upload "$TAG" "$OUT_DIR/latest.json" --repo "$REPO" --clobber

# 6. 同步 latest.json 到仓库 main 分支：设备端从 raw.githubusercontent 读清单，
#    不依赖 releases/latest（壳 release 会遮蔽内容 release 导致 404，见技术文档 §5）。
echo "== 同步 latest.json 到仓库 main"
BASE64="$(base64 < "$OUT_DIR/latest.json" | tr -d '\n')"
SHA="$(curl -s --connect-timeout 20 -H "Authorization: token $GH_TOKEN" \
  "https://api.github.com/repos/$REPO/contents/latest.json" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('sha',''))" 2>/dev/null || true)"
BODY="{\"message\":\"chore: sync latest.json ($VERSION)\",\"content\":\"$BASE64\""
[[ -n "$SHA" ]] && BODY="$BODY,\"sha\":\"$SHA\""
BODY="$BODY}"
curl -sS --connect-timeout 30 -X PUT -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/json" \
  -d "$BODY" "https://api.github.com/repos/$REPO/contents/latest.json" -o /dev/null -w "PUT HTTP %{http_code}\n"

echo "== 发布完成: https://github.com/${REPO}/releases/tag/${TAG}"
