# dsh-desktop — DeepSeek Harness 桌面应用

一个轻量 Electron 应用壳：**用系统 Node 以子进程方式启动 `dsh web` 后端**，等它就绪后把 Harness GUI 打开在原生窗口里（`--no-open`，浏览器不再自动弹出），并内置**产物下载式自动升级**闭环（内容升级自动、壳更新可检测）。前端页面走 loopback HTTP，harness 自带的浏览器信任围栏天然放行，**零前端改动**。

```
┌─ Electron 主进程（壳）────────────────────────────┐
│  settings.json / env / 日志 / 设置窗口             │
│  spawn node apps/cli/lib/bin.js --profile web --no-open
│  ← 解析 stdout 就绪行 `dsh web: http://127.0.0.1:P` │
│  BrowserWindow → loadURL(loopback)                 │
│  菜单：应用设置(⌘,) / 检查更新(⌘U) / 重启后端 / 关于 │
└────────────────────────────────────────────────────┘
```

## 目录与产物

| 路径 | 说明 |
|---|---|
| `src/main.ts` | Electron 主进程：后端生命周期、窗口、菜单、升级编排、设置窗口/IPC |
| `src/upgrade.ts` | 升级管线：release 通道（清单解析/镜像下载/校验/解压）+ source 通道（git 构建），无 Electron 依赖可单测 |
| `src/preload.ts` | contextBridge API（版本 / 更新 / 设置窗口） |
| `src/progress.html` | 首次安装 / 升级进度窗口 |
| `src/settings.html` | 应用设置页（⌘,，参考 dsh 设置弹窗样式） |
| `scripts/publish-release.sh` | 内容发布：打包 tar.gz + latest.json + 上传 Releases + 同步仓库 main |
| `scripts/publish-shell.sh` | 壳发布：本地打 mac x64/arm64 壳 + 上传（win/linux 由 CI 云打包） |
| `scripts/test-upgrade-release.js` | release 通道单元测试（本地 HTTP 假发布源） |
| `.github/workflows/auto-release.yml` | 内容自动发布：6h 轮询上游 → 构建 → 发布（四平台矩阵） |
| `.github/workflows/build-shell.yml` | 壳云打包：打 dsh-desktop-v* tag 自动出 win/linux 壳 |
| `dist/` | tsc 编译产物（build 脚本同时拷贝 html） |
| `release/` | electron-builder 输出 |

## 数据目录（DSH_APP_HOME）

默认 `~/dsh-app`（可用环境变量 `DSH_APP_HOME` 覆盖）：

| 项 | 说明 |
|---|---|
| `harness/` | 运行区：被升级的 harness 内容（version.json 记录版本） |
| `harness-new/` | 候选区：下载解压 / 构建的新版本 |
| `downloads/` | 下载临时区（.part → 校验 → 解压） |
| `settings.json` | 应用设置（见下；可经设置页 ⌘, 修改） |
| `env` | `KEY=VALUE` 行，合并进后端环境（放 API key 等） |
| `logs/` | `app.log` + `backend-*.log`（保留最近 5 份） |

harness 的数据（sessions/storages/profiles）默认仍在 `~/.dsh`（`DSH_HOME`）。

## settings.json 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `updateSource` | `release` | `release`=产物下载（默认）；`source`=git 源码构建 |
| `channel` | `tag` | tag 通道（source 用）；`master`=跟随主分支 |
| `tagPrefix` | `dsh-v` | tag 前缀 |
| `remote` | `https://github.com/deepseek-ai/deepseek-harness.git` | source 通道克隆来源 |
| `releaseRepo` | `benson-album/dsh-desktop` | 发布仓库（Releases + latest.json） |
| `releaseAssetPattern` | `DeepSeek-Harness-*-<os>-<arch>.tar.gz` | 内容资产匹配（信息性，实际按清单 os+arch） |
| `releaseManifestUrl` | 自动（jsDelivr） | 清单 URL；默认 `cdn.jsdelivr.net/gh/<repo>@main/latest.json`（国内可达） |
| `releaseDownloadMirrors` | 内置默认 | 下载镜像前缀列表（ghproxy 风格），best-first 择优 + 失败切换 |
| `autoCheck` | `true` | 启动 20s 后自动检测，之后每间隔一次 |
| `autoCheckIntervalMs` | `6 * 3600_000` | 自动检查间隔（毫秒） |
| `harnessDir` | `~/dsh-app/harness` | 运行区路径 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 传给后端的 DSH_HOME |
| `backendPort` | `0` | `0`=系统分配空闲端口 |
| `nodePath` / `pnpmPath` / `gitPath` | PATH 查找 | source 通道工具链可钉住绝对路径 |

> 以上绝大多数可在**设置页（⌘,）**中修改，含 dsh 语言切换（写 `~/.dsh/settings.yaml`，壳菜单联动）。

## 升级机制（后台优先，前台无感）

- **内容升级（release 通道，默认）**：
  - 每 6h / 启动 20s / ⌘U 触发检测 → jsDelivr 拉取 `latest.json` → 按本机 os+arch 匹配资产
  - 有新版 → 后台下载 tar.gz（**多镜像择优**，失败自动切换）→ sha256 校验 → 解压到候选区
  - 就绪后右下角提示"新版本已就绪" → 点更新 → 原子替换（失败自动回滚）→ 重启生效
- **内容升级（source 通道）**：git fetch → 后台 pnpm install/build（旧方案保留，可切换）
- **壳更新检测**：⌘U 同时对比 GitHub 最新 `dsh-desktop-v*` tag 与本地版本，有新版弹窗跳转下载页
- 断网/损坏/构建失败：保持旧版本可用，提示可重试；运行区有未提交修改时拒绝替换

## 开发 / 打包 / 验证

```bash
pnpm install
pnpm build              # tsc + 拷贝 html
pnpm test:release       # release 通道单元测试（26 用例）
pnpm start              # 本机直接跑
pnpm smoke              # 冒烟

# 内容发布（发布者）
bash scripts/publish-release.sh <version> --dry-run   # 只打包不传
DSH_RELEASE_REF=<构建好 checkout> bash scripts/publish-release.sh <version>  # 真实发布

# 壳发布（发布者，mac 本地）
bash scripts/publish-shell.sh <version> --dry-run
bash scripts/publish-shell.sh <version>               # 打 mac x64/arm64 + 打 dsh-desktop-v<version> tag
# 打 tag 后 build-shell 自动云打包 win/linux
```

> **发布节奏约定**（见 AGENTS.md）：小改动只入库累积；P0 立即发；常规每日≤1 版或 ≥20 条变更再发。

## 常见问题

- **首次打开提示"无法验证开发者"**：个人自用未签名构建，右键应用 → 打开。
- **「检查更新」报清单超时**：清单走 jsDelivr（国内可达）；仍失败可在设置页配置 `releaseManifestUrl` 指向可达镜像。
- **内容下载慢/失败**：设置页配置 `releaseDownloadMirrors`（ghproxy 风格镜像列表），自动择优切换。
- **Finder 启动后 agent 看不到 API key**：key 放 `~/dsh-app/env`。
- **运行区缺 `.git` 导致 source 通道不可用**：改用 release 通道（默认），或删除运行区让应用重新解包。
