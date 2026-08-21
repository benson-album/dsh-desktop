# 开发设计文档 — 壳包发布专项（Shell Release）

- 文档版本：v0.3.0（✅ 已确认）
- 日期：2026-08-21
- 状态：**已确认**（2026-08-21），按 §10 顺序实施
- 关联：[PRD-DSH-shell-release-v0.3.0.md](../prd/PRD-DSH-shell-release-v0.3.0.md)（🔄 同版本）
- 既有基线：内容升级体系 [dsh-release-download-upgrade-v0.2.0.md](./dsh-release-download-upgrade-v0.2.0.md)（已实施，本专项**不改变**其内容包逻辑）
- 技术基线：Electron 43.4.0 / electron-builder 26.15.3 / GitHub Releases

---

## 1. 设计原则

1. **壳包与内容包完全隔离**：不同 tag（`dsh-desktop-v*` vs `dsh-v*`）、不同资产前缀（`dsh-desktop-shell-*` vs `DeepSeek-Harness-*`）、壳资产**永不写入** `latest.json`——内容升级逻辑零改动。
2. **复用现有发布基建**：`publish-shell.sh` 复用 `publish-release.sh` 的"先资产后清单"上传纪律（壳无清单，只有资产）。
3. **平台打包边界明确**：macOS 双架构本地打；Windows/Linux 走 CI（runner 原生环境），不在 Mac 上交叉打。
4. **壳版本独立**：壳 tag 版本号与内容版本解耦（壳迭代（如图标修复）不依赖上游发版）。

---

## 2. 发布拓扑

```
GitHub Releases — benson-album/dsh-desktop
├── dsh-v0.1.1-rc.2                     ← 内容 tag（在线流水线自动，维持现状）
│   ├── DeepSeek-Harness-…-darwin-x64.tar.gz   （内容升级，进 latest.json）
│   └── latest.json
│
└── dsh-desktop-v0.3.0                  ← 壳 tag（新增，发布者触发）
    ├── dsh-desktop-shell-darwin-x64-0.3.0.zip      （本地打）
    ├── dsh-desktop-shell-darwin-arm64-0.3.0.zip    （本地打）
    ├── dsh-desktop-shell-win32-x64-0.3.0.zip       （CI 打，nsis）
    └── dsh-desktop-shell-linux-x64-0.3.0.AppImage  （CI 打）
```

- 设备端内容升级只读 `latest.json` → 壳资产天然不可见，互不干扰。
- 壳包无清单（手动安装，不做 app 内自动升级；electron-updater 后续专项）。

---

## 3. electron-builder 配置扩展

```yaml
# electron-builder.yml（新增部分）
win:
  target:
    - target: nsis
      arch: [x64]
  icon: build/icon.png
nsis:
  oneClick: false          # 允许选择安装目录（自用场景）
  allowToChangeInstallationDirectory: true

linux:
  target:
    - target: AppImage
      arch: [x64]
  icon: build/icon.png
  category: Development
```

- macOS 保持现有配置；`publish-shell.sh` 传 `--x64/--arm64` 分别打（或 `-c.mac.arch`）。
- `npmRebuild: false` 沿用（壳无原生依赖）。

---

## 4. scripts/publish-shell.sh（本地打 mac 壳）

```
用法：bash scripts/publish-shell.sh <version> [--repo owner/repo] [--dry-run]
1. 校验 version（tag = dsh-desktop-v<version>）
2. pnpm build（壳编译）
3. 循环 arch  in (x64, arm64)：
     electron-builder --mac zip --x64 / --arm64   # 产出 .app 与 zip
     mv zip → dsh-desktop-shell-darwin-<arch>-<version>.zip
4. dry-run：仅本地产出；真实发布：
     gh release create dsh-desktop-v<version> <shell 资产> --repo …
     （资产逐个上传；无清单步骤）
```

- **electron-builder 多架构**：`--x64` / `--arm64` 需分别执行（每次下载对应 Electron 运行时，首次较慢）。
- **冒烟**：打包后对 x64 产物执行 `scripts/smoke.sh` 语义抽查（dev + packaged），arm64 留实机/模拟验证。
- **幂等**：同 tag 重复执行 → `gh release create` 失败则 `gh release upload --clobber`（复用 publish-release.sh 模式）。

---

## 5. .github/workflows/build-shell.yml（win/linux 壳 CI）

```
触发：workflow_dispatch（手动，带 version 输入）
     （后续可选：打 dsh-desktop-v* tag 时自动触发）

jobs:
  shell:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            asset: dsh-desktop-shell-win32-x64
          - os: ubuntu-latest
            asset: dsh-desktop-shell-linux-x64
    runs-on: ${{ matrix.os }}
    steps:
      - checkout
      - setup-node 22
      - pnpm install
      - pnpm build
      - electron-builder --win / --linux（按 matrix）
      - 资产重命名 → dsh-desktop-shell-<os>-x64-<version>.<ext>
      - gh release create dsh-desktop-v<version>（不存在则建）或 upload --clobber
```

- **注意**：electron-builder 在 CI 需要 `electron_config_cache` 重定向到可写缓存（沿用 §3 的沙箱/CI 重定向）。
- **产物格式**：win → `release/*.exe`（nsis）；linux → `release/*.AppImage`。

---

## 6. 安装指引（FR-S4）

| 平台 | 步骤 |
|---|---|
| macOS | 下载 `dsh-desktop-shell-darwin-<arch>-<version>.zip` → 解压 → 拖 `DeepSeek Harness.app` 到 Applications；未签名需右键打开（Gatekeeper） |
| Windows | 下载 `…-win32-x64-<version>.zip` → 运行内部 nsis 安装器（或解压 portable） |
| Linux | 下载 `….AppImage` → `chmod +x` → 双击运行（首次需处理 sandbox 权限） |

- 数据目录 `~/.dsh`（用户数据）与 `~/dsh-app`（harness 运行区）**不受壳替换影响**：装新壳后内容升级照常，会话/配置保留。

---

## 7. 文件改动清单

| 文件 | 改动 |
|---|---|
| `scripts/publish-shell.sh`（新增） | 本地打 mac 双架构壳 + 上传壳 tag |
| `.github/workflows/build-shell.yml`（新增） | win/linux 壳 CI 打包发布 |
| `electron-builder.yml` | 增加 `win`/`linux`/`nsis` target 配置 |
| `README.md` / `docs/technical/development-guide-v0.1.0.md` | 壳包安装指引、发布流程补充 |
| 内容升级体系（upgrade.ts/workflow/publish-release.sh） | **零改动** |

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Windows nsis 首次打包未知问题 | 壳 tag 缺 win 资产 | CI 先行验证；矩阵独立失败不影响 mac 资产 |
| Linux AppImage sandbox | 双击无法启动 | 文档注明 `--no-sandbox`/`chrome-sandbox` 处理；后续加 `setuid` 配置 |
| arm64 壳本地打包首次下载 Electron 运行时慢 | 耗时 | 预热缓存（electron_config_cache） |
| 壳版本与内容版本混淆 | 用户装错 | 资产前缀/文档双保险；壳 tag 独立 |

---

## 9. 测试计划

1. `publish-shell.sh 0.3.0 --dry-run`：本地产出 x64 + arm64 壳 zip，检查资产命名与体积。
2. 真实发布一次（`dsh-desktop-v0.3.0`）：mac 双架构资产就位；确认 `latest.json` 未变化（内容隔离验证）。
3. `build-shell` workflow 手动触发：win exe + linux AppImage 上传同一壳 tag。
4. 手动安装 mac 壳 → 启动 → 内容升级端到端回归（数据目录保留）。
5. 冒烟：dev + packaged 抽查。

---

## 10. 实施顺序（评审确认后）

1. `electron-builder.yml` 补 win/linux target
2. `scripts/publish-shell.sh`（mac 双架构）+ 本地 dry-run 验证 + 一次真实发布
3. `.github/workflows/build-shell.yml` + CI 演练（win/linux）
4. 安装指引（README/开发指南）
5. 回归：内容升级端到端 + 单测 + 冒烟

---

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.3.0 | 2026-08-21 | 首次成稿：壳包发布专项技术方案（草案，待评审）；内容升级体系（v0.2.0）保持不变 |
