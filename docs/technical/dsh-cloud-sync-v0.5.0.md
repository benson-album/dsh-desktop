# 开发设计文档 — 会话与项目云端同步（Cloud Sync）

- 版本：v0.5.0（📋 草案，待评审）
- 日期：2026-08-24
- 状态：**草案**（功能规划，未确认；确认后才动代码）
- 关联：PRD [PRD-DSH-cloud-sync-v0.5.0](../prd/PRD-DSH-cloud-sync-v0.5.0.md)（🔄 同版本）；设置页 [dsh-settings-page-v0.4.0](./dsh-settings-page-v0.4.0.md)（在设置窗口扩展「同步」分类）

---

## 1. 设计原则

1. **壳层实现，harness 零改动**：同步引擎作为 Electron 主进程模块（`src/sync.ts`），以文件级读写 `DSH_HOME`（默认 `~/.dsh`），不改 harness 的会话格式与写入路径；harness 内容升级（`dsh-v*`）不影响同步。
2. **本地始终是权威**：pull 只"追加/覆盖到本地可验证状态"，绝不主动删除本地数据；删除同步默认关闭（见 §8 墓碑）。
3. **增量优先**：会话文件是 append-only 的 zstd 帧流，增量=只传输新增帧的字节段；workspace 元数据小，整文件 LWW。
4. **加密默认开启**：任何进入云端仓库的字节都是密文（会话按帧加密，workspace 整包加密）；密钥只在系统钥匙串。
5. **幂等可重试**：任一步失败不破坏本地与云端，下次同步从头对比（对比是纯本地扫描 + 远端清单），无中间状态文件依赖。
6. **可观测**：同步过程有日志（`~/dsh-app/logs/sync-<ts>.log`）与设置页状态展示，便于排查。

---

## 2. 数据现状与同步范围

### 2.1 数据现状（调研结论，2026-08-24）

**会话（session）**——`<DSH_HOME>/sessions/`：

```
~/.dsh/sessions/
├── <projectKey(cwd)>/            # 如 --Users-chinasir-Documents-temp--
│   └── <encodeSegment(sessionId)>/
│       └── session.jsonl.zstd    # header 行 + 事件行，append-only，zstd 帧流
```

- `projectKey`：路径分隔符 → `-`，不安全字符 → `~XXXX`（UTF-16 code unit 十六进制大写补 4 位），`--<slug 截断 251>--` 包裹（harness `packages/session/session-persistence-jsonl/src/format.ts`）；
- `encodeSegment(sessionId)`：同规则逐 code unit 转义（`.`/`..` 特判 `~002E`）；
- 文件内容：第一行 header（`{"type":"session","version":0,"id":"session-…","createdAt":…,"cwd":…,"delegationDepth":…}`），其后事件行带连续 `seq`；物理编码为**完整 zstd 帧拼接**（checksumFlag=1，每次 durable append 写一个完整帧），支持按帧切分/增量；
- 会话 ID 形如 `session-<uuid>`；session 目录里未来可能放会话级附属文件（当前仅 `session.jsonl.zstd`）。

**项目（workspace）**——`<DSH_HOME>/storages/`：

```
~/.dsh/storages/
├── workspace.json            # 权威注册表（见下）
└── session_projcache.json    # 会话-项目投影缓存（可重建，不同步）
```

- `workspace.json` 结构（harness `packages/workspace/workspace/src/spec.ts`）：
  - `global`：`initialized` / `workspaceIds`（显示顺序）/ `archivedSessionIds`（归档集）/ `pendingMutation`；
  - `tables.workspaces`：`<workspaceId>` → `{ path, title, sessionIds[], createdAt, updatedAt }`；
  - **`path` 是 `fs.realpath` 规范化的绝对路径**——跨设备必然不同，必须路径映射；
  - workspaceId 为 UUID；sessionIds 数组顺序即展示顺序。

**其他**：`~/.dsh/settings.yaml`（设置）、`.credentials.yaml`（凭据，敏感）、`.anonymous-user-id`（遥测身份）、`profiles/`（web 插件配置）。

### 2.2 同步范围（黑/白名单）

| 类别 | 对象 | 同步 | 说明 |
|------|------|------|------|
| 会话 | `sessions/**/session.jsonl.zstd` | ✅ | 增量（新帧字节段） |
| 会话附属 | 会话目录内其他文件（未来） | 🔲 v0.6.0 | 随会话整目录同步 |
| 项目 | `storages/workspace.json` | ✅ | 整文件 LWW + 路径映射 |
| 项目缓存 | `storages/session_projcache.json` | ❌ | 可重建，拉取后 harness 自动重建 |
| 凭据 | `.credentials.yaml` | ❌ 黑名单 | 永不入云 |
| 遥测 | `.anonymous-user-id` | ❌ 黑名单 | 设备特定 |
| 设置 | `settings.yaml` | ❌ 黑名单 | 设备特定（语言等） |
| 插件配置 | `profiles/` | ❌（v0.5.0） | 机器相关，后续评估 |
| 系统文件 | `.DS_Store` 等 | ❌ 黑名单 | 忽略 |

---

## 3. 同步拓扑与 Provider 抽象

### 3.1 拓扑

```
┌─ 设备 A（Mac）─┐        ┌─ 云端载体：GitHub 私有仓库 ─┐        ┌─ 设备 B（Win）─┐
│  ~/.dsh        │  push  │  dsh-sync/                   │  pull  │  ~/.dsh        │
│  sessions/     │ ─────► │   manifest.json              │ ─────► │  sessions/     │
│  storages/     │  pull  │   sessions/*.zstd（密文）     │        │  storages/     │
│  + sync-meta   │ ◄───── │   workspaces/*（密文）        │        │  + sync-meta   │
└────────────────┘        │   conflicts/（密文）          │        └────────────────┘
                          └───────────────────────────────┘
```

- 同步引擎（壳）通过 **SyncProvider** 访问云端；v0.5.0 实现 `GitHubProvider`（私有仓库），接口预留 `LocalFolderProvider`（网盘目录）、`HttpProvider`（自建服务）。
- 同步是"拉取-合并-推送"模型，非实时；设备间通过云端仓库间接交换，无直连。

### 3.2 SyncProvider 接口（草案）

```ts
interface SyncProvider {
  readonly kind: string                                  // 'github' | ...
  init(opts: ProviderOptions): Promise<void>             // 校验凭据/仓库可达
  list(prefix: string): Promise<RemoteEntry[]>           // 列出远端路径+修订号+大小
  get(path: string, rev?: string): Promise<Buffer>       // 读文件（可带修订号做乐观锁）
  put(path: string, data: Buffer, baseRev?: string): Promise<string>  // 写文件，返回新修订号；baseRev 不匹配则抛冲突
  delete(path: string): Promise<void>                    // 删文件（墓碑用）
}
```

- GitHub 实现基于 **REST API**（`GET/PUT /repos/{owner}/{repo}/contents/{path}` + `sha` 做乐观锁），依赖 `@octokit/rest` 或自写最小 REST 客户端（壳当前零运行时依赖，倾向自写最小客户端 + 仅 devDependency 测试）；
- `RemoteEntry`：`{ path, rev(sha), size }`——`rev` 即 GitHub blob sha，天然支持乐观锁与"远端是否有更新"判断；
- 仓库内文件**均按 §5 加密**，Provider 只搬运密文字节，不感知明文。

---

## 4. 会话同步协议（帧级增量）

### 4.1 会话文件物理模型（复用 harness 语义）

- 文件 = 一串**完整 zstd 帧**拼接（每次 durable append 一个帧）；帧头 magic `28 B5 2F FD`，帧尾含内容校验（checksumFlag=1）；
- harness 的读取语义："committed prefix = 完整帧序列"（torn 尾部帧被忽略/修复，见 `readZstdPrefix`）；
- 因此**帧边界即提交边界**：壳端无需解码 JSONL，只需扫描 magic 定位帧边界、记录字节偏移，即可安全增量。

### 4.2 本地同步元数据（sync-meta）

壳在 `<DSH_HOME>/sync-meta/` 记录本地与远端的对齐状态（独立于 harness，harness 不读）：

```
~/.dsh/sync-meta/
├── device.json            # { deviceId, deviceName, platform, createdAt }
├── sessions/
│   └── <sessionId>.json   # 本地侧：{ sessionId, projectKey, fileBytes, frames: [{off,len,sha256}], lastSeq?, updatedAt }
└── workspaces.json        # 本地侧：{ workspaceId: { updatedAt, sha256 } }
```

- `frames` 数组记录已**成功推送**的帧列表（偏移+长度+哈希）；下次推送只需从 `fileBytes` 起扫描新帧；
- `device.json` 是设备身份（UUID），用于 workspace 路径映射字典与冲突副本命名。

### 4.3 云端布局

```
dsh-sync/                          # 仓库根（前缀可配置）
├── manifest.json                  # { schemaVersion, devices: {deviceId: {name, platform, updatedAt}}, lastSyncAt }
├── sessions/
│   ├── <sessionId>.meta.json      # 明文（不敏感）：{ sessionId, header{version,createdAt,cwd,delegationDepth}, deviceId, committedBytes, frameCount, updatedAt }
│   └── <sessionId>.log.zstd       # 密文（按帧加密后的拼接）
└── workspaces/
    ├── workspace.json             # 密文：权威合并版 workspace 记录 + 各设备路径字典
    └── <workspaceId>.conflict-<ts>.json   # 密文：LWW 被覆盖方的旧版本
```

- **meta 明文、log 密文**：meta 只含 ID/大小/时间（不敏感），用于增量协商（拉取前先看 `committedBytes` 是否大于本地，决定是否下载）；log 是会话正文，必须密文；
- 会话按 `<sessionId>` 扁平存放（会话归属由 header.cwd + workspace.sessionIds 表达，云端不需要 projectKey 目录）；
- `.meta.json` 的 `header.cwd` 参与路径映射（见 §6.2）。

### 4.4 同步算法（会话）

```
pushSession(sessionId):
  local  = 本地文件（稳定读取：两次 stat 字节一致；否则跳过该会话）
  meta   = 读远端 <id>.meta.json（无 → 全量新会话）
  remoteCommitted = meta.committedBytes
  若 remoteCommitted > 本地已推送字节 且 本地有新帧 → 冲突（见 §7）
  扫描本地文件从 min(fileBytes, 已推送偏移) 起的新完整帧 → 逐帧 AES-GCM 加密
  PUT 追加到 <id>.log.zstd（baseRev = 远端当前 sha；不匹配 → 冲突）
  PUT 更新 <id>.meta.json（committedBytes/frameCount/updatedAt）
  更新本地 sync-meta frames 索引

pullSession(sessionId):
  meta = 读远端 <id>.meta.json
  if meta.committedBytes <= 本地文件已提交字节 → 无需拉取
  GET <id>.log.zstd（range 从本地已提交字节起，GitHub API 不支持 range →
      整文件拉取后按偏移切片；文件大时考虑后续 provider 支持 range）
  解密新帧 → 校验：帧哈希 + 末尾 seq 连续性（解码最后一帧 JSONL 尾部即可，无需全解）
  追加到本地 session.jsonl.zstd（原子：tmp + rename 保证 harness 读不到半帧）
  更新本地 sync-meta
```

- **原子追加**：本地写用"读旧文件 + 新文件（旧字节+新帧）+ rename"；harness 是文件级 append，rename 替换瞬间 harness 若正在 append 可能丢失一次写入——因此**harness 运行中（后端存活）时，跳过对活跃会话的 pull 追加**，标记"待 harness 退出/会话关闭后执行"；harness 未运行时（壳启动早期/后端重启窗口）正常执行。v0.6.0 可改为 harness 侧加同步钩子（需要 harness 改动，本版不做）。

### 4.5 删除与归档

- **归档**：`archivedSessionIds` 随 workspace.json 同步（§6）；
- **删除（墓碑）**：默认**关闭**（设置项 `syncDeleteSessions`，默认 false）。开启后，本地删除会话 → 云端 meta 标记 `deleted: true` + 设备/时间 → 其他设备拉取时移除本地会话并保留 `.conflict` 式备份？——不，删除就是删除，但**本机删除动作不上传墓碑，除非用户显式开启**（防误删远端）。v0.5.0 默认只增不改删。

---

## 5. 加密方案

### 5.1 算法与粒度

| 项 | 选择 | 说明 |
|----|------|------|
| 算法 | AES-256-GCM | 认证加密，Node 内置 `crypto`，零新依赖 |
| 粒度 | 会话：**按 zstd 帧加密**（每帧独立 nonce）；workspace：整文件加密 | 帧级独立 → 增量同步的每个新帧可独立解密，不必解密旧帧 |
| nonce | 12 字节随机，密文前置 `nonce || tag || ct` | 帧即"包"：`[12B nonce][16B tag][ct…]` |
| 密钥 | 256-bit 主密钥（数据加密密钥 DEK） | DEK 由用户口令经 PBKDF2-SHA256（60w 迭代）派生，或随机生成 |

### 5.2 密钥管理（壳层）

```
用户口令（首次设置时输入，可留空=不加密正文？——不，默认强制口令）
   │ PBKDF2-SHA256(salt, 600_000 iters)
   ▼
DEK（256-bit）──► Electron safeStorage.encryptString(base64(DEK)) ──► 系统钥匙串
                                                                    （macOS Keychain / Windows DPAPI / Linux libsecret）
```

- **口令不落盘**：只存 `salt`（明文，`sync-meta/crypto.json`）+ 钥匙串里的密文 DEK；
- 每次同步会话从钥匙串解密 DEK（`safeStorage.decryptString`），内存中使用，不写日志；
- 口令遗忘：设置页「重设口令」→ 用旧 DEK 解密云端清单后逐个重加密（或直接提示"重设后旧数据需重新全量推送"，v0.5.0 采用后者，简单）；
- **meta 文件不加密**（只含 id/大小/时间）；workspace.json、会话 log **必须加密**；
- GitHub Token：同样 `safeStorage` 保存，设置页不回显。

---

## 6. 项目（workspace）同步

### 6.1 workspace.json 合并（LWW）

- 云端存一份**权威 workspace.json**（密文）；
- 每次同步：本地读 `storages/workspace.json` → 与云端比对（内容 sha256 + `global` 层无 `pendingMutation` 时）：
  - 云端不存在 → 推送本地；
  - 相同 → 跳过；
  - 一方领先（另一侧没有新变更）→ 取新者，覆盖旧侧时**旧版本先存入云端 `workspaces/<id>.conflict-<ts>.json`**（密文），本地旧版本同样留 `.conflict-<ts>` 副本；
  - 双方都有变更（sha 均不同于云端）→ 冲突弹窗（FR-S5.2）。
- 简化前提：harness 写 workspace.json 是整文件原子写（storage 域有 pendingMutation 崩溃保护），LWW 不会产生半写状态；
- v0.6.0 增强：跨设备 `sessionIds` **集合合并**（并集 + 按 updatedAt 排序），本版不做。

### 6.2 路径映射（跨设备核心难点）

workspace 记录里的 `path` 是设备 A 的绝对路径（`fs.realpath` 结果），设备 B 上必然不存在。

**云端结构**（合并进 workspace.json 密文包）：

```jsonc
{
  "version": 2,                       // workspace.json 原始 global.version 语义保留
  "global": { /* 原始 global 字段 */ },
  "tables": { "workspaces": { /* 原始记录 */ } },
  "syncPathMap": {                    // 同步扩展段（harness 不读，壳读）
    "<workspaceId>": {
      "<deviceA>": "/Users/alice/proj",
      "<deviceB>": "D:\\work\\proj"
    }
  }
}
```

**拉取侧处理**：

1. 对每个 workspace：`path` 用 `fs.realpath` 验证本机存在性；
2. 存在 → 直接可用（sessionIds 照常挂载）；
3. 不存在 → 查 `syncPathMap[workspaceId][本机 deviceId]`：有 → 用映射路径；无 → 弹窗询问"该项目在设备 A 指向 `<原路径>`，请选择本机对应目录"，选择后写入 `syncPathMap`（并随下次推送上传，贡献给其他设备）；
4. 映射在 `workspace.json` 落盘前改写 `tables.workspaces[id].path`（壳写回 `storages/workspace.json`，harness 重新打开即用映射路径），**云端保留原 path + 字典**（不覆盖其他设备的映射）。

> 注意：改写 `path` 会让本地 workspace.json 与云端内容不同——因此壳在本地写回时，把改写后的记录作为"本设备视图"单独落盘（`sync-meta/workspaces.local.json`），`storages/workspace.json` 仅在本设备路径确实存在时按原样同步；避免"改写-再推送-污染字典"的循环。

### 6.3 会话归属恢复

- 拉取会话后，依据云端 workspace 的 `sessionIds` + 映射后的路径，把会话文件落到本地 `<projectKey(映射路径)>/<sessionId>/`；
- 无归属（孤儿会话，header.cwd 无对应 workspace）→ 落到 `_no-cwd`（harness 既有兜底目录），会话列表仍可见；
- `session_projcache.json` 不动，harness 下次冷读自动重建（该缓存有 fail-soft 自愈）。

---

## 7. 冲突处理

| 场景 | 判定 | 处理（v0.5.0） |
|------|------|----------------|
| 会话：本端有新帧 且 远端也有新帧（远端 `committedBytes` 推进过、本地也推进过） | push 前对比 `committedBytes` + 本地已推送偏移 | 弹窗「云端会话 X 已有新内容，本机也有新内容」→ 选 A 以本机为准（本机帧 push 覆盖，远端旧帧段存云端 conflicts/）或 B 以云端为准（拉取远端完整帧流覆盖本地，本地旧帧段存 `.conflict-<ts>`） |
| 会话：仅一端有新帧 | 单向推进 | 正常增量，无冲突 |
| workspace：双向变更 | 双方 sha 均 ≠ 云端 | 弹窗选择保留方，被覆盖方留 conflict 副本（云端+本地各一份） |
| workspace：单向前进 | 一方 sha = 云端 | LWW 覆盖，被覆盖方留 conflict 副本 |
| GitHub `baseRev` 不匹配（乐观锁） | PUT 返回 409 | 视为冲突，走同一弹窗流程 |

- **conflict 副本**命名：`<原名>.conflict-<YYYYMMDD-HHmmss>-<deviceId 短>`；
- 冲突绝不自动覆盖：弹窗默认建议"以云端为准"（云端通常更新）但由用户决定；
- 所有冲突均有日志（`~/dsh-app/logs/sync-*.log`）。

---

## 8. 壳层集成（Electron 主进程）

### 8.1 新增模块

| 文件 | 职责 |
|------|------|
| `src/sync.ts` | SyncEngine：scan / diff / pull / push / merge / 冲突队列 / 状态机；日志 |
| `src/sync-providers.ts` | `SyncProvider` 接口 + `GitHubProvider`（REST + 乐观锁 + 多路径） |
| `src/sync-crypto.ts` | AES-256-GCM 帧加解密、PBKDF2 派生、safeStorage 密钥存取 |
| `src/sync-zstd.ts` | zstd 帧边界扫描（magic `28 B5 2F FD`）、帧切分、torn 帧检测（不做完整解码） |
| `src/sync-ipc.ts`（或并入 preload） | 同步 IPC 通道 |
| `src/sync-queue.ts`（可选） | 串行同步队列（避免手动+启动+自动并发） |

### 8.2 改动点

| 位置 | 改动 |
|------|------|
| `src/main.ts` | 菜单加「立即同步」（⌘⇧S）；`app.whenReady` 后若启用同步 → 后台启动拉取（不阻塞窗口）；后端 stop/start 事件挂同步暂停/恢复 |
| `src/preload.ts` | 暴露 `sync.getStatus()` / `sync.runNow()` / `sync.setConfig(patch)` / `sync.resolveConflict(id, choice)` / `sync.mapWorkspace(id, path)` |
| `src/settings.html` + `settings.json` | 新增「同步」分类：开关、GitHub 仓库/Token、加密口令设置、设备名、上次同步时间、立即同步按钮、冲突/失败列表 |
| `src/upgrade.ts` | 无改动（同步独立于升级管线） |
| `package.json` | 运行时零新依赖（Node crypto + 自写 REST）；devDependency 视测试需要加 `@octokit/rest` mock 或直接用 fetch 测试 |

### 8.3 settings.json 新增段（草案）

```jsonc
{
  "sync": {
    "enabled": false,
    "provider": "github",
    "github": { "repo": "owner/dsh-sync", "tokenStored": true },  // token 本体在钥匙串
    "encryption": { "salt": "<base64>", "keyInKeychain": true },
    "deviceName": "MacBook-Pro",
    "autoPullOnStart": true,
    "syncDeleteSessions": false,
    "syncPrefix": "dsh-sync"
  }
}
```

### 8.4 与 harness 生命周期协作

- **harness 运行中**：活跃会话（最近 N 分钟有写入）只 push 不 pull 追加；workspace.json 在 harness 写入窗口（有 `pendingMutation` 或刚写）跳过本轮；
- **harness 停止/重启窗口**：壳持有后端控制权（`startBackend/stopBackend`），可在重启窗口完成 pull 追加；
- 同步模块自身崩溃不影响 harness：全部文件操作带 try/catch + 日志，失败即停（不重试风暴）。

---

## 9. 测试计划

1. **单元**：
   - `sync-zstd`：帧边界扫描（多帧拼接/半帧/torn 尾部）、偏移索引；
   - `sync-crypto`：帧加解密往返、篡改检测（tag 失败）、PBKDF2 派生一致性；
   - 增量 diff：构造 append 前后的文件对，断言只传新帧；
   - 冲突判定：单边/双边推进的矩阵；
   - workspace 合并：LWW 各分支 + conflict 副本生成；
   - 路径映射：存在/不存在/已映射/字典贡献。
2. **集成（本地假仓库）**：`GitHubProvider` 用本地 HTTP mock（或临时 git 裸仓库）模拟 REST，跑"双设备同步"端到端：A push → B pull → 打开会话（调 harness `loadStored`/`readRaw` 校验 seq 连续）。
3. **真实验收**：按 PRD §4 验收标准逐条（双机实测、增量抓包、密文验证、冲突流程、黑名单、回归）。
4. **回归**：现有单测（`pnpm test`）、冒烟（`npm run smoke`）、设置页回归。

---

## 10. 实施顺序（评审确认后）

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | `sync-zstd.ts` 帧扫描 + 单测 | 无 |
| 2 | `sync-crypto.ts` 加密 + safeStorage + 单测 | 无 |
| 3 | `SyncProvider` 接口 + `GitHubProvider`（REST 最小客户端） | 无 |
| 4 | 会话增量 push/pull + sync-meta + 集成测试 | 1-3 |
| 5 | workspace 同步 + 路径映射 + 冲突弹窗 | 4 |
| 6 | 设置页「同步」分类 + 菜单/快捷键 + 启动拉取 | 4-5 |
| 7 | 文档收尾（README/开发指南）+ 验收测试 | 6 |

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| GitHub REST 无 range 下载，大会话全量拉取 | 流量大 | 会话按帧增量推送；拉取先看 meta 决定是否拉；大文件场景 v0.6.0 换支持 range 的 provider |
| harness 活跃写文件时壳读 | torn 帧 | 两次 stat 稳定性检查 + 跳过不完整尾部帧（帧 magic+长度可判）；harness torn 修复兜底 |
| 改写 workspace.path 污染云端字典 | 映射混乱 | 本地视图独立落盘（`sync-meta/workspaces.local.json`），云端只存各设备原始 path |
| 口令遗忘 | 数据不可读 | 重设口令=重新全量推送（旧云端数据标记不可用）；文档提示备份口令 |
| harness 升级改会话格式 | 写入未知格式 | 同步前校验 header.version 与 `SESSION_FORMAT_VERSION`，不匹配跳过并提示 |
| 多设备并发写 | 双向更新 | LWW + 冲突弹窗 + 副本；自动合并 v0.6.0 |
| Token/仓库误配置 | 同步失败 | 失败只影响同步，不影响本地使用；设置页错误提示明确 |

---

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.5.0 | 2026-08-24 | 首次成稿：会话与项目云端同步技术方案（草案）；帧级增量协议、AES-GCM 按帧加密、workspace LWW + 路径映射、GitHub 私有仓库 Provider、壳层 sync 模块设计 |
