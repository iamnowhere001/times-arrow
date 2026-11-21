# 数据模型与持久化

> **最后更新**：2026-11-21 · **适用版本**：0.6.6
> **事实源**：`src/types/index.ts`（领域类型）、`electron/lib/fingerprint.cjs`（指纹算法）、`electron/main/store.cjs`（写盘）、`electron/main/migrations.cjs`（迁移）

## 本文负责什么

- 身份语义：为什么有两套 id、哪一套能落盘。
- 落盘文件各自的职责、写入者、失败时的行为。
- 结构变更时的迁移规则与「不可丢弃」的中间产物。

**本文不回答**：字段名与完整 schema（读 `src/types/index.ts`）、config 默认值（读 `store.cjs`）、通道与参数（看 [`ipc.md`](./ipc.md)）。文档不复制这些，因为它们每天都在变，而"为什么"不变。

---

## 1. 两套 id，只有一个能落盘

| id | 是什么 | 生命周期 | 能用在哪 |
| --- | --- | --- | --- |
| `Photo.id` | 会话内自增 / 随机 id | 单次运行 | 仅内存中的列表 key、选择态 |
| `Photo.fileId` | **内容指纹**：`sha256(体积 + 头尾各 64KB)` 截 128 bit | 跨会话、跨重命名与移动 | **所有持久化** |

**为什么**：用户会改名、会挪目录、会删掉再导入。按路径记录的话，任何一次整理都会让收藏 / 标签 / 时间修正全部失联——这是本项目早期真实踩过的坑。

**不变式**：

1. 收藏、隐藏、标签、时间修正、智能相簿、AI 结果、忽略的重复组，一律以 `fileId` 为键。
2. 不要重新引入「按路径记录 + 改名时 rekey」那条补丁链。它已经被 `fileId` 取代，残留代码只会制造两套真相。
3. `fileId` 在渲染层是只读的：由主进程算、由主进程随扫描结果下发，渲染层不重算。

**降级情形**：拖放进来、拿不到磁盘路径的照片没有 `fileId`，因此不可管理、不参与跨重启的记忆。这是刻意取舍，不要为它发明第二套身份。

---

## 2. 落盘文件

全部位于 macOS 的 `~/Library/Application Support/PhotoMinder/`（`userData`）。

| 文件 / 目录 | 负责什么 | 写入者 | 失败或损坏时 |
| --- | --- | --- | --- |
| `config.json` | 标注数据 + 来源 + 视图偏好 + 更新偏好 | 主进程 `store.cjs` | 解析失败备份为 `config.json.corrupt-<时间戳>`，启动时 Toast 告知位置 |
| `config.json.bak` / `.bak.1` | 上两版配置 | 写盘前轮转 | 手工回退用 |
| `operation-log.jsonl` | 重命名 / 删除 / 移动 / 导出日志 | `data-assets.cjs`，追加式 | 有上限，超出滚动丢弃最旧 |
| `ai-cache.json` | AI 分析结果缓存 | `ai.cjs` | 有上限，超出淘汰最早 |
| `ai-config.json` | AI 服务配置（含明文 Key） | `ai.cjs` | 仅主进程读取；读取接口只回掩码 |
| `ai.env` | 环境变量兜底文件 | 用户手写 | 优先级最低 |
| `thumbnails/` | 磁盘缩略图缓存 | `media-pipeline.cjs` | 可整体删除，按需重建 |
| `faces.json` | 人像索引：人脸框、特征向量、人物分组与命名 | `face/service.cjs`（走 `store.cjs`） | 解析失败按空索引处理并提示重新扫描；重扫可重建 |
| `faces/covers/` | 人像封面（160×160 JPEG） | `face/service.cjs` | 可整体删除；缺图时显示占位，重扫补齐 |
| `models/buffalo_sc/` | 人脸模型（SCRFD + ArcFace onnx） | `face/model-store.cjs` | 缺失时人像页引导重新下载；下载先校验 SHA256 再解压 |

**写盘规则（不可绕过）**：

- 一律走 `store.cjs`：临时文件 + `rename` 原子替换，写前轮转备份。不要自己 `writeFile`。人脸索引 `faces.json` 已按这条规则接入。
- 「读 - 改 - 写」必须在同一把锁内（`withStoreLock`），否则并发写会互相覆盖。人脸扫描是逐张串行的，写索引集中在批次结束时发生。
- 任何写盘失败都要有用户可见反馈，不得静默吞错。
- 人脸特征也是按 `fileId` 记录的：照片重命名 / 移动不会丢失人物归属；内容变了（`fileId` 变）就当作新照片重扫。

字段级 schema 不在这里维护：加字段时看 `src/types/index.ts` 与 `store.cjs` 的默认值。

---

## 3. 结构变更与迁移

**决策顺序**：

1. 能不能挂在现有结构下？能就不加迁移——迁移是最贵的改动。
2. 必须改结构时，在 `migrations.cjs` 增加版本步骤，并在 `tests/main-process/migration-version-guard.test.cjs` 补断言。
3. 迁移必须是**幂等**的：已是新版本的数据不得被二次迁移。
4. 迁移产生的 `orphans` 是给「路径重连」用的，**不得静默丢弃**。
5. 迁移失败要留下可回退的备份，并明确告知用户，而不是让应用带着半迁移数据继续跑。

**版本标识**只认代码里的迁移版本号，不要在文档里记「当前是 vN」——那是必然漂移的数字。

---

## 4. 改这里之前

| 你要做 | 必须先确认 |
| --- | --- |
| 新增一种标注 | 能挂在 `config.json` 现有结构下吗？键是 `fileId` 吗？ |
| 改 `fileId` 算法 | 等同于让全部历史标注失联。需要迁移或明确放弃旧数据，属于「先问维护者」清单 |
| 新增落盘文件 | 有上限吗？损坏时怎么恢复？用户怎么知道？ |
| 改备份 / 恢复语义 | 用户可能正靠它救数据。先看 [`decisions.md`](./decisions.md) ADR-003 |
| 改人脸模型 / 聚类阈值 | 特征维度与阈值必须一起看；阈值调高会多分组（可合并），调低会把不同人并到一起。先看 [`decisions.md`](./decisions.md) 人脸一节 |

## 5. 守卫

| 测试 | 锁住什么 |
| --- | --- |
| `tests/main-process/storage-recovery.test.cjs` | 损坏备份 + 不阻塞启动 + 告知用户 |
| `tests/main-process/migration-version-guard.test.cjs` | 新版本不被重复迁移、标注不被清空 |
| `tests/main-process/data-assets.test.cjs` | 指纹与路径无关、导入导出、重连 |
| `tests/unit/photoTime.test.ts` | 时间语义的唯一入口（迁移会用到） |
