# 文档地图

> 这份索引回答三件事：**遇到问题该看哪份文档、哪份文档说了算、改完代码要同步哪里。**
> 面向 AI 代理与新贡献者。先读 [`AGENTS.md`](../AGENTS.md)，再按本文的阅读顺序进入。

---

## 1. 阅读顺序（agent coding）

| 顺序 | 文档 | 读它是为了 |
| --- | --- | --- |
| 1 | [`AGENTS.md`](../AGENTS.md) | 不可破坏的不变式、命令、常见陷阱 |
| 2 | [`docs/architecture.md`](./architecture.md) | 分层、依赖方向、扩展手册、结构性债务 |
| 3 | [`docs/quality.md`](./quality.md) | 验证基线、测试分层、DoD、棘轮规则 |
| 4 | [`TODO.md`](../TODO.md) | 现在做什么、哪些已完成、哪些明确不做 |
| 5 | [`ROADMAP.md`](../ROADMAP.md) | 为什么做、优先级、版本退出标准 |
| 6 | [`README.md`](../README.md) | 用户可感知的行为与边界 |
| 7 | [`CHANGELOG.md`](../CHANGELOG.md) | 每个版本交付了什么 |
| 8 | [`CODE_REVIEW.md`](../CODE_REVIEW.md) | 技术结论与修复证据（历史快照） |

**只做一件事时**：改代码前读 1–3；改产品方向读 4–5；写提交说明读 7。

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
| 架构与依赖方向 | [`docs/architecture.md`](./architecture.md) + `tests/main-process/layering.test.cjs` | 口头约定不算数，测试才算 |
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

| 文档 | 回答什么问题 | 什么时候必须改 |
| --- | --- | --- |
| `README.md` | 现在能做什么、怎么用、边界在哪 | 功能 / 快捷键 / 配置 / 已知限制变化 |
| `ROADMAP.md` | 为什么做、先做什么、做到什么算完成 | 定位、优先级、版本主题变化 |
| `TODO.md` | 具体任务、编号、状态、验收 | 任务开始 / 完成 / 拆分 / 延期 |
| `CHANGELOG.md` | 每个版本交付了什么 | 用户可感知的 Added / Changed / Fixed / Security |
| `CODE_REVIEW.md` | 技术审查结论与修复证据 | 架构 / 安全 / 重构批次 |
| `AGENTS.md` | 代理与新人怎么安全地改 | 命令、约束、入口变化 |
| `docs/architecture.md` | 系统怎么分层、改一处要动哪里 | 目录 / 依赖方向 / 扩展流程 / 结构性债务变化 |
| `docs/quality.md` | 怎么证明没改坏 | 命令、测试分层、DoD、棘轮规则变化 |
| `docs/decisions.md` | 为什么是现在这样 | 关键取舍变化 |
| `docs/archive/` | 历史记录 | 只追加，不修改 |

---

## 4. 写作规则

1. **写「为什么」，不写「是什么」**：代码能回答的，文档不重复。
2. **不写死会漂移的数字**：测试数量、文件行数、模块数量一律以命令输出或目录为准；需要快照时标注日期与口径。
3. **链接优先**：同一段内容只写一次，其余位置放链接。
4. **区分「当前」与「历史」**：历史结论保留原文并标注快照时间，不回改成「现在」。
5. **新增任务先编号**：`N` 当前任务 / `F` 功能 / `K` 已知问题 / `X` 明确延后；编号一旦使用不复用。
6. **完成即归档**：任务完成后从 TODO 活跃区移到 `docs/archive/todo-completed.md`，避免活跃清单越读越长。

---

## 5. 目录

```text
docs/
├── README.md                 # 本文件：文档地图与单一事实源
├── architecture.md           # 系统架构、分层、扩展手册、结构性债务
├── quality.md                # 验证基线、测试分层、DoD、棘轮
├── decisions.md              # ADR：关键决策与守卫
└── archive/
    └── todo-completed.md     # TODO 完成存档（只追加）
```

TODO 完成存档见 [`docs/archive/todo-completed.md`](./archive/todo-completed.md)。
