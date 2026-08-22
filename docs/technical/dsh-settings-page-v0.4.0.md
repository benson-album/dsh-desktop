# 开发设计文档 — 应用设置页（App Settings）

- 版本：v0.4.0（✅ 已确认）
- 日期：2026-08-22
- 状态：**已确认**（2026-08-22），已随壳 v0.3.4 实施发布
- 关联：菜单「应用」→「检查更新」下方新增「应用设置…」（⌘,）

---

## 1. 功能

在应用菜单「检查更新」下方新增 **「应用设置…」**（快捷键 ⌘,），打开**独立设置窗口**，将 `~/dsh-app/settings.json` 中可配置项分类展示、可编辑保存，替代"手改配置文件"。

## 2. 界面（参考 dsh 内置设置弹窗样式）

布局借鉴 dsh 设置弹窗（`settings-chrome` 快照形态）：

```
┌─ 应用设置 ────────────────────────────────┐
│  ┌──────────┐  分组标题                    │
│  │ ◉ 更新与升级 │  设置项: 标题 + 控件        │
│  │   目录与数据 │  设置项: 标题 + 控件        │
│  │   GitHub   │  …                        │
│  │   工具链    │                           │
│  │   关于      │                           │
│  └──────────┘                             │
│  [打开配置文件]                    [关闭]   │
└───────────────────────────────────────────┘
```

- **左侧**：分类导航（图标 + 文字，点击切换）
- **右侧**：分组设置项（标题 + 控件：开关/下拉/输入框/按钮组）
- **底部**：「打开配置文件」（shell 打开 settings.json）「关闭」
- 配色跟随系统（CSS `prefers-color-scheme`），字体/圆角与 dsh 接近（12-13px 系统字体、8-10px 圆角）

## 3. 可配置项（分类归纳）

| 分类 | 字段 | 控件 | 生效 |
|---|---|---|---|
| **更新与升级** | `updateSource`（release/source） | 下拉 | 重启 |
| | `channel`（tag/master） | 下拉 | 重启 |
| | `autoCheck` | 开关 | 即时 |
| | `autoCheckIntervalMs` | 数字（小时） | 即时 |
| | `releaseManifestUrl`（高级） | 输入框 | 即时 |
| | `releaseDownloadMirrors`（高级） | 多行文本（每行一个） | 即时 |
| **目录与数据** | `harnessDir` | 输入框 + 选择 | 重启 |
| | `dshHome`（数据目录） | 输入框 + 选择 | 重启 |
| | APP_HOME（只读显示） | 文本 | — |
| **GitHub** | `releaseRepo` | 输入框 | 即时 |
| | `releaseAssetPattern`（高级） | 输入框 | 即时 |
| | `remote`（source 通道） | 输入框 | 重启 |
| | `tagPrefix`（高级） | 输入框 | 重启 |
| **工具链**（source 通道） | `nodePath` / `pnpmPath` / `gitPath` | 输入框（可空） | 重启 |
| **dsh 应用设置** | `locale.preference`（zh/en，写入 `~/.dsh/settings.yaml`，壳菜单联动） | 按钮组 | 即时 |
| | 「打开 dsh 配置文件」 | 按钮（shell 打开 `~/.dsh/settings.yaml`） | — |
| | 说明：模型/插件/Agent 预设等在 harness 应用内设置（壳不重复实现） | 文本 | — |
| **关于**（只读） | 应用版本 / harness 版本 / 更新状态 / 通道 / **编译者: BenSon.Album / 邮箱: chinasir@qq.com / 仓库链接** | 文本 + 链接 | — |

- 「高级」项默认折叠（details/summary），减少干扰
- 每个分类底部说明哪些项需**重启生效**

## 4. 技术实现

| 文件 | 改动 |
|---|---|
| `src/settings.html`（新增） | 设置页：左侧导航 + 右侧表单（纯 HTML/CSS/JS，`prefers-color-scheme` 深浅色） |
| `src/preload.ts` | 新增 `getSettings()` / `saveSettings(patch)` / `openSettingsFile()` IPC |
| `src/main.ts` | 菜单加「应用设置…」（⌘,）；打开设置 BrowserWindow（约 420×560，非 modal 可失焦）；IPC：读 settings.json、写回（合并保存，未知键保留）、打开配置文件；设置窗口可复用 `dsh:update-event` 展示更新状态 |
| `src/upgrade.ts` | 无改动（配置字段已存在） |
| `src/i18n.ts`（或新增小模块） | 轻量 YAML 写入：只改 `locale.preference` 值（保留 settings.yaml 其余内容，零依赖） |
| 文档 | development-guide 说明设置页 |

**保存规则**：
- `saveSettings(patch)`：读现有 settings.json → 合并 patch → 原子写回（临时文件 + rename）→ 广播 `dsh:settings-changed`
- 即时生效项由主进程直接应用（如 `autoCheck` 重启调度器）；重启生效项在页面上标注
- 「重置为默认」按钮：删除用户覆盖，回写默认值

## 5. 测试计划

1. 编译 + 现有 26 单测回归
2. 打开设置窗口：分类切换、各控件回显 settings.json 当前值
3. 修改并保存：settings.json 落盘正确（合并不丢未知键）；重启后 loadSettings 生效
4. 菜单/⌘, 打开、窗口关闭/失焦行为
5. 深浅色跟随系统切换
6. dsh 语言切换：写 `~/.dsh/settings.yaml` 后，壳菜单语言立即/重启联动（复用现有 resolveMenuLanguage）
7. 「打开 dsh 配置文件」「打开仓库链接」行为正确

## 6. 实施顺序

1. `src/settings.html`（布局 + 全部表单控件 + 样式）
2. `src/main.ts` 菜单 + 窗口 + IPC（读/写/打开文件）
3. `src/preload.ts` API
4. 保存逻辑（原子写 + 即时应用 + 重启标注）
5. 测试 + 打包验证

---

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.4.0 | 2026-08-22 | 首次成稿：应用设置页设计（草案，待确认） |
| v0.4.0 | 2026-08-22 | 实施修订：菜单「应用设置」置于「检查更新」上方（⌘,）；设置窗口沉浸式无边框（与主窗口一致）、宽度 640；顶部拖拽区让出红绿灯；select 自定义外观屏蔽系统强调色（橙色）；harnessDir/DSH_HOME 目录选择器；toast 双语；dsh 语言切换联动壳菜单 |
