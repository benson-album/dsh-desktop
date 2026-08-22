# PRD — DSH-Desktop 壳包发布专项（Shell Release）

| 项目名称 | dsh-desktop · DeepSeek Harness 桌面应用 |
|----------|-----------------------------------------|
| 文档版本 | v0.3.0（✅ 已确认） |
| 编写日期 | 2026-08-21 |
| 文档状态 | ✅ 已确认（2026-08-21），进入实施 |
| 关联文档 | 技术方案 [dsh-shell-release-v0.3.0](../technical/dsh-shell-release-v0.3.0.md)（🔄 同版本）；内容升级体系 [PRD-DSH-release-download-upgrade-v0.2.0](./PRD-DSH-release-download-upgrade-v0.2.0.md)（已实施，本专项**不改变**其内容包逻辑） |
| 目标编号 | **DSH-Desktop-SR**（壳包发布专项） |

---

## 1. 背景与目标

### 1.1 背景

当前体系分两层（v0.2.0 已实施）：

- **壳**（`.app`）：Electron 应用，**本地打包**（`electron-builder --mac`），双击安装；
- **内容包**（tar.gz）：harness 本体，**在线流水线**（auto-release）自动打包发布，设备端自动升级。

**现状痛点**：

| 痛点 | 说明 |
|------|------|
| 壳更新靠手动分发 | 壳有改动时（如本次图标修复），只能本地重新打包，无统一发布渠道 |
| 壳无多平台产物 | 目前只打 macOS x64；arm64 可本地打，Windows/Linux 壳无 CI 打包 |
| 壳包与内容包混淆 | 用户容易把在线打包（内容）误认为"多平台运行包"（壳） |

### 1.2 目标

| 目标 | 说明 | 成功标志 |
|------|------|----------|
| 壳包独立发布 | 壳包以独立 tag（`dsh-desktop-v*`）+ `shell` 前缀资产发布，与内容包（`dsh-v*`）完全隔离 | 同一 Releases 页可区分两类资产，latest.json 不受壳包影响 |
| macOS 本地打双架构壳 | 本地一键产出 x64 + arm64 两个 .app/zip | `publish-shell.sh` 一次产出两个平台壳包 |
| Windows/Linux 壳 CI 打包 | 新 workflow 在 win/linux runner 上打壳包并上传 | 三平台壳包可下载 |
| 安装指引 | 用户从 Releases 手动下载安装新壳 | README/文档有明确安装步骤 |

### 1.3 非目标（本版本不做）

- **壳的自动更新**（app 内检测并下载替换 .app）——electron-updater 专项，后续版本；
- 壳代码签名与公证（个人自用沿用未签名；分发扩大后另立专项）；
- 壳包与内容包合并（保持两层独立，是特性而非缺陷）。

---

## 2. 用户故事

1. **发布者（macOS）**：跑 `bash scripts/publish-shell.sh 1.2.3` → 本地产出 x64+arm64 壳 zip → 上传到 `dsh-desktop-v1.2.3` Release。
2. **发布者（全平台）**：推送触发 `build-shell` workflow → Windows/Linux runner 自动打壳 → 上传同一壳 Release。
3. **用户（Intel Mac）**：想更新壳 → 下载 `dsh-desktop-mac-x64-1.2.3.zip` → 解压拖入 Applications。
4. **用户（内容升级）**：完全无感知——壳包发布不触碰 `latest.json`，内容自动升级照常。

---

## 3. 功能需求（FR）

> 优先级：P0=核心可用；P1=重要增强。

### 3.1 发布侧（FR-S1）

| 编号 | 需求 | 优先级 | 验收标准 |
|------|------|--------|----------|
| FR-S1.1 | 本地打 mac 双架构壳 | P0 | `scripts/publish-shell.sh <version>` 产出 `dsh-desktop-mac-{x64,arm64}-<version>.zip` |
| FR-S1.2 | 壳包上传独立 tag | P0 | 上传到 `dsh-desktop-v<version>` Release（与内容 `dsh-v<version>` 区分） |
| FR-S1.3 | 幂等 | P0 | 同 tag 重复执行覆盖资产，不产生重复 Release |

### 3.2 跨平台壳 CI（FR-S2）

| 编号 | 需求 | 优先级 | 验收标准 |
|------|------|--------|----------|
| FR-S2.1 | Windows 壳打包 | P0 | workflow 在 windows runner 打 `dsh-desktop-win-x64-<version>.zip`（nsis 安装器或便携版） |
| FR-S2.2 | Linux 壳打包 | P0 | workflow 在 ubuntu runner 打 `dsh-desktop-linux-x64-<version>.AppImage` |
| FR-S2.3 | 触发方式 | P1 | 手动 `workflow_dispatch`（打 tag 时触发）；可选后续自动 |

### 3.3 隔离与命名（FR-S3）

| 编号 | 需求 | 优先级 | 验收标准 |
|------|------|--------|----------|
| FR-S3.1 | 资产命名前缀 | P0 | 壳资产统一 `dsh-desktop-<os>-<arch>-<version>.<ext>`（os 用 mac/win/linux），与内容 `DeepSeek-Harness-*` 可区分 |
| FR-S3.2 | 不进内容清单 | P0 | 壳资产**不写入** `latest.json`（内容升级逻辑零改动） |
| FR-S3.3 | 标签命名 | P0 | 壳 tag 用 `dsh-desktop-v*`，内容 tag 保持 `dsh-v*`，互不覆盖 |

### 3.4 安装与文档（FR-S4）

| 编号 | 需求 | 优先级 | 验收标准 |
|------|------|--------|----------|
| FR-S4.1 | 安装指引 | P1 | README/开发指南说明：下载壳包 → 解压 → 安装/替换 .app；数据目录 `~/.dsh` 不受影响 |

---

## 4. 验收标准

1. 本地跑 `publish-shell.sh 0.3.0`：产出 darwin-x64 + darwin-arm64 两个壳 zip，上传到 `dsh-desktop-v0.3.0` Release。
2. 手动触发 `build-shell` workflow：win32-x64 zip 与 linux-x64 AppImage 上传到同一壳 Release。
3. 壳 Release 资产不含 `latest.json`；内容 Release 的 `latest.json` 不受壳发布影响。
4. 下载 mac 壳包安装后：正常启动、内容升级照常（数据目录保留）。
5. 既有功能回归：内容升级端到端、单元测试、冒烟。

---

## 5. 决策记录（草案，待评审确认）

| 决策点 | 结论（草案） | 说明 |
|--------|--------------|------|
| 壳 tag 命名 | `dsh-desktop-v<version>` | 与内容 `dsh-v<version>` 区分，天然隔离 |
| 壳资产命名 | `dsh-desktop-<os>-<arch>-<version>.<ext>`（os 用 mac/win/linux） | 用户视角命名，与内容资产（DeepSeek-Harness-*.tar.gz）明显区分 |
| Windows 壳形态 | nsis 安装器（默认）+ 可选 portable | electron-builder win target 配置 |
| Linux 壳形态 | AppImage | 免安装，双击运行 |
| 壳自动更新 | 本版本不做（electron-updater 后续专项） | 手动下载安装；内容升级不受影响 |
| 签名与公证 | 个人自用不签名（沿用） | 分发扩大后另立专项 |

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Windows/Linux 壳首次打包未知问题 | 壳包发布延迟 | CI 先行验证；失败仅影响壳 tag，不影响内容升级 |
| 壳与内容版本不同步 | 用户困惑装哪个 | 文档明确两者独立；壳 tag 独立版本号 |
| 未签名壳被 Gatekeeper/SmartScreen 拦截 | 安装受阻 | 文档注明"右键打开/仍要运行"；分发扩大后补签名 |
| 本地打 arm64 壳需下载 Electron arm64 运行时 | 首次较慢 | electron-builder 自动处理；可预热缓存 |

---

## 7. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.3.0 | 2026-08-21 | 首次成稿：壳包发布专项 PRD（草案，待评审）；内容升级体系（v0.2.0）保持不变 |
