# 开发设计文档 — 产物下载式自动升级（Release Download Upgrade）

- 文档版本：v0.2.0（⏳ 草案，待评审确认）
- 日期：2026-08-20
- 状态：**草案**（未实施；评审确认后按 §12 顺序实施）
- 关联：[PRD-DSH-release-download-upgrade-v0.2.0.md](../prd/PRD-DSH-release-download-upgrade-v0.2.0.md)（🔄 同版本）
- 既有基线：[dsh-desktop-shell-v0.1.0.md](./dsh-desktop-shell-v0.1.0.md)（源码构建式升级，已实施，**本方案保留其代码路径**）
- 技术基线：Electron 43.4.0 / electron-builder 26.15.3 / Node ≥22 / pnpm 11 / GitHub Releases

---

## 1. 设计原则

1. **双目录原则沿用**：运行区（`harness`）只读运行，候选区（`harness-new`）独立生产；升级产物替换前前台零感知。
2. **"构建"替换为"下载 + 解压"**：候选区内容来源从 `git archive + pnpm build` 变为 `GitHub Release 下载 + 校验 + 解压`；替换/回滚/状态机基础设施**零改动复用**。
3. **校验先行**：大小 + sha256 校验通过才解压；解压后验证入口文件与版本号，任一失败即清理，旧版不受影响。
4. **状态机扩展而非重写**：新增 `downloading` / `extracting` 两个状态，其余（idle/checking/ready/applying/applied/failed）语义不变；`building` 保留给源码通道。
5. **通道抽象**：`UpdateSource = 'release' | 'source'`，检测与候选区生产逻辑按通道分支；默认 `release`。
6. **壳层注入、零前端改动**：下载进度与就绪提示沿用 preload 注入机制（延续沉浸式迭代原则）。

---

## 2. 目录与文件布局

```
.app/Contents/Resources/harness-bundle.tar.gz   ← 打包内置（不变；首版解包路径不变）
~/dsh-app/
├── harness/          ← 运行区（不变；源码通道下带 .git）
├── harness-new/      ← 候选区（复用语义：产物通道=下载解压后的完整 checkout；源码通道=构建产物）
├── harness-old/      ← 备份区（替换时旧版暂存，不变）
├── downloads/        ← 【新增】下载临时区：<tag>/DeepSeek-Harness-….zip.part → .zip → 校验后解压
├── update-state.json ← 升级状态机持久化（扩展状态值，字段兼容旧版）
└── settings.json     ← 既有配置（新增字段见 §8）
```

- `downloads/` 生命周期：进入 `downloading` 时创建 `<tag>/`，下载、校验、解压完成后整目录清理；启动时发现残留 `.part`/`.zip`（上次中断）自动清理。
- `update-state.json` 扩展：`state` 增加 `downloading | extracting`；新增字段 `source`（本次升级的通道）与 `assetUrl`（产物通道记录下载源，便于失败诊断）。旧字段全部保留，**旧版本壳读新状态文件时按未知状态回退 idle**（`loadUpdateState` 已有容错）。

---

## 3. 发布侧（产物生产与发布）

### 3.1 本地一键发布（发布者手动）

```
scripts/publish-release.sh <version> [--repo owner/repo] [--dry-run]
1. 校验 tag 规范（dsh-v<version>，与既有 tagPrefix 对齐）
2. bash scripts/bundle-harness.sh          # 复用：产出 build/harness-bundle.tar.gz（含构建产物与 node_modules）
3. pnpm build && pnpm pack:dir             # 壳侧编译（沿用）
4. electron-builder --mac zip              # 产出 release/DeepSeek-Harness-<version>-mac-x64.zip
5. 本地冒烟：packaged 启动 + firstrun 解包抽查（复用 scripts/smoke*.sh 语义）
6. 计算 zip 的 sha256 与大小
7. 生成 latest.json（见 §4）               # 注意：此刻不发布清单
8. gh release create dsh-v<version> --notes "$(git log …)" <zip>   # 先传资产
9. 上传 latest.json 到同一 Release（或仓库固定路径）                # 后传清单，避免不一致窗口
```

- **顺序保证**：资产先于清单上传并确认成功（`gh release view` 校验资产存在），再发布清单；设备侧以清单为准，双重校验兜底。
- **幂等**：同 tag 重复执行覆盖资产与清单，设备检测到清单变化即重新下载。
- 若不用 `gh` CLI：脚本给出等价 curl 序列（`POST /releases` + `POST /releases/<id>/assets`），并在 README 记录手工步骤。

### 3.2 自动发布流水线（上游同步 + 自动打包上传）

**目标**：`deepseek-ai/deepseek-harness` 上游发布新版（`dsh-v*` tag）后，无需人工干预，自动构建产物并发布到本仓库 Releases；设备端检测逻辑不变（只看本仓库 Release）。

**触发与调度**：

| 项 | 结论 |
|---|---|
| 定时轮询 | cron 每 6h（`0 */6 * * *`），可配置；上游 release 事件无法直接订阅（`repository_dispatch` 需上游配合，不采用），轮询是唯一免上游协作的触发方式 |
| 手动兜底 | `workflow_dispatch`（手动运行 / 强制覆盖重发） |
| 幂等 | 上游最新 tag 已存在于本仓库 Releases → 直接退出，零成本重跑 |

**工作流（`.github/workflows/auto-release.yml`）步骤**：

```
1. 检出本仓库（含发布脚本）
2. 查询上游最新版本：gh api repos/deepseek-ai/deepseek-harness/releases/latest → tag_name
   （备选：git ls-remote --tags origin 'dsh-v*' 取最新）
3. 幂等判断：gh api repos/benson-album/dsh-desktop/releases 是否已含该 tag
   ├─ 已存在 → exit 0（跳过）
   └─ 未发布 → 继续
4. 检出上游源码：git clone --depth 1 --branch <tag> https://github.com/deepseek-ai/deepseek-harness.git
5. 构建 harness：pnpm install（--frozen-lockfile 失败降级 plain）+ pnpm build
   （注入 DSH_CLIENT_COMMIT_HASH=<tag commit>，打包时写入 version.json{version,commit}）
6. 打包产物：bundle-harness → electron-builder --mac zip（复用 §3.1 第 2–5 步语义）
7. 生成 latest.json（sha256 / size / url 按 tag 推导）
8. 发布：gh release create <tag> --notes <上游 release notes> + 上传 zip；后传 latest.json（顺序保证）
9. 失败：job 失败 + GitHub 邮件通知；本仓库无半成品（Release 仅在成功后创建），下次 cron 自动重试
```

**运行环境**：

| 项 | 结论 |
|---|---|
| runner | `macos-latest`（x64 目标与本地打包一致；arm64 留后续） |
| 工具链 | `actions/setup-node`（Node 22 LTS）+ corepack pnpm 11（按上游 `packageManager`）；git 预装 |
| 磁盘 | 构建区 + bundle 峰值约 3G，macOS runner 默认容量充足 |
| 额度 | 公开仓库 GitHub Actions 免费（含 macOS runner 分钟数）；每天 1–2 次构建用量远低于额度 |

**版本与产物一致性**：

- 产物 tag 与上游 tag **同名**（`dsh-v*`），设备侧版本对比与下载逻辑零改动。
- 上游同一 tag 重发内容：流水线按"已存在"跳过（避免重复构建）；如需覆盖，手动 `workflow_dispatch` 传 `force: true` 重新生成（P2）。
- 上游构建失败（如依赖/网络问题）：job 失败告警，不影响已发布的旧产物，下次轮询自动重试。

**与 §3.1 的关系**：§3.1 脚本是本地手动兜底与流水线的**共同底层**（流水线在 runner 上调用同一套打包/清单逻辑），保证本地与云端产物一致。

---

## 4. 更新清单（latest.json）

```json
{
  "version": "0.2.0",
  "tag": "dsh-v0.2.0",
  "publishedAt": "2026-08-20T10:00:00Z",
  "notes": "产物下载式升级 v0.2.0",
  "assets": [
    {
      "name": "DeepSeek-Harness-0.2.0-mac-x64.zip",
      "url": "https://github.com/<owner>/<repo>/releases/download/dsh-v0.2.0/DeepSeek-Harness-0.2.0-mac-x64.zip",
      "sha256": "…",
      "size": 536870912,
      "platform": "darwin-x64",
      "arch": "x64"
    }
  ]
}
```

- 字段以发布脚本生成的内容为准（`url` 亦可指向 Releases API 的 `browser_download_url`）。
- 多平台（后续 darwin-arm64 / win / linux）追加 `assets` 条目，壳按 `platform+arch` 匹配本机条目；匹配不到视为"无可用产物"（提示而非报错）。
- 备选：electron-builder 生态的 `latest-mac.yml`（`generateUpdatesFilesForAllChannels`），字段语义等价，但绑定 electron-updater 工具链；**本期采用自研 `latest.json`**，`latest-mac.yml` 记录为备选（决策点见 PRD §6）。

---

## 5. 检测（checking，产物通道）

- 触发沿用：启动 20s 首检 / 每 6h / ⌘U 手动；`updateBusy` 串行锁不变。
- 产物通道流程：

```
GET https://api.github.com/repos/<owner>/<repo>/releases/latest
  （或直接 GET 清单 raw URL：https://raw.githubusercontent.com/<owner>/<repo>/<branch>/latest.json）
→ 解析 tag（latest.json.version）
→ 与本地当前版本对比（本地版本来源见下）
   ├─ 相同 → idle（静默）
   └─ 不同 → downloading（记录 fromVersion/toVersion/assetUrl）
```

- **本地版本判定**：产物通道下运行区不一定带 `.git`（若从 zip 安装）。新增 `harness/version.json`（发布打包时随产物写入 `{ version, commit }`）；已有 `.git` 时优先 `git describe`（兼容源码通道装出来的运行区）。两种来源统一抽象为 `currentVersion(harnessDir)`。
- 网络失败静默重试（沿用现有 checking 的失败语义）；非 200 / 清单解析失败 → `failed(step='check-release')` 可重试。

---

## 6. 下载、校验与解压（downloading → extracting）

```
downloading:
  mkdir -p downloads/<tag>
  流式下载 assetUrl → downloads/<tag>/<name>.zip.part
    （Node 内置 https/net 流式写盘，事件回调推送 bytes/total 进度；
     或 system curl --fail --location --progress-bar 作为 fallback，二选一统一封装）
  完成后 rename .part → .zip
  校验：stat.size === manifest.size && sha256(file) === manifest.sha256
    ├─ 不符 → 清理 downloads/<tag> → failed(step='verify', message=…)
    └─ 通过 → extracting

extracting:
  rm -rf harness-new && mkdir -p harness-new
  tar -xzf downloads/<tag>/<name>.zip -C harness-new     # zip 内含顶层目录时展平处理
  验证 harness-new/apps/cli/lib/bin.js 存在
  验证 harness-new/version.json.version === manifest.version
    ├─ 任一失败 → 清理 harness-new + downloads/<tag> → failed(step='extract')
    └─ 通过 → state=ready，写 update-state.json（toVersion/assetUrl），推送"新版本 vX 已就绪"
```

- 磁盘占用峰值：zip（~500MB–1GB）+ 解压后运行区（~1.2–1.5G）短暂并存；`extracting` 完成即清理 `downloads/<tag>`，替换后清理 `harness-old`（沿用）。
- 崩溃恢复：启动时 `state=downloading|extracting` → 清理 `downloads/` 与半成品 `harness-new` → 重置 idle（沿用 `recoverUpdateState` 思路扩展）。

---

## 7. 就绪、替换与重启（ready → applying → applied）

**完全复用既有流程**（`dsh-desktop-shell-v0.1.0.md` §6.4）：

```
前置：运行区工作树干净（源码通道才校验；产物通道无 .git 恒干净）
stopBackend()（~1s）
rm -rf harness-old; mv harness harness-old; mv harness-new harness
验证 bin.js 存在 → 否则回滚（mv harness-old harness）
产物通道：运行区已含 version.json，无 .git 迁移动作
源码通道：mv harness-old/.git harness/.git + git reset --hard <toCommit>（保留）
rm -rf harness-old
state=applied → startBackend() → 弹窗"已生效，建议重启" [立即重启][稍后]
```

- 产物通道**不做** `.git` 迁移与 `git reset`（无 .git 需要对齐）；若运行区恰好带 .git（从源码通道切来），则保留原 .git 不动（版本判定已切换为 version.json 优先，避免歧义）。

---

## 8. 通道抽象与配置

```ts
// src/upgrade.ts 扩展
export type UpdateSource = 'release' | 'source'

export interface UpgradeSettings {
  // 既有字段（保留）
  harnessDir: string
  channel: UpgradeChannel          // tag | master（源码通道沿用）
  tagPrefix: string
  remote: string
  nodePath?: string
  pnpmPath?: string
  gitPath?: string
  // 新增
  updateSource: UpdateSource       // 默认 'release'
  releaseRepo: string              // 默认 'deepseek-ai/deepseek-harness'（与 DEFAULT_REMOTE 对应，待确认）
  releaseAssetPattern: string      // 默认 'DeepSeek-Harness-*-mac-x64.zip'
  releaseManifestUrl?: string      // 显式清单 URL（覆盖默认 raw URL 推导，便于自建镜像）
}
```

| settings.json 新增字段 | 默认 | 说明 |
|---|---|---|
| `updateSource` | `release` | 产物下载（默认）或源码构建 |
| `releaseRepo` | `deepseek-ai/deepseek-harness` | Releases 所在 owner/repo |
| `releaseAssetPattern` | `DeepSeek-Harness-*-mac-x64.zip` | 产物匹配模式 |
| `releaseManifestUrl` | 空（自动推导） | 显式清单 URL 覆盖 |

- 通道分支：`checkForUpdates` / `produceCandidate`（原 `buildUpdate` 改为通用命名）按 `updateSource` 分派——`release` → §5+§6；`source` → 现有 `git fetch + git archive + pnpm build` 全链路。
- 状态机新增状态常量：`'downloading' | 'extracting'`；`BuildResult` 扩展为 `ProduceResult`（语义不变，产物通道下 `to` 字段为版本号）。

---

## 9. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/upgrade.ts` | 新增 `UpdateSource` 类型与 settings 字段；`currentVersion()`（version.json/git describe 双来源）；`downloadAsset()`（流式下载 + 进度回调 + .part 语义）；`sha256File()`；`extractAsset()`（校验 + 解压 + 入口/版本验证）；状态机增加 `downloading/extracting`；`checkForUpdates`/候选区生产按通道分支；崩溃恢复扩展 |
| `src/main.ts` | 调度器适配通道；下载进度事件（`dsh:update-event { state:'downloading', progress }`）推送；启动清理 `downloads/` 残留 |
| `src/preload.ts` | "关于"面板展示下载进度（复用既有状态展示）；就绪提示条沿用，无结构改动 |
| `scripts/publish-release.sh`（新增） | 发布脚本：打包 → 冒烟 → 清单生成 → gh release 上传（资产先、清单后）；本地手动与云端流水线共用 |
| `.github/workflows/auto-release.yml`（新增） | 自动发布流水线：cron 轮询上游最新 tag → 幂等判断 → 检出/构建/打包 → 创建 Release 上传产物与清单（§3.2） |
| `scripts/bundle-harness.sh` | 复用；产物 zip 打包路径可复用其产出（另加 `version.json` 写入步骤） |
| `electron-builder.yml` | 本期无强制改动（可选加 `publish` 配置留后续） |
| harness 前端 / 后端 | **零改动** |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| GitHub 2GB 单文件上限 | 产物无法上传 | 控制 bundle 体积（prod-only 裁剪 node_modules 留后续）；多资产拆分 + 清单聚合 |
| 全量下载体积 | 升级下载耗时 | 后台下载 + 关于面板进度；断点续传（.part 保留续传留后续）；差分更新后续版本 |
| 清单与资产不一致窗口 | 设备拉到错误 URL/哈希 | 发布脚本顺序保证（先资产后清单）；sha256 + size 双重校验；校验失败即清理重试 |
| zip 解压路径穿越（恶意产物） | 安全 | 解压前校验清单 sha256（信任链=发布者签名，自用场景可接受）；解压目标限定在候选区并校验入口文件 |
| 产物通道运行区无 .git | 开发者无法在运行区直接改源码 | 属预期（产物通道面向使用）；开发者可切 `source` 通道或手动 clone 到运行区（文档说明） |
| 私仓鉴权 | 设备无法匿名下载 | 默认公开 repo；私有场景通过 `releaseManifestUrl` 指向可访问镜像（P2） |
| 旧壳读新状态文件 | 未知状态处理不当 | `loadUpdateState` 未知 state 回退 idle（现状容错已覆盖，补测试） |
| 上游 Releases API 限流/网络抖动 | 检测失败、漏发 | job 失败 + 邮件通知；下次 cron 自动重试；`workflow_dispatch` 手动兜底 |
| 上游构建失败（依赖/环境） | 该版本无产物 | job 失败告警，不产生半成品 Release（Release 仅在成功后创建）；旧产物不受影响 |
| 轮询时效（最长 6h 延迟） | 设备升级晚于上游发版 | 可调低 cron 间隔；接受轮询延迟为设计取舍 |

---

## 11. 测试计划

1. **单元（Node 驱动 upgrade.js，复用 .bootstrap-test 隔离方法）**：
   - 清单解析（正常/缺字段/非法 JSON → failed）
   - `sha256File` 正确性；size/sha256 不符 → verify 失败清理
   - `extractAsset` 成功路径 + 缺 bin.js / 版本不符 → extract 失败清理
   - 状态机：`downloading/extracting` 流转、中断后启动恢复清理
2. **集成（本地 HTTP 假发布源或私有测试 repo）**：
   - 检测 → 下载 → 校验 → 解压 → ready → 就绪事件
   - 断网 / 哈希错 / 损坏 zip → 清理重试，旧版可用
   - 替换 → 重启 → 新版本生效（version.json 变化）；替换失败回滚
3. **发布侧演练**：`publish-release.sh --dry-run` 产物 + 清单生成；真实打 tag 上传一次验证设备端拉取。
4. **自动流水线演练**：workflow 三分支验证——（a）上游无新 tag → 跳过；（b）有新 tag → 构建 → Release 出现 → 设备端拉取成功；（c）上游构建失败 → job 失败告警且无半成品 Release。
5. **手工验收清单（真实桌面）**：
   - [ ] 产物通道：发布新 tag → 后台自动下载解压 → 就绪提示 → 更新 → 重启生效（GUI 全程可用）
   - [ ] 关于面板显示下载进度
   - [ ] 断网/损坏场景提示可重试，无崩溃
   - [ ] 切换 `source` 通道 → 既有源码构建升级端到端回归
   - [ ] 首版解包、⌘U、重启后端、优雅退出、冒烟回归
6. **回归**：沉浸式窗口（红绿灯/拖拽区）不受影响。

---

## 12. 实施顺序（评审确认后）

1. `upgrade.ts`：`UpdateSource` 通道抽象 + `currentVersion` + 下载/校验/解压（单测先行）
2. 状态机扩展（downloading/extracting）+ 崩溃恢复 + 主进程调度/进度事件
3. `scripts/publish-release.sh` + 一次真实发布演练（含 `version.json` 写入打包）
4. `.github/workflows/auto-release.yml` 自动发布流水线 + 三分支演练（跳过/发布/失败）
5. 集成测试 + 手工验收 + 源码通道回归
6. 更新 development-guide（新命令、坑位记录、发布流程）与文档变更记录

---

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.2.0 | 2026-08-20 | 首次成稿：产物下载式升级技术方案（草案，待评审）；既有源码构建式管线完整保留 |
| v0.2.0 | 2026-08-20 | 增补 §3.2 自动发布流水线（GitHub Actions 上游同步 + 自动打包上传），并同步改动清单/风险/测试/实施顺序 |
