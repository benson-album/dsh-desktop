# DeepSeek Harness 桌面壳（dsh-desktop）文档索引

> 文档体系面向**维护者与第三方开发者（含 AI 软件）**：需求 → 技术方案 → 开发指南 → 验证。

## 产品文档（PRD）

| 文档 | 说明 |
|---|---|
| [PRD-DSH-desktop-shell-v0.1.0.md](./prd/PRD-DSH-desktop-shell-v0.1.0.md) | 产品需求：背景/目标/用户场景/FR-D1~D7/NFR/架构/验收/风险/路线图/变更记录 |
| [PRD-DSH-release-download-upgrade-v0.2.0.md](./prd/PRD-DSH-release-download-upgrade-v0.2.0.md) | 产品需求（⏳ 草案）：产物下载式自动升级——发布者打包上传 GitHub Releases，app 下载产物升级；源码构建式保留为可选通道 |

## 技术文档（Technical）

| 文档 | 说明 |
|---|---|
| [dsh-desktop-shell-v0.1.0.md](./technical/dsh-desktop-shell-v0.1.0.md) | 技术方案：进程拓扑/目录/壳集成/沉浸式/图标/升级管线/菜单本地化/调试/测试/风险 |
| [dsh-release-download-upgrade-v0.2.0.md](./technical/dsh-release-download-upgrade-v0.2.0.md) | 技术方案（⏳ 草案）：产物下载式升级——发布脚本/更新清单/检测下载校验解压/替换回滚复用/通道抽象 |
| [development-guide-v0.1.0.md](./technical/development-guide-v0.1.0.md) | **开发指南**：环境要求/构建打包命令/测试方法/架构速览/**13 条已知坑位与修复记录**/10 条设计约束/后续优化/发布流程 |

## 阅读顺序（第三方开发者）

1. **PRD** — 先理解产品要什么（FR/NFR/验收）
2. **technical** — 再看技术怎么实现（架构/模块）
3. **development-guide** — 最后按指南动手：**§6 坑位先读**（避免重蹈覆辙）、§3 构建命令、§4 测试、§7 设计约束

## 归档

- `docs/archive/`：早期分散的设计文档（已被上述文档合并取代）。
