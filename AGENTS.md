# dsh-desktop 项目协作约定

## 语言要求（最高优先级，对任何会话/任何 AI 助手生效）

1. **AI 的交互语言 = dsh-app 界面语言**（即用户在 GUI 设置 → 语言里选择的语言），判定顺序：
   - 读 `~/.dsh/settings.yaml` 的 `locale.preference`：`zh` → 用中文；`en` → 用 English
   - 未设置时，跟随系统语言（macOS `AppleLanguages` 以 zh 开头 → 中文，否则 English）
   - 判定后：**思考过程、回复、文档正文、变更记录、进度说明一律使用该语言**
2. 技术术语与代码标识符可保留英文原样（如 `electron-builder`、`pnpm`、`BrowserWindow`、变量名），但**叙述语言**必须与界面语言一致。
3. 新会话、新对话开始工作前，先读本文件（以及 `docs/README.md` 的文档索引），并按第 1 条判定当前语言，再开始任何任务。
4. 违反此要求时，用户有权要求立即修正；修正后继续遵守。用户在对话里显式指定语言时，以用户指定为准（优先级高于界面设置）。

## 其他约定

- 任何需求变更：**先出产品设计文档（docs/prd/）与开发设计文档（docs/technical/），用户确认后才动代码**。
- 代码、文档、测试同步维护（见 `docs/technical/development-guide-v0.1.0.md`）。
- 文档正文语言与界面语言一致（当前默认中文；界面切 English 时新增/修改的文档用 English）。
