# dsh-desktop 开发指南（v0.1.0）

| 文档版本 | v0.1（✅ 定稿） |
|----------|-----------------|
| 编写日期 | 2026-08-20 |
| 面向读者 | 后续维护者 / 二次开发者（含第三方 AI 软件） |
| 上游文档 | [PRD-DSH-desktop-shell-v0.1.0](../prd/PRD-DSH-desktop-shell-v0.1.0.md) · [dsh-desktop-shell-v0.1.0](./dsh-desktop-shell-v0.1.0.md) |
| 文档定位 | 从零开发/维护的**可执行规范**：环境、命令、测试、已知坑位、设计约束 |

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| OS | macOS **x64**（当前打包目标） | `electron-builder.yml` 写死 `arch: [x64]`；Apple Silicon 上 x64 版可经 Rosetta 2 运行（非原生） |
| 架构（arm64） | 当前**不支持原生 arm64**（Electron 跨平台指平台维度；每个平台还分 x64/arm64，Electron 本体与 NAPI 原生依赖均架构相关） | 交叉构建可行但**原生依赖必须为 arm64**：① 在 Apple Silicon 机器/CI 构建（`pnpm install` 自然装 arm64 NAPI 包）；或 ② x64 机器交叉构建时用 pnpm arch 覆盖（npmrc `arch=arm64 platform=darwin`）装 arm64 依赖 + `arch: [x64, arm64]`；最终均需 arm64 机器验证 |
| Node.js | ≥ 22.19（推荐 24 LTS） | harness 引擎要求 `^22.19 \|\| >=24`；后端以系统 Node 子进程运行 |
| pnpm | ≥ 11（corepack 亦可） | harness lockfile 由 pnpm 11 生成；pnpm 10 会报 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` |
| git | 任意现代版本 | 升级/构建全程调用系统 git |
| Electron / electron-builder | 43.4.0 / 26.15.3（devDependencies 锁定） | 打包缓存需重定向，见 §3 |

## 2. 仓库结构

```
workspace/deepseek-harness-app/
├── src/
│   ├── main.ts          # Electron 主进程：生命周期/窗口/菜单/升级编排/诊断
│   ├── preload.ts       # contextBridge API + 拖拽区/更新提示条注入
│   ├── i18n.ts          # 菜单双语文案 + settings.yaml 语种解析
│   ├── upgrade.ts       # 升级管线：工具发现/检测/构建/替换/解包（纯 Node，可单测）
│   └── progress.html    # 启动/更新进度窗口
├── scripts/
│   ├── bundle-harness.sh # 内置 bundle（tar.gz，必须含 .git）
│   ├── gen-icon.js       # 图标生成（蓝底圆角 + 白鲸）
│   ├── smoke.sh          # 冒烟（可 --packaged / --harness）
│   └── smoke-firstrun.sh # 首次运行冒烟（空 DSH_APP_HOME 解包）
├── docs/prd|technical/   # 本文档体系
├── build/                # icon.png / deepseek-favicon.svg / harness-bundle.tar.gz
└── release/              # electron-builder 产物（.app / zip）
```

## 3. 构建与打包（命令级）

```bash
pnpm install                                   # 装 electron/electron-builder/tsc/sharp
pnpm build                                     # tsc + 拷贝 progress.html → dist/

# 内置 bundle（必须先做，否则 .app 无法首次解包）
bash scripts/bundle-harness.sh                 # 参考源默认 .bootstrap-test/harness（git 仓库）
# 参考源必须满足：已 pnpm build + 是完整 git 仓库（缺 .git 脚本直接报错）
# 自定义参考源：DSH_BUNDLE_REF=~/path/to/git-clone bash scripts/bundle-harness.sh

# 打包（沙箱/CI 环境需重定向缓存到可写目录）
electron_config_cache="$PWD/.electron-cache" \
ELECTRON_BUILDER_CACHE="$PWD/.builder-cache" \
./node_modules/.bin/electron-builder --mac dir   # 产物 release/mac/DeepSeek Harness.app
./node_modules/.bin/electron-builder --mac zip   # 分发 zip

# 同步到 /Applications（用户实际运行位置）
rm -rf "/Applications/DeepSeek Harness.app" && cp -R "release/mac/DeepSeek Harness.app" /Applications/
```

> 图标再生成：`node scripts/gen-icon.js`（源 `build/deepseek-favicon.svg`，输出 `build/icon.png`，electron-builder 自动转 icns）。

## 4. 测试与验证

| 层级 | 命令/方式 | 覆盖 |
|---|---|---|
| 单元（纯 Node） | `node -e` 驱动 `dist/upgrade.js` | checkForUpdates / buildUpdate / applyBuiltUpdate / 回滚 / 工具发现 / i18n 解析 |
| 冒烟 | `scripts/smoke.sh [--packaged]` | 后端就绪、拖拽区 DOM（`SMOKE_DRAG_REGION`）、菜单语言（`MENU_LANG`/`MENU_DUMP`）、优雅退出无孤儿进程 |
| 首次运行 | `scripts/smoke-firstrun.sh` | 内置解包（bin/.git/dist/node_modules 齐全）、无 git 无网络 |
| 升级端到端 | fake remote + CDP（见 §6 坑位 K-8 方法） | 检测→后台构建→toast→替换→生效 |
| 人工验收 | PRD §7.2 清单 | 图标/红绿灯/拖拽/语种切换/更新体验 |

冒烟重定向数据目录（不污染真实环境）：`DSH_APP_HOME=$PWD/.smoke/app DSH_HOME=$PWD/.smoke/dsh-home`。

## 5. 运行时架构速览（维护者必读）

- **进程**：Electron 主进程（壳）→ `spawn` 系统 Node 跑 `dsh web`（`--port 0` 由 OS 分配）→ 解析 stdout 就绪行 `dsh web: http://127.0.0.1:<port>` → 窗口加载。
- **目录**：`~/dsh-app/{harness(运行区), harness-new(构建区), harness-old(备份), update-state.json, settings.json, env, logs}`；后端数据在 `~/.dsh`（壳不触碰）。
- **升级状态机**：idle → checking（纯 fetch）→ building（构建区）→ ready（toast）→ applying（原子替换）→ applied →（重启）→ idle；`update-state.json` 持久化，崩溃自动恢复/回滚。
- **零前端改动**：拖拽区、更新提示条由 preload 注入 DOM；红绿灯为系统原生；界面语言靠 `appendSwitch('lang')` 跟随系统（见坑位 K-12）。
- **工具发现**（跨设备）：settings/env pin > PATH > 平台目录 > corepack > npx（见 §6 K-5/K-13）。

## 6. 已知坑位与修复记录（务必先读，避免重蹈覆辙）

> 每条：现象 → 根因 → 修复 → 验证方式。改代码前对照检查。

| # | 现象 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| K-1 | 首次解包后自动更新报 `not-a-repo` | 内置 bundle 参考源（开发 checkout）不是 git 仓库，bundle 缺 `.git` | `bundle-harness.sh` 强制参考源为 git 仓库（缺 `.git` 即报错）；默认用 `.bootstrap-test/harness` | 首次运行冒烟 `RUN_DIR_OK (.git)`；解包后 `checkForUpdates` 返回 up-to-date |
| K-2 | `update-state.json` 的 buildError 是字面量 `'message' in result ? result.message : result.detail` | 模板字符串里误写表达式语法（漏 `${}`），真实错误被吞 | 改为先求值再拼入 | 触发失败后状态文件显示真实错误文本 |
| K-3 | 首次解包后后端启动即退出（SIGTERM） | 启动期进度窗口关闭触发 `window-all-closed` → `app.quit()` | `mainWindowEverCreated` 守卫：仅主窗口曾创建且已关闭才退出 | 首次运行冒烟通过 |
| K-4 | 打包后内置 bundle 缺 node_modules（`.app` 内仅源码） | electron-builder 对 extraResources 里的 `node_modules` 目录整体过滤 | bundle 打成**单个 tar.gz**（单文件不受该规则影响，且保留符号链接） | 首次运行冒烟 `RUN_DIR_OK (node_modules)` |
| K-5 | 构建报 `pnpm version (unresolved)` | 版本校验的 `spawnSync` 未传环境变量；Finder 启动 PATH 精简找不到 pnpm | 校验传 `harnessEnv` 环境；并改为跨设备工具发现（见 K-13） | 模拟精简 PATH（`PATH=/usr/bin:/bin:/usr/sbin:/sbin`）解析出 pnpm 11.7.0 |
| K-6 | 构建报 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` / `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | PATH 命中全局 pnpm 10；非 TTY 下 pnpm 拒绝删旧 node_modules | PATH 兜底 pnpm 11 工具链目录（用户 PATH 优先、`/usr/local/bin` 垫底）；install 注入 `CI=true` | applyUpdate 全流程在隔离克隆上成功 |
| K-7 | `findTools` 候选遍历漏掉平台目录（pnpm 11 解析不到） | 通用 findTools 存在隐藏缺陷（编译/闭包层面） | `resolvePnpm` 改为**内联候选遍历**（pin > PATH > 平台目录，逐个版本校验，跳过不满足的） | 精简 PATH 下解析到 11.7.0 |
| K-8 | 升级替换期间崩溃导致应用不可用 | 无恢复机制 | `update-state.json` 状态机 + 启动时 `recoverUpdateState`：applying 且运行区损坏 → 从 `harness-old` 回滚；building → 清构建区；failed/applied → 重置 | fake remote + CDP 端到端全链路验证 |
| K-9 | 重启后闪现上次的"自动更新失败"toast | `update-state.json` 残留 failed 状态被启动对账读出 | `recoverUpdateState` 将 failed/applied 重置为 idle（启动即重新检测） | 重启后无残留提示 |
| K-10 | 进度窗口显示"首次安装需要克隆仓库并构建"误导 | 旧文案残留（早期 clone 流程） | 文案改为"正在解包应用内置版本（本地解压，约 1 分钟，无需联网下载）"；标题改"正在启动" | 目视 |
| K-11 | 打开 app 后界面/菜单是英文，系统是中文 | ① Electron role 菜单 label 硬编码英文；② 渲染进程 `navigator.language` 跟随系统"区域格式"而非"首选语言"（区域为英文时 GUI 回退英文） | ① `MENU_STRINGS` 覆盖**所有**菜单项（含 role）的中英文案；② 主进程启动早期 `app.commandLine.appendSwitch('lang', 系统首选语言 zh→'zh-CN' 否则 'en-US')` | `MENU_DUMP` 断言中英菜单；CDP 断言 `navigator.language=zh-CN` 且页面中文 |
| K-12 | 菜单语言不随 dsh-app 语种即时切换 | 无监听 | `fs.watch(settings.yaml)` → debounce 500ms → 重建菜单（`buildMenu`） | 运行时改 settings.yaml，日志出现三次 `[menu] language=` |
| K-13 | 换设备（Linux/Windows/其他安装方式）后构建工具找不到 | 工具发现写死 macOS 路径 | 跨设备解析：settings/env pin > PATH > 平台目录（darwin/linux/win 分支）> corepack > npx pnpm@11；后端用解析出的 node 绝对路径 | 精简 PATH 模拟 + 平台目录单测 |
| K-14 | 自动更新构建失败：`pnpm build` 报 git `status: 128`（堆栈在 harness `scripts/build.ts` 的 `repositoryCommitHash` 调用处） | rc.8 起 harness 构建脚本执行 `git rev-parse HEAD` 取提交哈希，但构建区是 `git archive` 导出的快照（**无 .git**），git 以 128 退出 | `buildUpdate` 向构建环境注入 `DSH_CLIENT_COMMIT_HASH=<toCommit>`——harness 的 `repositoryCommitHash()` 优先读该环境变量，绕开对 .git 的依赖（保持"零 harness 改动"约束） | 端到端：驱动 `dist/upgrade.js` 对 rc.8 目标提交真实构建成功；应用内重试更新通过 |

## 7. 关键设计约束（改代码前先理解，勿破坏）

1. **零前端改动**：harness 前端/后端源码一行不改；一切桌面能力由壳层（main/preload）实现。
2. **双目录升级**：运行区只读运行、构建区独立构建，替换前前台零感知；`git fetch` 永不触碰工作树。
3. **原子替换**：`mv harness→harness-old; mv harness-new→harness` + `.git` 迁移 + `reset --hard`；失败回滚；任何时刻至少一个可用版本。
4. **tar.gz 单文件 bundle**：既规避 electron-builder 的 node_modules 过滤，也保留 pnpm 符号链接（K-4）。
5. **工具发现内联**：`resolvePnpm` 不用通用 findTools（K-7 教训）；版本不满足的候选必须跳过继续找。
6. **`CI=true`**：pnpm 在非 TTY 下删除/重建 node_modules 必须（K-6）。
7. **`appendSwitch('lang')`**：必须在 `app ready` 前调用，否则渲染进程语言仍是区域格式（K-11）。
8. **PATH 顺序**：用户 PATH 优先；补充目录按优先级；`/usr/local/bin` 垫底（避免全局旧 pnpm 遮蔽）。
9. **启动期窗口守卫**：`window-all-closed` 必须检查 `mainWindowEverCreated`（K-3）。
10. **数据隔离**：`DSH_HOME`（用户数据）与 `DSH_APP_HOME`（壳数据）严格分离；升级替换永不触碰 `~/.dsh`。

## 8. 后续优化项（已知，未做）

- 内置 bundle 裁剪（prod-only node_modules，减小 .app 体积；当前全量 416M 压缩）
- electron-updater 壳二进制自更新（blockmap 已就绪）
- 托盘常驻、多窗口、系统通知
- Windows / Linux 打包目标（代码分支已备）
- **Apple Silicon 原生 arm64 构建**（打包配置 `arch` 加 arm64；原生依赖用 arm64 机器构建或 pnpm arch 覆盖装 arm64 版；arm64 机器验证）
- 应用内设置页（语种/通道/检查间隔/工作目录）
- 代码签名与公证（当前个人自用未签名，Gatekeeper 需右键打开）

## 9. 发布流程（供后续版本复用）

1. `pnpm build` → `bash scripts/bundle-harness.sh`（git 参考源）→ `pnpm pack:dir` → 冒烟（dev + packaged + firstrun）→ 升级端到端抽查
2. 同步 `/Applications` 并提示用户 `killall Dock`（图标缓存）+ 重启 app
3. `electron-builder --mac zip` 产出分发包
4. 更新 PRD/technical/本指南的变更记录与版本

---

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.1 | 2026-08-20 | 首次成稿：环境/构建/测试/架构速览 + 13 条已知坑位与修复记录（K-1~K-13）+ 10 条设计约束 + 后续优化项 + 发布流程 |
| v0.1 | 2026-08-20 | 修订⑤：构建区注入 `DSH_CLIENT_COMMIT_HASH` 修复 rc.8 起 `pnpm build` 失败（K-14） |
