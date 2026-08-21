# dsh-desktop 技术方案设计 — DeepSeek Harness 桌面壳（v0.1.0）

| 文档版本 | v0.1（✅ 已确认并实施） |
|----------|-------------------|
| 编写日期 | 2026-08-18 |
| 评审状态 | ✅ 已确认并实施（2026-08-18） |
| 对应阶段 | v0.1.0（桌面壳专项） |
| 上游需求 | [PRD-DSH-desktop-shell-v0.1.0](../prd/PRD-DSH-desktop-shell-v0.1.0.md)（🔄，含 FR-D1~D6、NFR、验收标准） |
| 文档定位 | 技术实现规范（HOW）；业务规则以 PRD 为准 |

---

## 1. 概述

### 1.1 目标

以 Electron 封装 DeepSeek Harness Web GUI 为 macOS 桌面应用，核心约束为**零前端改动**与**升级不打断前台**：

- **壳层注入**：沉浸式拖拽区、更新提示条均由 preload 在页面 DOM 注入，harness 前端/后端源码零修改
- **后端子进程**：系统 Node 独立进程运行 `dsh web`，壳只负责生命周期与窗口
- **后台升级**：运行区只读运行，新版本在独立构建区后台构建，替换原子可回滚
- **品牌与本地化**：DeepSeek 图标；系统菜单语言跟随 dsh-app 语种（`locale.preference`）

### 1.2 范围（对应 PRD FR，一一映射）

| 能力组 | FR 编号 | 本文档章节 | 验收标准来源 |
|--------|---------|-----------|--------------|
| 壳与后端集成 | FR-D1.1~D1.6 | §3 | PRD §3.1 验收列 |
| 沉浸式窗口 | FR-D2.1~D2.5 | §4 | PRD §3.2 |
| 图标与品牌 | FR-D3.1~D3.2 | §5 | PRD §3.3 |
| 升级机制 | FR-D4.1~D4.8 | §6 | PRD §3.4 |
| 菜单本地化 | FR-D5.1~D5.4 | §7 | PRD §3.5 |
| 更新提示条 | FR-D6.1~D6.2 | §6.6 | PRD §3.6 |

### 1.3 非目标（本版本不做）

- 壳二进制自更新（electron-updater）、托盘、Windows/Linux
- harness 源码改动、前端构建管线改造

---

## 2. 总体架构

### 2.1 进程拓扑

```
┌─ Electron 主进程（壳）────────────────────────────────────────┐
│  settings.json / env / logs / update-state.json              │
│  spawn node apps/cli/lib/bin.js --profile web --port 0       │
│  ← stdout 就绪行 `dsh web: http://127.0.0.1:<port>`          │
│  BrowserWindow(titleBarStyle:hidden, trafficLightPosition)   │
│  Menu（本地化） · 后台升级调度 · 状态机 · 崩溃恢复           │
└──────────────┬───────────────────────────────────────────────┘
               │
   preload（contextIsolation + sandbox）
    ├─ 注入 drag region（32px 拖拽/双击最大化/全屏隐藏）
    ├─ 注入 update toast（右下角浮条）
    └─ contextBridge API（versions/update-status/apply-update/...）
               │
               ▼
   后端：node dsh web（loopback HTTP/WS，__DSH_BOOT__ 注入）
```

### 2.2 数据目录

```
~/dsh-app/                      ← DSH_APP_HOME（壳数据）
├── harness/                    ← 运行区（git 仓库，只读运行）
├── harness-new/                ← 构建区（后台构建，待替换）
├── harness-old/                ← 备份区（替换时旧版暂存）
├── update-state.json           ← 升级状态机（崩溃恢复）
├── settings.json               ← 壳设置（channel/autoCheck/...）
├── env                         ← KEY=VALUE 注入后端环境
└── logs/                       ← app.log + backend-*.log（保留 5 份）
~/.dsh/                         ← DSH_HOME（后端数据，壳不触碰）
```

### 2.3 技术基线

Electron 43.4.0（内置 Node ≥22.19 满足 harness 引擎）/ electron-builder 26.15.3 / TypeScript 6（CJS 输出）/ git archive / pnpm 11 / macOS x64。

---

## 3. 壳与后端集成（FR-D1）

### 3.1 启动与就绪

```
spawn('node', [bin, '--profile', 'web', '--port', '0'], { cwd: harnessDir, env })
  stdout 行匹配 /dsh web: (http:\/\/[^\s]+)/ → 窗口 loadURL
  超时 120s → 报错；后端异常退出 → 弹窗可重启
```

- `backendPort: 0` 由 OS 分配，永不冲突；`trafficLightPosition` 等窗口细节见 §4。
- 后端环境：`harnessEnv()`（用户 PATH 优先 + pnpm 11 工具链目录兜底）+ `DSH_HOME` + `~/dsh-app/env`。
- 单实例锁 + 代际守卫（`backendGen`）避免重启竞态误判崩溃。

### 3.2 生命周期

- 退出：`before-quit` → 停后端（SIGTERM → 5s 超时 SIGKILL）→ 退出。
- `window-all-closed`：仅当主窗口曾创建且已关闭才退出（启动期进度窗口关闭不算）。
- 冒烟模式（`--smoke`）：页面加载后断言 `#dsh-drag-region` DOM 存在，`app.quit()` 优雅退出。

---

## 4. 沉浸式窗口（FR-D2）

### 4.1 窗口配置

```ts
new BrowserWindow({
  titleBarStyle: 'hidden',                    // 隐藏标题栏，保留原生红绿灯
  trafficLightPosition: { x: 16, y: 14 },     // 垂直居中于 32px 拖拽区
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
})
```

- 不采用 `frame:false`/`transparent`：保留系统阴影/圆角/全屏行为，规避合成问题。
- 导航安全：`will-navigate` 仅允许 loopback 同源；`setWindowOpenHandler` 外链走系统浏览器。

### 4.2 preload 注入（拖拽区）

```html
<style id="dsh-wc-style">…</style>
<div id="dsh-drag-region"></div>   <!-- fixed 顶部 32px; -webkit-app-region: drag -->
```

- 幂等注入（DOM 判重）；`dblclick` → IPC `toggle-maximize`。
- `dsh:window-state`（maximize/fullscreen 事件推送）→ 全屏时隐藏。

### 4.3 窗口控制 IPC

```ts
ipcMain.on('dsh:window-control', (e, action) => {
  if (e.sender !== mainWindow?.webContents) return   // 安全校验
  if (action === 'toggle-maximize') mainWindow.isMaximized() ? unmaximize() : maximize()
})
```

---

## 5. 图标与品牌（FR-D3）

- 源：`cdn.deepseek.com/favicon.svg`（官方蓝鲸，品牌蓝 `#4D6BFE`）。样式：**品牌蓝底 + 白鲸**（Dock 任何背景醒目）。
- 生成：`scripts/gen-icon.js`（sharp）→ 白鲸（fill 替换）+ 蓝底 → 居中缩小（WHALE 620/1024 留边距）→ **圆角裁剪**（RADIUS 225）→ `build/icon.png`。
- 打包：`electron-builder.yml` `mac.icon: build/icon.png` → 自动转 `icon.icns`（plist `CFBundleIconFile`）。
- 复现：SVG 源存于 `build/deepseek-favicon.svg`。

---

## 6. 升级机制（FR-D4 / FR-D6）

### 6.1 内置首版（FR-D4.1）

- `scripts/bundle-harness.sh`：从**完整 git 仓库**参考源（默认 `.bootstrap-test/harness`，校验 `.git` 存在，缺失即报错）rsync 源码 + node_modules + `.git` + 构建产物 → **单个 `build/harness-bundle.tar.gz`**（约 416M，含 .git）。
  - 单文件归档规避 electron-builder 对 extraResources 中 `node_modules` 目录的排除；tar 保留 pnpm 符号链接。
- `electron-builder.yml`：`extraResources: { from: build/harness-bundle.tar.gz, to: harness-bundle.tar.gz }`。
- 首次启动：`extractBundle()` 解压到运行区（`tar -xzf`，验证 `apps/cli/lib/bin.js`），进度窗口，无 git/网络。

### 6.2 后台检测（FR-D4.2）

- 调度：启动 20s 首检，之后每 6h；菜单 ⌘U 手动。仅 `state === idle/checking 结束` 时触发（`updateBusy` 串行锁）。
- 检测 = `git -C harness fetch origin --tags --prune`（**不碰工作树**）→ tag 通道取最新 `dsh-v*`（`--sort=-v:refname`）或 master → 对比 `HEAD`。

### 6.3 后台构建（FR-D4.3）

```
rm -rf harness-new; mkdir harness-new
git -C harness archive --format=tar -o <tmp.tar> <toCommit>   # 导出快照，无 .git
tar -xf <tmp.tar> -C harness-new
pnpm install（CI=true，frozen 失败降级 plain；pnpm 版本≥11 校验）
pnpm build（lib + web，构建环境注入 DSH_CLIENT_COMMIT_HASH=<toCommit>，见 K-14）
成功 → state=ready；失败 → 清理 harness-new → state=failed
```

- 构建区是 `git archive` 快照（无 .git）：rc.8 起 harness 构建脚本 `repositoryCommitHash()` 执行 `git rev-parse HEAD` 取提交哈希，壳层在构建环境注入 `DSH_CLIENT_COMMIT_HASH=<toCommit>`（该函数优先读环境变量）绕开对 .git 的依赖（K-14）。

- 全程不触碰运行区；旧版本继续服务前台。

### 6.4 替换与重启（FR-D4.5 / D4.6 / D4.7）

```
前置：运行区工作树必须干净（dirty 拒绝替换，排查见 K-15）
stopBackend()（~1s）
rm -rf harness-old; mv harness harness-old; mv harness-new harness
验证 bin.js 存在 → 否则回滚（mv harness-old harness）
mv harness-old/.git harness/.git
git -C harness reset --hard <toCommit>      # HEAD 对齐，untracked 构建产物保留
rm -rf harness-old
state=applied → startBackend() → 弹窗"已生效，建议重启" [立即重启][稍后]
```

- 崩溃恢复：启动时若 `state=applying` 且运行区损坏 → 从 `harness-old` 自动回滚；`building` → 清理构建区。
- 状态机持久化：`update-state.json`（state/from/to/tag/buildError/时间戳）。

### 6.5 跨设备依赖发现（构建工具）

- 构建/后端依赖 git、node（≥22）、pnpm（≥11，harness lockfile 要求），发现顺序统一为：
  1. `settings.json` 显式指定（`nodePath`/`pnpmPath`/`gitPath`）或环境变量（`DSH_NODE_PATH`/`DSH_PNPM_PATH`/`DSH_GIT_PATH`）
  2. 用户 PATH（终端启动天然正确）
  3. **平台常见目录**（darwin：`~/Library/pnpm/.tools/*/bin`、Homebrew、`/usr/local`；linux：`~/.local/share/pnpm`、Volta、`~/.nvm/versions/node/*/bin`；win：`%LocalAppData%\pnpm`、`%APPDATA%\npm`、`Program Files\Git\cmd`）
  4. **pnpm 兜底**：corepack（随 node ≥16.9 自带，按仓库 `packageManager` 字段解析）→ npx pnpm@11（网络）
- 候选按序遍历，**跳过版本不满足的**（如 PATH 上的 pnpm 10 不会遮蔽 pnpm 11）。
- 诊断输出实际解析到的工具路径与版本（`buildDiagnostics`）。

### 6.5 通道与配置（FR-D4.8）

`settings.json`（`~/dsh-app/settings.json`，缺省用代码默认值）：`channel: tag|master`、`tagPrefix: dsh-v`、`autoCheck`（默认 true）、`autoCheckIntervalMs`（默认 6h）、`remote`。

- **更新源** `updateSource`：`release`（默认，从 GitHub Releases 下载预构建包）或 `source`（git 源码构建式，即 §6.2~6.4 的既有管线）。
  - `release`：清单 URL `https://github.com/<releaseRepo>/releases/latest/download/latest.json`；`releaseRepo`（默认 `benson-album/dsh-desktop`）、`releaseAssetPattern`（默认 `DeepSeek-Harness-*-<os>-<arch>.zip`）匹配当前平台资产；**该仓库必须已发布含 `latest.json` 的 release，否则检查更新报 HTTP 404**。
  - `source`：git fetch + tag 解析 + 后台构建（K-14 后无 .git 构建区亦可用）。发布资产未就绪时应切回此通道（K-16）。

### 6.6 更新提示条（FR-D6）

- preload 注入 `#dsh-update-toast`（右下角非模态浮条，z-index 高于页面）。
- 监听 `dsh:update-event`（state 变化推送）：`ready` → 显示"新版本 vX 已就绪" [立即更新][忽略]；`failed` → 显示失败摘要。
- [立即更新] → IPC `dsh:apply-update`；[忽略] → 关闭并记录 tag（同版本不再提示）；全屏时隐藏。
- 初始对账：`dsh:update-status` 拉取当前状态，避免页面重载后丢失提示。

---

## 7. 菜单本地化（FR-D5）

### 7.1 语种来源（FR-D5.2）

- dsh-app 语种 = Host 用户设置 `locale.preference`（`zh` | `en`），持久化于 **`~/.dsh/settings.yaml`**（`@deepseek-ai/dsh-settings-file`，YAML）。
- 读取顺序：
  1. `settings.yaml` 的 `locale.preference`（显式选择）
  2. 未设置 → `app.getPreferredSystemLanguages()` 以 `zh` 开头 → `zh`，否则 `en`
  3. 解析失败/异常 → `zh`（dsh 的 FALLBACK_LOCALE）
- YAML 解析：壳保持零运行时依赖，用轻量行解析（顶层 key 无缩进、子 key 两空格缩进），仅提取 `locale.preference`。

### 7.2 菜单重建（FR-D5.1 / D5.3）

- 新增 `src/i18n.ts`：`zh`/`en` 文案表 + `resolveMenuLanguage()` + `buildLocalizedMenu(lang)`。
- 覆盖**全部菜单项**（自定义 + role）：Electron 对 role 菜单项（Edit/Window/Copy/Paste/Hide/Quit 等）硬编码英文 label 且不随系统语言，因此应用菜单/编辑/视图/窗口的所有项均显式提供 zh/en label，不留 Electron 英文默认。
- 启动时构建一次；`fs.watch(settings.yaml)` 监听变化（debounce 500ms）→ 重新 `Menu.setApplicationMenu`，**无需重启**。
- 约 30 条文案 × 2 语言（`MENU_STRINGS`），结构化常量表；SMOKE 模式输出 `MENU_DUMP` 全菜单树供断言。

### 7.4 Chromium 渲染语言跟随系统

- Electron 主进程 `app.getLocale()` 在 macOS 上正确返回系统首选语言，但**渲染进程的 `navigator.language` 跟随系统"区域格式"**（区域为英文时即使首选语言是中文，GUI 仍回退英文）。
- 修复：主进程启动早期 `app.commandLine.appendSwitch('lang', <系统首选语言 zh → zh-CN / 其他 → en-US>)`，dsh GUI 未设置语种时回退 `navigator.languages` 即得正确语言，设置页语言项自动跟随系统 OS 语种。
- 验证：CDP 断言 `navigator.language` 与页面文案（zh 系统下页面为中文）。

### 7.3 冒烟断言扩展

`SMOKE` 模式可断言当前语言下菜单项 label 命中预期文案（如语言为 zh 时包含"检查更新…"）。

---

## 8. 测试与验收

| 层级 | 内容 | 命令/方式 |
|------|------|-----------|
| 单测 | upgrade 状态机/检测/构建/替换/回滚 | Node 直接驱动 `dist/upgrade.js`（隔离 clone） |
| 冒烟 | 启动/页面/拖拽区/优雅退出 | `scripts/smoke.sh`（`--no-sandbox --user-data-dir` 重定向） |
| 首次运行 | 内置解包无 git | `scripts/smoke-firstrun.sh`（空 DSH_APP_HOME） |
| 端到端 | 检测→后台构建→toast→替换→生效 | fake remote + CDP（已验证） |
| 调试 | `--debug` 启动诊断日志；菜单"生成诊断报告"写 `~/dsh-app/diagnostics-*.txt` | 见 FR-D7 |
| 手工 | 沉浸式/图标/语种切换/更新体验 | 桌面验收清单（PRD §7.2） |

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| electron-builder 过滤 extraResources 的 node_modules | 内置缺失依赖 | 归档为单文件 tar.gz（已验证） |
| 启动期进度窗口触发 window-all-closed | 误退出 | 主窗口创建标记守卫（已验证修复） |
| pnpm 10 全局版与 lockfile 不兼容 | 构建失败 | PATH 兜底 pnpm 11 + 版本校验 + 明确报错（已验证） |
| 语种文件变化竞态 | 菜单抖动 | fs.watch debounce + 容错默认 |
| 替换崩溃 | 应用不可用 | 状态机 + 启动自动回滚 |
| 双 node_modules 磁盘峰值 | ~2.4G | 替换后清理旧区；裁剪为后续优化 |

---

## 10. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.1 | 2026-08-18 | 首次成稿：壳集成/沉浸式/图标/后台升级/提示条/菜单本地化/调试 |
| v0.1 | 2026-08-18 | 修订①：图标圆角+留边距；bundle 参考源 git 校验（K-1）；buildError 模板字符串修复（K-2）；调试（--debug + 诊断报告） |
| v0.1 | 2026-08-18 | 修订②：window-all-closed 守卫（K-3）；role 菜单全覆盖本地化（K-11a）；Chromium lang 跟随系统（K-11b）；菜单 fs.watch 即时切换（K-12） |
| v0.1 | 2026-08-18 | 修订③：跨设备工具发现（§6.5/K-13）；resolvePnpm 内联候选遍历（K-7）；pnpm 版本校验 env（K-5）；CI=true（K-6） |
| v0.1 | 2026-08-20 | 修订④：启动不残留 failed 状态（K-9）；运行区缺 .git 提示（K-1 补充）；坑位与修复记录独立成档（[开发指南](./development-guide-v0.1.0.md)） |
| v0.1 | 2026-08-20 | 修订⑤：构建区注入 `DSH_CLIENT_COMMIT_HASH` 修复 rc.8 起 `pnpm build` 失败（§6.3/K-14） |
| v0.1 | 2026-08-20 | 修订⑥：dirty 提示文案显示实际运行区路径；运行区脏阻塞升级排查入档（§6.4/K-15） |
| v0.1 | 2026-08-20 | 修订⑦：settings.json 支持 `updateSource`/`releaseRepo`/`releaseAssetPattern`（release 通道，§6.5/K-16）；release 404 排查入档 |
