# 文档地图

> **最后更新**：2026-11-21 · **适用版本**：0.6.6
> 这份索引回答三件事：**遇到问题该看哪份文档、哪份文档说了算、改完代码要同步哪里。**
> 面向 AI 代理与新贡献者。先读 [`AGENTS.md`](../AGENTS.md)，再按本文的阅读顺序进入。

---

## 1. 阅读顺序（agent coding）

| 顺序 | 文档 | 读它是为了 |
| --- | --- | --- |
| 1 | [`AGENTS.md`](../AGENTS.md) | 不可破坏的不变式、命令、陷阱、禁区 |
| 2 | [`docs/architecture.md`](./architecture.md) | 分层、依赖方向、数据流、扩展手册、结构性债务 |
| 3 | [`docs/data-model.md`](./data-model.md) | 身份语义、落盘文件、迁移规则 |
| 4 | [`docs/ipc.md`](./ipc.md) | 跨进程契约怎么改、授权规则 |
| 5 | [`docs/external.md`](./external.md) | 允许碰哪些外部服务、依赖边界 |
| 6 | [`docs/quality.md`](./quality.md) | 验证基线、测试分层、DoD、棘轮 |
| 7 | [`TODO.md`](../TODO.md) | 现在做什么、哪些已完成、哪些明确不做 |
| 8 | [`ROADMAP.md`](../ROADMAP.md) | 为什么做、优先级、版本退出标准 |
| 9 | [`README.md`](../README.md) | 用户可感知的行为与边界 |
| 10 | [`CHANGELOG.md`](../CHANGELOG.md) | 每个版本交付了什么 |
| 11 | [`CODE_REVIEW.md`](../CODE_REVIEW.md) | 技术结论与修复证据（历史快照） |

**只做一件事时**：改代码前读 1–6；改产品方向读 7–8；写提交说明读 10。

---

## 2. 单一事实源

同一件事只允许一个地方说「算数」，其余地方只能是快照或引用。

| 事实 | 唯一事实源 | 其他文档的角色 |
| --- | --- | --- |
| 版本号 | `package.json` 的 `version` | README / AGENTS / ROADMAP / CHANGELOG 只引用，由 `docsConsistency.test.ts` 校验一致 |
| 现在能做什么 | 代码 + [`README.md`](../README.md) | ROADMAP 只谈方向，不重复功能清单 |
| 任务状态 | [`TODO.md`](../TODO.md) | ROADMAP 的版本节只写退出标准；CHANGELOG 只写已交付 |
| 产品方向 / 优先级 | [`ROADMAP.md`](../ROADMAP.md) | TODO 不得自行改变优先级 |
| 已交付事实 | [`CHANGELOG.md`](../CHANGELOG.md) | 历史日期与数字是快照，不回改 |
| 技术审查结论 | [`CODE_REVIEW.md`](../CODE_REVIEW.md) | 正文保留当时判断，状态看 §0.1 |
| 架构、分层、依赖方向 | [`docs/architecture.md`](./architecture.md) + `layering.test.cjs` | 口头约定不算数，测试才算 |
| 领域类型与字段 | `src/types/index.ts` | 文档只解释「为什么」，不复制字段表 |
| 落盘文件与迁移规则 | [`docs/data-model.md`](./data-model.md) + `migrations.cjs` | 文档解释职责与失败语义 |
| IPC 通道清单 | `tests/main-process/ipc-contract.test.cjs` 的 `CHANNELS` | [`docs/ipc.md`](./ipc.md) 只讲规则，不列通道名 |
| 外部依赖清单 | `package.json` | [`docs/external.md`](./external.md) 只讲边界与理由 |
| 验证基线 | [`docs/quality.md`](./quality.md) + `package.json` scripts | 文档不写死测试数量，以命令输出为准 |
| 关键决策 | [`docs/decisions.md`](./decisions.md) | 决策变更先加 ADR，再改代码 |

### 冲突处理

1. 方向冲突 → `ROADMAP.md`。
2. 任务状态冲突 → `TODO.md`。
3. 行为冲突 → 代码 + `README.md`，并立即修正文档。
4. 数字冲突 → 以命令输出为准；文档里的历史数字标注「当时口径」。
5. 不要靠「以后再同步」留下互相矛盾的文档。

---

## 3. 文档职责边界

| 文档 | 回答什么问题 | **不回答**（去哪看） | 什么时候必须改 |
| --- | --- | --- | --- |
| `AGENTS.md` | 代理与新人怎么安全地改 | 细节分层（→ architecture / ipc / data-model） | 命令、不变式、陷阱、禁区变化 |
| `architecture.md` | 怎么分层、改一处要动哪里 | 字段（→ types）、通道名（→ 冻结清单） | 目录 / 依赖方向 / 扩展流程 / 结构性债务变化 |
| `data-model.md` | 数据以什么为身份、存哪、怎么迁移 | 字段 schema（→ types / store） | 身份语义、落盘文件、迁移规则变化 |
| `ipc.md` | 一个通道要同步哪几处、返回什么 | 通道清单（→ `CHANNELS`） | 契约规则、授权规则变化 |
| `external.md` | 能连什么、为什么只有这些 | 依赖版本（→ `package.json`） | 新增 / 移除外部能力 |
| `quality.md` | 怎么证明没改坏 | 具体测试用例（→ `tests/`） | 命令、测试分层、DoD、棘轮规则变化 |
| `decisions.md` | 为什么是现在这样 | 实现细节 | 关键取舍变化 |
| `README.md` | 用户能做什么、怎么用、边界在哪 | 技术实现（→ docs/） | 功能 / 快捷键 / 配置 / 已知限制变化 |
| `ROADMAP.md` | 为什么做、先做什么、算完成的标准 | 具体任务状态（→ TODO） | 定位、优先级、版本主题变化 |
| `TODO.md` | 具体任务、编号、状态、验收 | 已交付事实（→ CHANGELOG） | 任务开始 / 完成 / 拆分 / 延期 |
| `CHANGELOG.md` | 每个版本交付了什么 | 未交付计划（→ ROADMAP） | 每次发布 |
| `CODE_REVIEW.md` | 技术审查结论与修复证据 | 当前状态索引（→ 本文 §2） | 架构 / 安全 / 重构批次 |
| `archive/` | 历史记录 | — | 只追加，不修改 |

---

## 4. 写作铁律

这四条是「单一事实源」能维持下去的原因，不是文风偏好。

1. **代码能回答的一律不复制**：字段名、通道名、文件清单、数量、行数、默认值、依赖版本。写进去的那一刻就开始漂移。
2. **只写三类内容**：**为什么**（取舍与理由）、**边界**（不做什么、失败怎么表现）、**导航**（改 X 去哪、看哪个文件）。
3. **每篇开头声明**：最后更新、适用版本、事实源路径，以及「本文不回答什么」。
4. **数字不写死**：需要快照时标注日期与口径，并在下一次改动时按快照保留而非回改。

### 头部格式

```text
> **最后更新**：YYYY-MM-DD · **适用版本**：x.y.z
> **事实源**：<代码路径>
```

`docsConsistency.test.ts` 会校验 `docs/` 下每篇都有这一行。

---

## 5. 变更同步（文档侧）

代码侧必改的位置（IPC 五处、持久化、主题令牌、品牌口径）见 [`architecture.md`](./architecture.md) §9。这里只管「哪份文档该改」。

| 你改了 | 必须同步 |
| --- | --- |
| 用户能感知的行为 | `README.md` + `CHANGELOG.md` |
| 任务状态 | `TODO.md`（完成后移入 `archive/`） |
| 方向 / 优先级 | `ROADMAP.md` |
| 分层 / 目录 / 依赖方向 | `architecture.md` |
| 身份语义 / 落盘 / 迁移 | `data-model.md` |
| 契约规则 / 授权规则 | `ipc.md` |
| 外部能力 / 依赖边界 | `external.md` |
| 命令 / 测试分层 / DoD | `quality.md` |
| 关键取舍 | `decisions.md` |
| 文档本身增删 | 本文 + 检查 `AGENTS.md` §6 的链接是否仍成立 |

---

## 6. 目录

```text
docs/
├── README.md            # 本文件：文档地图、单一事实源、写作铁律
├── architecture.md      # 分层、依赖方向、数据流、扩展手册、结构性债务
├── data-model.md        # 身份语义、落盘文件、迁移规则
├── ipc.md               # 跨进程契约、授权、新增通道步骤
├── external.md          # 网络边界、运行时依赖、新增依赖判断
├── quality.md           # 验证基线、测试分层、DoD、棘轮
├── decisions.md         # ADR：关键决策与守卫
└── archive/
    └── todo-completed.md  # TODO 完成存档（只追加）
```

TODO 完成存档见 [`docs/archive/todo-completed.md`](./archive/todo-completed.md)。
