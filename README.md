# dsh-desktop — DeepSeek Harness 桌面壳

一个轻量 Electron 应用壳：**用系统 Node 以子进程方式启动 `dsh web` 后端**，等它就绪后把 Harness GUI 打开在原生窗口里，并内置 **git 托管 checkout 的自动升级闭环**。前端页面走 loopback HTTP，harness 自带的浏览器信任围栏天然放行，**零前端改动**。

```
┌─ Electron 主进程（壳，约 300 行）────────────────────┐
│  settings.json / env / 日志                         │
│  spawn node apps/cli/lib/bin.js --profile web       │
│  ← 解析 stdout 就绪行 `dsh web: http://127.0.0.1:P` │
│  BrowserWindow → loadURL(loopback)                  │
│  菜单：检查更新 / 重启后端 / 日志 / 关于             │
└─────────────────────────────────────────────────────┘
```

## 目录与产物

| 路径 | 说明 |
|---|---|
| `src/main.ts` | Electron 主进程：后端生命周期、窗口、菜单、升级编排 |
| `src/upgrade.ts` | git clone/fetch/checkout + pnpm install/build（无 Electron 依赖，可单测） |
| `src/preload.ts` | 通过 contextBridge 暴露最小 API（版本 / 更新 / 日志） |
| `src/progress.html` | 首次安装 / 升级的进度窗口 |
| `dist/` | tsc 编译产物（build 脚本同时拷贝 progress.html） |
| `release/` | electron-builder 输出（`DeepSeek Harness.app`、zip） |

## 数据目录（DSH_APP_HOME）

默认 `~/dsh-app`（可用环境变量 `DSH_APP_HOME` 覆盖）：

| 项 | 说明 |
|---|---|
| `harness/` | 应用自管的 git 克隆（默认 harnessDir，即 agent 的工作 checkout） |
| `settings.json` | 应用设置（见下） |
| `env` | `KEY=VALUE` 行，合并进后端环境（放 API key 等，兼容 Finder 启动无 shell 环境） |
| `logs/` | `app.log` + 每次后端的 `backend-*.log`（保留最近 5 份） |

harness 的数据（sessions/storages/profiles）默认仍在 `~/.dsh`（`DSH_HOME`），与现有使用完全连续。

## settings.json 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `harnessDir` | `~/dsh-app/harness` | 托管 checkout 路径 |
| `channel` | `tag` | `tag`=最新 `dsh-v*` 发布标签；`master`=跟随 origin/master |
| `tagPrefix` | `dsh-v` | tag 通道的标签前缀 |
| `remote` | `https://github.com/deepseek-ai/deepseek-harness.git` | 升级/克隆来源 |
| `autoCheck` | `false` | 启动 15s 后静默检查更新 |
| `backendPort` | `0` | `0`=系统分配空闲端口（永不冲突） |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 传给后端的 DSH_HOME |
| `nodePath` / `pnpmPath` / `gitPath` | PATH 查找 | 可钉住绝对路径 |

> 注意：harness 的 lockfile 由 **pnpm 11** 生成。若本机 `pnpm` 是旧版（如 `npm i -g pnpm` 装的 10.x），应用会优先使用 `~/Library/pnpm/.tools/pnpm/<version>/bin` 下的 pnpm 11；仍不满足时更新会报错并提示在 `pnpmPath` 里指定绝对路径。

## 升级机制（git，后台优先，前台无感）

- **首版内置**：打包时把一版完整 harness（源码 + 依赖 + 构建产物 + .git）内置进 `.app`（`Resources/harness-bundle/`）。首次打开直接解包使用（本地复制，无 git、无网络）。
- **后台自动升级**：启动 20s 后自动检测，之后每 6 小时一次；检测只做 `git fetch`（不动运行中的工作树）。发现新版本后自动在独立构建区（`~/dsh-app/harness-new`）后台 `pnpm install` + `pnpm build`，**全程不影响前台 GUI**（旧版本继续运行）。
- **就绪提示**：构建完成后页面右下角出现浮条"新版本 vX 已就绪"，可忽略。
- **更新替换**：点击"立即更新"→ 停后端（约 1s）→ 原子替换（失败自动回滚）→ 新版本生效 → 弹窗建议重启应用。
- **手动检查**：菜单"检查更新…"（⌘U）立即触发一次检测。
- 运行区有未提交修改时**拒绝替换**（避免覆盖 agent 的改动），提示先 commit/stash。
- 断网/构建失败：保持旧版本可用，提示可重试，不影响使用。

## 开发 / 打包 / 验证

```bash
pnpm install            # electron / electron-builder / typescript
pnpm build              # tsc + 拷贝 progress.html
pnpm start              # 本机直接跑（用 ~/dsh-app 配置）
pnpm smoke              # 冒烟：后端就绪 + 页面加载成功后打印 SMOKE_OK 并退出
pnpm pack:dir           # 打包未签名 .app 到 release/mac/
pnpm dist               # 同时产出 zip
```

冒烟测试可用环境变量把数据目录重定向到临时位置，不碰真实数据：

```bash
DSH_APP_HOME=$PWD/.smoke/app DSH_HOME=$PWD/.smoke/dsh-home \
DSH_AGENTS_HOME=$PWD/.smoke/agents pnpm smoke
```

## 常见问题

- **首次打开提示"无法验证开发者"**：个人自用未签名构建，右键应用 → 打开即可（后续可加 ad-hoc 签名或公证）。
- **Finder 启动后 agent 看不到 API key**：key 放 `~/dsh-app/env`（`DEEPSEEK_API_KEY=...`），应用启动时会注入后端环境。
- **「检查更新」失败/目录不是 git 仓库**：运行区（`~/dsh-app/harness`）缺少 `.git`（例如手动指向了旧的开发 checkout）。把 `harnessDir` 改回默认，或删除 `~/dsh-app/harness` 后让应用重新解包内置版。
- **端口冲突**：默认 `backendPort: 0` 由系统分配，不会与现有 3080 开发会话冲突。
