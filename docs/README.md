# DeepSeek Harness 桌面壳（dsh-desktop）文档索引

> 文档体系面向**维护者与第三方开发者（含 AI 软件）**：需求 → 技术方案 → 开发指南 → 验证。

## 升级方案速览（两套可切换）

| | **产物下载式**（默认，`release`） | **源码构建式**（`source`） |
|---|---|---|
| 升级方式 | 下载 tar.gz（多镜像择优）→ 校验 → 解压 | git fetch + 后台 pnpm 构建 |
| 优点 | 快、无需构建环境、失败面小 | 可追 master、运行区可直接改源码 |
| 设备端依赖 | 仅网络 | git / node ≥22 / pnpm ≥11 |
| 切换方式 | 设置页（⌘,）→ 更新与升级 → 更新源 | 同左 |

> 两套方案**内容版本天然对齐**（都跟随上游 `deepseek-harness` 的 `dsh-v*` tag）；壳版本独立（`dsh-desktop-v*`）。

## 整体流程图（内容自动升级闭环）

```
上游 deepseek-harness 发新版（dsh-v* tag）
        │ ① auto-release 每 6h 检测（cron，云端）
        ▼
   云端构建打包（darwin-x64/arm64 + win32-x64 + linux-x64）
        │ ② 发布到 benson-album/dsh-desktop Releases
        │   （内容 tar.gz + 平台清单片段 → finalize 合并 latest.json → 同步仓库 main）
        ▼
   设备端检测（③ jsDelivr 拉 latest.json → 按本机 os+arch 匹配）
        │
        ├── 无新版 ────────► 静默（不打扰）
        └── 有新版 ──► 后台下载 tar.gz（④ 镜像择优、失败自动切换）
                          │ sha256 校验 → 解压到候选区
                          ▼
                    提示"新版本已就绪"（⑤ 右下角浮条）
                          │ 点「立即更新」
                          ▼
                    原子替换 → 重启生效（⑥ 失败自动回滚）
```

```
配套：壳发布（手动，节流）━━► 本地 publish-shell.sh 打 mac 壳 + 打 dsh-desktop-v* tag
                                └► build-shell 自动云打包 win/linux ─► 设备端 ⌘U 检测到新壳 → 下载页
```

各产品文档含**功能级流程图**：PRD v0.2.0（检测/下载/替换流程）、PRD v0.3.0（壳发布流程）。

## 产品文档（PRD）

| 文档 | 说明 |
|---|---|
| [PRD-DSH-desktop-shell-v0.1.0.md](./prd/PRD-DSH-desktop-shell-v0.1.0.md) | 产品需求：背景/目标/用户场景/FR-D1~D7/NFR/架构/验收/风险/路线图/变更记录 |
| [PRD-DSH-release-download-upgrade-v0.2.0.md](./prd/PRD-DSH-release-download-upgrade-v0.2.0.md) | 产品需求（✅ 已确认 2026-08-20）：产物下载式自动升级——发布者打包上传 GitHub Releases，app 下载产物升级；源码构建式保留为可选通道 |
| [PRD-DSH-shell-release-v0.3.0.md](./prd/PRD-DSH-shell-release-v0.3.0.md) | 产品需求（✅ 已确认 2026-08-21）：壳包发布专项——壳与内容包分离发布，mac 本地双架构 + win/linux CI 打包 |
| [PRD-DSH-cloud-sync-v0.5.0.md](./prd/PRD-DSH-cloud-sync-v0.5.0.md) | 产品需求（📋 草案待评审 2026-08-24）：本地会话与项目云端同步——会话帧级增量同步 + workspace 同步 + 加密 + GitHub 私有仓库载体 |

## 技术文档（Technical）

| 文档 | 说明 |
|---|---|
| [dsh-desktop-shell-v0.1.0.md](./technical/dsh-desktop-shell-v0.1.0.md) | 技术方案：进程拓扑/目录/壳集成/沉浸式/图标/升级管线/菜单本地化/调试/测试/风险 |
| [dsh-release-download-upgrade-v0.2.0.md](./technical/dsh-release-download-upgrade-v0.2.0.md) | 技术方案（✅ 已确认 2026-08-20）：产物下载式升级——发布脚本/更新清单/检测下载校验解压/替换回滚复用/通道抽象/自动发布流水线/多架构跨平台预留 |
| [dsh-shell-release-v0.3.0.md](./technical/dsh-shell-release-v0.3.0.md) | 技术方案（✅ 已确认 2026-08-21）：壳包发布——publish-shell.sh/electron-builder win+linux/build-shell CI/安装指引 |
| [dsh-settings-page-v0.4.0.md](./technical/dsh-settings-page-v0.4.0.md) | 技术方案（✅ 已确认 2026-08-22）：应用设置页——菜单 ⌘,、分类配置（更新/目录/GitHub/工具链/dsh 语言/关于）、参考 dsh 设置弹窗样式、沉浸式窗口 |
| [dsh-cloud-sync-v0.5.0.md](./technical/dsh-cloud-sync-v0.5.0.md) | 技术方案（📋 草案待评审 2026-08-24）：会话与项目云端同步——帧级增量协议、AES-GCM 按帧加密、workspace LWW + 路径映射、GitHub Provider、壳层 sync 模块 |
| [development-guide-v0.1.0.md](./technical/development-guide-v0.1.0.md) | **开发指南**：环境要求/构建打包命令/测试方法/架构速览/**18 条已知坑位与修复记录（K-1~K-18）**/10 条设计约束/发布节奏约定/发布流程 |

## 阅读顺序（第三方开发者）

1. **PRD** — 先理解产品要什么（FR/NFR/验收）
2. **technical** — 再看技术怎么实现（架构/模块）
3. **development-guide** — 最后按指南动手：**§6 坑位先读**（避免重蹈覆辙）、§3 构建命令、§4 测试、§7 设计约束

## 归档

- `docs/archive/`：早期分散的设计文档（已被上述文档合并取代）。
