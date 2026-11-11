# PhotoMinder 代码审查报告

> **当前快照（2026-11-11 · v0.6.2 发布）**：`electron/` 4,232 行（2026-11-06 口径；11-11 另加 `main/crash-report.cjs` / `health.cjs` 与 `probe-rename-targets`）；`src/` 107 个 ts/tsx；`tests/` 三层（单测 379 项 / 主进程 251 项 / Electron 冒烟，CSP 违规 0 / 控制台错误 0）。
> **审查方式**：逐模块通读源码 + 交叉验证（git 跟踪状态、配置项、IPC 契约、真实启动）。
> **严重程度**：**高** = 安全风险 / 数据损坏 / 架构级债务；**中** = 明确的功能或正确性缺陷，或显著抬高维护成本；**低** = 一致性、可读性、局部优化。
> **图例**：✅ 已完成 · 🔶 部分完成 · ⏳ 待做 · ⚠️ 已记录但未改行为（需产品决定）

**这份文档怎么读**

1. **§0.1 是唯一的状态索引**：正文按审查当时的判断保留（不回改，以便追溯为什么这么做），
   状态一律以 §0.1 为准。新增编号时同步更新 §0.1。
2. **§1 是原始发现**（2026-09-15），只保留问题与判断，改进建议已并入 §2 的实施记录。
3. **§2 是修复记录**，按批次摘要；每批只留「改了什么 / 怎么验证 / 边界在哪」，
   代码细节看仓库注释与 git 历史。
4. **§4 是本轮复审**（2026-11-06），编号 `R*`，与正文的 `A/S/C/I/R/U/K/P/F/M/G/N/B/D` 体系并列。

---

## 0. 结论与评分

这是一个**工程质量明显高于平均水准**的 Electron 桌面应用。亮点具体，不是套话：

- **内存治理有真实工程痕迹**：`pm://` 以流式（含 HTTP Range 206）提供原图与磁盘缩略图，从架构上消除了「整图 base64 常驻渲染进程」这个 Electron 照片应用最经典的 OOM 根因；缩略图落盘 + 版本化 key + atime 淘汰；统一 LRU 注册表 + 内存看门狗。
- **长任务可取消、可重入、可恢复**：扫描 `scanId` 取消、重复检测 abort + 指纹缓存复用、跨卷移动 `EXDEV` → 复制 + 删源 + `partial` 中间态 + `priorTargets` 幂等重试、元数据回填的滚动锚点补偿。
- **写盘原子性**：临时文件 + `rename` 替换 + `withStoreLock` 串行化「读-改-写」。
- **注释写「为什么」而非「是什么」**：绝大多数复杂分支都留下了决策依据，这在个人项目中非常罕见。

审查当时的主要问题集中在一个横切面：**Electron 的安全边界被整体让渡**（无沙箱 + 无 CSP + `pm://` 无白名单 + IPC 不校验路径），叠加后等于本机任意文件的读写删。其次是没有 lint、没有测试的架构级债务。

> **两个短板都已补齐**（详见 §2）。安全链从「任意文件」收敛到「仅授权目录内」，实测改动量以数十行计；
> `App.tsx` 3707 → 1322 行，`utils/index.ts` 1024 → 86 行 barrel，建成三层验证与 lint 护栏。

**综合评分（10 分制）**

| 维度 | 审查时 | 当前 | 说明 |
|---|---|---|---|
| 架构设计 | 7.0 | **8.6** | hooks + 视图路由 + 领域模块；剩余债务在组件层（两套虚拟化、Modal 基座） |
| 代码质量与可读性 | 7.5 | **8.2** | 命名与注释优秀；空状态文案与单条目动作已从 App 抽出（§4） |
| 性能 | 8.0 | **8.5** | 搜索索引、地名 LRU、地名拆包已落地，未见回退 |
| 安全 | 4.5 | **8.5** | 沙箱 / CSP / 白名单 / 体积闸门 / 原子写盘全部到位；`safeStorage` 未做（X1，自用定位下可接受） |
| 错误处理与边界 | 7.0 | **8.3** | IPC 协议统一、分层 ErrorBoundary；本轮修掉两处分流失效（§4 R1/R2） |
| 工程化 | 5.0 | **7.5** | 三层测试 + 双层 lint + Prettier；缺 CI |
| **加权总分** | **6.8** | **8.3** | 剩余为组件层收敛、CI 与 `strict` |

---

## 0.1 发现项状态总览

**状态列以测试或构建产物为凭，不是口头结论。** 本轮新增的 `R*` 见 §4，不重复列入本表。

> 注：§6 的 `K1` / `K2`（缓存层）与 `TODO.md` 的 `K` 编号是**两套命名空间**，引用时带章节号。

| 章节 | 编号 | 一句话 | 状态 |
|---|---|---|---|
| §1.2 架构 | A1 | `App.tsx` 3707 行巨型组件 | ✅ 1322 行 + 16 个 hook（§2.3 / §4） |
| | A2 | `utils/index.ts` 1019 行混装 6 个领域 | ✅ 86 行 barrel + 9 个模块 |
| | A3 | 虚拟化与滚动位置记忆复制到 3 处 | ⏳ 未动 |
| | A4 | 无分层错误隔离 | ✅ 四个整页视图 + 详情面板各有兜底 |
| §2.1 安全 | S1 | 沙箱被完全关闭 | ✅ 默认开启 + 开发逃生口 |
| | S2 | `pm://file` 无路径白名单 | ✅ 会话级授权 + 403 |
| | S3 | 全部 IPC 不校验路径 | ✅ `isPathAuthorized()` 收口 |
| | S4 | 无 CSP | ✅ `electron/lib/csp.cjs` 唯一定义 |
| | S5 | 读取 / 上传无体积上限 | ✅ 64MB / 20MB，闸门前置 |
| | S6 | dev server 监听 `0.0.0.0` | ✅ 改 `127.0.0.1` |
| §2.2 并发 | C1 | `buildUniquePath` TOCTOU | ✅ `reserveUniquePath`（`open(…,'wx')`） |
| | C2 | `move-files` 全串行 | ⏳ 未动（串行是正确性要求，见 §3.1） |
| | C3 | `movePhotosToTrash` 全串行 | ⏳ 未动 |
| §3 Preload | I1 | 暴露 ~35 个方法，接口面偏大 | ⏳ 未动（低优先） |
| | I2 | 错误返回协议不统一 | ✅ 统一为 `IpcResult<T>` |
| | I3 | `analyzeImage` 无大小校验 | ✅ 同 S5 |
| §4 渲染层 | R1 | 巨型组件（同 A1） | ✅ 同 A1 |
| | R2 | 四条写盘管线各自实现 | 🔶 已收敛进 `useFileOperations` + `useFileOpFeedback` |
| | R3 | 快捷键与右键菜单两套分发 | 🔶 各自收口，未合并为 `ActionDescriptor[]` |
| §5 工具层 | U1 | dHash 双实现 | ✅ 收敛为 `electron/lib/dhash.cjs` |
| | U2 | `matchesSearch` 每次 5 次 `toLowerCase()` | ✅ `WeakMap` 预小写索引 |
| | U3 | 重复注释 | ✅ 随 `utils` 拆分消解 |
| | U4 | 阈值与上限是硬编码魔数 | ⏳ 未动 |
| | U5 | `placeIndex` 超限 `cache.clear()` | ✅ 改 `createLruCache` |
| §6 缓存层 | K1 | `dragThumbnail` 与注册表隐式耦合 | ⏳ 未动 |
| | K2 | 缓存占用 / 清理入口未暴露 | ⏳ 未动 |
| §7 持久化 | P1 | 配置损坏未备份原文件 | ⚠️ **原判断有误**：备份当时已存在；缺的「告知用户」已补 |
| | P2 | `sources` 上限 200 静默截断 | ⏳ 未动 |
| §8 文件操作 | F1 | 两套文件名规则 | ✅ 唯一入口 + 不变式测试 |
| | F2 | `joinPath` 手写拼接 | ✅ 对齐 `node:path.join` |
| | F3 | 错误翻译未复用 | 🔶 主链路已复用；`ExportModal` 仍自带一份 |
| | F4 | `movePhotosToTrash` 串行（同 C3） | ⏳ 未动 |
| §9 媒体 / 筛选 | M1 | 纯函数零测试 | ✅ 单测 326 项 |
| | M2 | 智能分类规则硬编码 | ⏳ 未动 |
| | M3 | 两个相近缓存各自实现 | ✅ 均改 `createLruCache` |
| §10 地理 | G1 | 1767 行城市数据内嵌 `.ts` | ✅ 外置 JSON + 动态 `import()` |
| | G2 | `placeIndex` 超限 `clear()` | ✅ 同 U5 |
| | G3 | 标签避让线性扫描 | ⏳ 未动（48×48 可接受） |
| §11 组件层 | N1 | 网格与列表两套虚拟化 | ⏳ 未动 |
| | N2 | 模块级 `savedScrollTop` 污染 | ⏳ 未动 |
| | N3 | 布局常量分散 | ⏳ 未动 |
| | N4 | 情境条 / 选择条 JSX 重复 | ⏳ 未动 |
| | N5 | `getFolderPath` 只取末两级 | ⏳ 未动（刻意取舍，缺注释） |
| | N6 | 相似度语义对用户不透明 | ⏳ 未动 |
| | N7 | `VideoPlayer` 25+ `useState` | ⏳ 未动 |
| | N8 | `ExportModal` 大图三份内存 | ⏳ 未动 |
| | N9 | 静默吞错 | ⏳ 未动 |
| | N10 | canvas 重编码导出重复 | ⏳ 未动 |
| | N11 | 月份分组与日期分组两套实现 | ⚠️ **原判断不准确**：粒度本就不同；真正的回退链散落已收敛 |
| | N12 | `drawLandMask` 每帧重建 `Path2D` | ⏳ 未动 |
| | N13 | 图标组件重复定义 | 🔶 已抽公共图标库，收敛 5 组 |
| | N14 | 失效的 `eslint-disable` | ✅ 全部清理 |
| | N15 | Modal 基座重复 | ⏳ 未动（9 个 modal） |
| §12 构建 | B1 | `default.profraw` 入库 | ✅ 退出跟踪 + `.gitignore` |
| | B2 | 无 ESLint / Prettier | ✅ 已落地（TS 侧走 oxlint） |
| | B3 | 零测试 | ✅ 三层验证 |
| | B4 | `react` 放 `devDependencies` | ⏳ 未动（运行时无影响） |
| §13 重复代码 | D1–D10 | 十类重复 | ✅ D1 / D2（部分）/ D10 已解决；其余未动 |

---

## 1. 原始发现（2026-09-15）

> 本节保留审查当时的判断。每条只写「是什么、为什么是问题」，处置与验证见 §2。
> 已完成的条目仍保留，因为它们是后续改动的背景。

### 1.1 分层结构（评价：良好）

```
electron/main.js      窗口 / 菜单 / 协议 / 部分 IPC
electron/main/*.cjs   领域模块：ai / authorization / media-pipeline / migrations / store / data-assets
electron/preload.js   contextBridge 白名单
src/App.tsx           组合与视图路由
src/hooks/*           20 个功能域 hook
src/lib/*             纯逻辑领域层（fs / cache / persistence / media / filter / geo / duplicate / grid / album）
src/components/*      UI 层（grid / detail / duplicate / timeline / map / layout / modal / common / icons）
```

领域逻辑与 UI 分离干净，`lib/` 基本是纯函数或薄封装，可测试性本来就好。
`ipcGuard` 把「文件已消失」这一高频语义收敛成统一出口，是个好设计。

| 编号 | 问题 | 严重度 |
|---|---|---|
| A1 | `App.tsx` 3707 行单组件承载全部编排：导入、重命名、删除、移动、拖放、快捷键、右键菜单、~40 个 state。任何 state 变化都让整棵子树 reconcile，且无法对单一功能写测试 | 高 |
| A2 | `utils/index.ts` 1019 行混装 6 个互不相关领域 | 中 |
| A3 | 虚拟化与滚动位置记忆复制到 3 个组件，模块级可变变量各自维护 | 中 |
| A4 | 无顶层错误隔离：单个面板抛错整页白屏 | 低 |

### 1.2 主进程安全（当时最高优先级）

| 编号 | 问题 | 严重度 |
|---|---|---|
| **S1** | `no-sandbox` + `disable-setuid-sandbox` + `disable-gpu-sandbox` + `webPreferences.sandbox: false`，Chromium 沙箱完全关闭 | 高 |
| **S2** | `pm://file/<base64url>` 解码后直接读盘，无任何白名单；协议还带 `bypassCSP` 与 `ACAO: *` | 高 |
| **S3** | 全部 IPC handler 只校验类型不校验范围：`read-file` / `delete-file` / `rename-file` / `move-files` / `write-file-unique` / `open-path` / `show-in-folder` | 高 |
| **S4** | 无 CSP：无 meta、无响应头，`pm` 协议 `bypassCSP: true` | 中（引入远程内容即高） |
| **S5** | `read-file` / `ai-analyze` 无体积上限（100MB 文件 → ~133MB 字符串常驻） | 中高 |
| **S6** | dev server `host: '0.0.0.0'`，同局域网可访问 | 中 |

**当时的判断**：这不是「理论风险」，这条链上没有任何一环在拦。修复成本却很低 —— 五项动作都落在同一个文件、以数十行计。

### 1.3 Preload / IPC 契约

| 编号 | 问题 | 严重度 |
|---|---|---|
| I1 | 暴露约 35 个方法，接口面偏大（低优先） | 低 |
| I2 | 返回协议不统一：有的 `{success}`、有的抛错、有的返回裸值 | 中 |
| I3 | `analyzeImage` 无大小校验 | 中 |

### 1.4 渲染层编排

| 编号 | 问题 | 严重度 |
|---|---|---|
| R1 | 同 A1 | 高 |
| R2 | 四条写盘管线（重命名 / 删除 / 移动 / 导出）各自实现进度与错误处理 | 中 |
| R3 | 快捷键与右键菜单两套分发，作用域规则靠人工同步 | 中 |

### 1.5 工具与算法层

| 编号 | 问题 | 严重度 |
|---|---|---|
| U1 | dHash 双实现（主进程一份、渲染层一份），阈值与算法会漂移 | 中 |
| U2 | `matchesSearch` 每次 5 次 `toLowerCase()` | 中 |
| U3 | 重复注释 | 低 |
| U4 | 阈值与上限是散落的魔数 | 低 |
| U5 | `placeIndex` 超限直接 `cache.clear()` | 低 |

### 1.6 缓存与持久化

| 编号 | 问题 | 严重度 |
|---|---|---|
| K1 | `dragThumbnail` 与 LRU 注册表隐式耦合 | 低 |
| K2 | 缓存占用 / 清理入口未暴露 | 低 |
| P1 | 配置损坏未备份原文件（**后经核对：备份逻辑已存在，缺的是告知**） | 中 |
| P2 | `sources` 上限 200 静默截断 | 低 |

### 1.7 文件操作

| 编号 | 问题 | 严重度 |
|---|---|---|
| F1 | `sanitizeFilename` 与 `RenameModal` 两套规则，预览与结果会漂移 | 中 |
| F2 | `joinPath` 手写拼接，与 `node:path` 语义不一致 | 中 |
| F3 | 错误翻译未被所有路径复用 | 低 |
| F4 | `movePhotosToTrash` 串行（同 C3） | 低 |

### 1.8 组件层

`ImageGrid` 1685 行、`DuplicateDetector` 1064、`QuickLook` 901、`VideoPlayer` 1025、`TimelineGallery` 1314、`LocationMap` 1008、`Sidebar` 770。
问题集中在：两套虚拟化（N1）、模块级滚动变量（N2）、布局常量分散（N3）、选择条 JSX 重复（N4）、
`VideoPlayer` 状态爆炸（N7）、导出大图三份内存（N8）、静默吞错（N9）、Modal 基座重复（N15）。

### 1.9 构建与工程化

| 编号 | 问题 | 严重度 |
|---|---|---|
| B1 | `default.profraw` 被 git 跟踪 | 低 |
| B2 | 无 ESLint / Prettier | 中 |
| B3 | 零测试 | 高 |
| B4 | `react` 放在 `devDependencies` | 低 |

---

## 2. 修复记录

> 每批只记「范围 / 关键做法 / 验证 / 边界」。原附录里的代码片段与逐行推理已删除 ——
> 那些信息在代码注释与 git 历史里，文档只保留决策与证据。

### 2.1 P0 · 安全边界（2026-09-15，5/5）

**范围**：S1 沙箱、S2 `pm://` 白名单、S3 IPC 路径校验、S5 体积闸门、B1 构建残留。

- 沙箱默认开启；仅未打包且显式 `PHOTOMINDER_DISABLE_SANDBOX=1` 才关，打包产物永远强制开启。
- 会话级 `authorizedRoots` / `authorizedFiles`：只有 6 个入口能产生授权（导入对话框、选择目录、扫描目录、监听目录、路径探测、拖放）。`canonicalize()` 对**尚不存在**的目标向上找最深已存在祖先做 realpath 再拼回尾部 —— 否则 macOS 上 `/var` → `/private/var` 会让临时目录下的合法重命名被整体判为未授权。
- 路径比较用 `path.relative` 而非字符串前缀，避免 `/a/bc` 被当成 `/a/b` 之下。
- 体积闸门放在读取之前：`read-file` 64MB、`ai-analyze` 20MB。
- 顺带修掉 `write-file-unique` 用 `../` 越权写盘的真实漏洞。

**验证**：15 项路径边界用例（前缀穿透 / `..` / 绝对路径 / 空值）、主进程 37 项（当时口径）、真启动冒烟。

**边界**：当时未加 CSP、未改 `0.0.0.0`、未修 TOCTOU —— 都进了 P1。

### 2.2 P1 · 契约与护栏（2026-09-16，10/10）

- **CSP 唯一定义**在 `electron/lib/csp.cjs`，主进程 `onHeadersReceived` 与 Vite 构建期注入的 `<meta>` 共用同一份字符串。生产 `script-src` 不含 `unsafe-inline`；开发必须含（React Refresh 内联前导脚本）。
- `buildUniquePath` → `reserveUniquePath()`：`open(path, 'wx')` 原子占位，消除 TOCTOU。
- 全部 handler 统一 `IpcResult<T>` 并强制走 `handle()`（异常兜底 / 通道日志 / 重复注册检测）。「用户取消」是 `ok(true) + data:null`。
- `sanitizeFilename` / `validateFilename` 成为文件名唯一入口；不变式「校验通过 ⟹ 规范化后原样不变」由测试守住。
- ESLint + Prettier 落地；TS 侧因 TypeScript 7 与 `typescript-eslint` peer 范围不兼容，改用 oxlint（type-aware）。
- 三层测试建成：`test:unit` / `test:main`（打桩 electron）/ `test:smoke`（真启动）。

**过程中发现的真实缺陷（重要教训）**：P0 的 `canonicalize` 对不存在路径退化为 `path.resolve`，导致符号链接场景下正向用例失败。**P0 只测了「拒绝未授权」的负向用例，正向路径漏测**。已修并补回归。

**边界**：CI 未接；全量 Prettier 格式化当时未执行（已于 2026-11-05 独立完成，F17）。

### 2.3 P2 · 收敛与拆分（2026-09-16 起）

**收敛类（已完成）**

| 项 | 做法 |
|---|---|
| dHash 单一实现 | 放 `electron/lib/dhash.cjs` + 同名 `.d.cts`；Vite 能直接 import `.cjs`，两边共用，不写镜像副本 |
| 照片时间语义 | `photoTime.ts`：`photoTakenTime`（2 级，展示）/ `photoOriginalTime`（3 级，原图判定）/ `calendarDayKey`（本地日界）/ `hasUsableTime`（显式排 NaN）；调用点内联回退链清零，静态断言守着 |
| 搜索索引 | `WeakMap` 预小写；相机标识整体入索引（拆成厂商/机型会让 `canon eos` 匹配不到） |
| 缓存 | 一律 `createLruCache`（命中刷新 + 逐项淘汰 + volatile/sticky）；区分「跨天失效」（该 clear）与「容量淘汰」（该 LRU） |
| 存储损坏 | `readStore` 改名备份后入队 `storageNotices`，渲染层取一次并 Toast；只有改名成功才入队 |
| `utils` 拆分 | 1024 → 86 行 barrel + 9 个领域模块；`tests/unit/utilsBarrel.test.ts` 禁止往 barrel 加实现 |

**拆分类（已完成）**

- `App.tsx` 3707 → 1279 行，拆出 15 个功能域 hook；本轮进一步抽掉空状态文案与单条目动作（§4），现 1322 行。
- `places.data.json` 外置 + 动态 `import()`，独立 chunk 约 59KB。
- 四个整页视图各挂 `ErrorBoundary` + 共用 `ViewErrorFallback`，详情面板内联降级。

**仍未做**：ActionDescriptor、Modal 基座、虚拟化 hook、布局常量、受控并发、播放器状态机、导出分块、`useBatchOperation`、地图离屏缓存 —— 见 §3.1。

### 2.4 冗余清理（2026-09-16）

- 抽公共图标库 `src/components/icons/`，收敛 5 组重复（返回箭头 3→1、刷新/重置、漏斗、加号各 2→1），尺寸与线宽在调用点参数化。
- 清理失效 `eslint-disable`；修掉 `useFileOperations` 重命名 replace 分支里模板字符串吞掉 `\.` 的瑕疵（改 `lastIndexOf + slice`）。
- **记录一条防误删结论**：`EmptyStates.tsx` / `Stat.tsx` / `DotField.tsx` / `ImmersiveView.tsx` **不是死代码**，是已实现但尚未完全接线的设计资产。

### 2.5 主进程拆分与 AI 密钥边界（2026-11-05）

- `main.js` 2,746 → 1,292 行，拆出 `main/` 6 个 .cjs（ai / authorization / data-assets / media-pipeline / migrations / store）；40 个 invoke 通道与 preload 双向差集为空。
- **修正一处文档声明与实现不符**：`ai-config-get` 原会把明文 API Key 回传给渲染层，与「渲染进程不接触密钥」矛盾。现只回 `hasApiKey` + 尾号掩码；设置弹窗改为「留空 = 保持现有值，清除需显式勾选」。
- 定位确认为**个人自用**，据此不引入签名 / 公证 / 自动更新 / CI；`safeStorage`（X1）维持暂缓，但声明改为如实描述本机明文存储。

### 2.6 数据资产专项（2026-11-05）

**改的是数据模型，不只是代码**：标注资产的键从「磁盘路径」换成「内容指纹」。

- `Photo.fileId` = `sha256(size + 头尾各 64KB)` 截 128 bit，跨会话 / 跨重命名 / 跨移动稳定；`Photo.id` 只是会话内 id，不得用于持久化。
- 删除 `rekeyPathData` / `dropPathData` / `persistPathData` 整条补丁链；改名 / 移动 / 删后重导入自动续上标注。
- 启动迁移器把 v1 路径键换算成指纹，不可达记录进 `orphans` 供重连续接。
- 写盘前轮转 `config.json.bak` / `.bak.1`；「数据资产」面板（⌘⇧D）提供配置导出导入（不含密钥）、路径重连、操作日志与撤销、按原目录增量备份（F10）。
- 删除撤销在 macOS 上按「文件名 + 体积 + mtime」三重校验从 `~/.Trash` 取回，失败明确报错。

### 2.7 v0.6.1 发布收尾与迁移器守卫（2026-11-06）

**恢复演练发现的阻断缺陷**：`migrateAllStores` 曾要求 config 与 ai-cache **同时** >= v2 才 no-op。
ai-cache 缺失 / 损坏时 `readStore` 返回 `{}`，导致已是 v2 的 config 被重迁，内容指纹被当成路径清空标注 ——
而 `orphans` 是 hex 键，无法用路径重连找回。

**修法**：两个 store 各自判断版本（缺失视为 v0），只写需要迁的那份。补 30 项回归测试。

**边界**：恢复演练必须隔离 —— `restoreFromTrash()` 用 `os.homedir()` 拼 `~/.Trash`，把 `HOME` 指到临时目录 + 造假回收站即可完全隔离；读真实 `~/.Trash` 在 TCC 下是 EPERM。

### 2.8 v0.6.2 批次 1 · 作用域与品牌（2026-11-06）

- K13 右键菜单作用域、K16 选中态保留排序 / 缩放、K26 相簿重名与重命名、窗口 960×640 下限、`<main>` landmark。
- **品牌边界（拍板）**：界面显示名「时光画框」、副标题「本地照片整理工作台」；`package.json` 的 `productName` / `appId` 与导出文件的 `payload.app` **一律保留 `PhotoMinder`**。前者决定 `userData` 目录（改了丢数据），后者是旧备份的格式标识（改了备份无法导入）。由 `tests/unit/branding.test.ts` 静态断言守住。
- 测试基础设施：静态断言会遍历整个 `src` 逐文件读源码，12 worker 并行时 CPU 竞争会推过默认 5s；只放宽超时，不改断言口径。

### 2.9 v0.6.2 批次 2 · 撤销前置（2026-11-06）

- 成功 Toast 带「撤销」；菜单「编辑 → 撤销上次文件操作」（⌥⌘Z）；失败给原因 + 「在数据资产中查看」出口。
- **只撤「最近一条」**：文件操作逐文件 `recordOperation` 埋点，IPC 不回传 operation id；按批撤销要改契约并给日志分组，与「可信版」收益不匹配。已在按钮文案里写明作用域（批量场景「撤销 1 项」）。
- **⌘Z 归 Chromium 原生**：编辑菜单 `role:'undo'` 会消费 ⌘Z，替换它会破坏输入框内文本撤销。用独立菜单项 + 不冲突的快捷键，不做 `before-input-event` 拦截。
- 纯逻辑收在 `src/lib/fs/lastOperation.ts`（注入 api / showToast，便于测试），17 项单测 + 1 项事件契约断言。

### 2.10 v0.6.2 批次 3 · 重复检测收口（2026-11-11）

**范围**：P0-3 / F8 前半 —— 忽略此组、只检测选中项、清理报告、删除后撤销（撤销沿用批次 2）。

- **组身份只认内容**：`stableIdentityOf` 取 `fileId` → 磁盘路径；`groupIdentityKey` 把成员标识排序拼接后用两轮 FNV-1a 压成 16 hex。排序让组内重排 / 改名 / 移动不改变身份，**成员变化则失效**是明确接受并记录在 UI 的取舍，不做模糊续接（否则「不是重复」会被套到另一组照片上）。
- **持久化位置是硬约束**：忽略集写 `config.json` **顶层** `ignoredDuplicateGroups`，不进 `duplicate` 偏好对象 —— 后者每次调阈值都被整体替换。已用静态单测钉住这条。
- **不留静默失败**：拖放降级、既无 `fileId` 也无路径的组不能跨重启识别，直接说明「无法跨重启记住」；重复点忽略与真正缺少指纹是两条不同提示。
- **报告单一来源**：`releasableSizeOf` / `buildScanReport` 同时供顶栏情境条与右栏报告使用，杜绝「顶栏 14 组、报告 12 组」。`DuplicateReportPanel` 从 1,100 行的 `DuplicateDetector` 中拆出，顺带降低该组件继续膨胀的速度。
- **`selected` 不跨启动恢复**：它是一次性的会话意图；`useAppConfig` 读取时忽略，回落 `all`。
- **验证**：新增 15 项单测；全套 typecheck / lint 0 / format:check / build / 单测 343 / 主进程 231 / Electron 冒烟全绿。

**边界**：忽略集上限 500 条（超出淘汰最旧）；`normalizeIgnoredGroups` 对坏配置逐条容错。恢复忽略后走 `repartition` 轻量重分组，列表为空时退化为全量扫描并显示进度。

### 2.11 v0.6.2 回补与发版（2026-11-11）

- **K11**：新增受限 IPC `probe-rename-targets`（只读、路径白名单、不返回目录内容），主进程把
  `uniqueNameCandidates` 抽成单一函数，让「只读预演」与 `reserveUniquePath` 原子占位同源。
  预览逻辑从 640 行的 RenameModal 抽到 `lib/fs/renamePreview.ts`，组件提交与预览共用同一份
  `RenameOptions`。主进程测试直接断言「预演名 === 真实落盘名」；`freed` 集合模拟批量改名的
  顺序语义，避免链式改名预演出多余的 -1。IPC 调用按分层守卫下沉到 `lib/fs/renameProbe.ts`。
- **K20**：统一为「所有入口保留搜索词 + 条件条显式展示上下文」。`lib/filter/viewContext.ts`
  汇总搜索词 / 当前相簿 / 全部筛选，侧栏高亮按分类与媒体类型两个独立维度判定。
  相簿仍覆盖筛选条件（这是它的定义），差异由条件条呈现，不是两套规则。
- **批次 4 / 5**：10px 清零、信息性 11px 升 12px；顶层错误页给出连续重试次数与可展开详情；
  `styles.css` 的暗色基础色收敛到 `@theme`，hex 与 rgb 通道一致性由静态断言守住
  （已验证 Tailwind v4 会把非 `--color-*` 的通道 token 原样输出进产物 CSS）；
  `useModalA11y` 统一 9 个弹层的焦点陷阱 / 初始焦点 / Esc / 焦点归还，ExportModal 保留
  「导出中 Esc = 取消」这份额外语义。
- **验证**：typecheck / lint 0 / format:check / build / 单测 370 / 主进程 251 / 冒烟全绿；
  发布恢复演练 6 项验证新增 `ignoredDuplicateGroups` 顶层字段不因写偏好被抹掉。

**边界**：预览的磁盘探测有时效，预览到确认之间文件变动仍以主进程原子占位为准，UI 已明说；
可用性脚本需维护者本人执行，本次发布未做真人测试。

### 2.12 v0.7.0 第一批 · 批量标签（2026-11-11，未发版）

- **刻意不复用 `handleUpdatePhoto`**：那个入口每张照片写一次 config，100 张就是 100 次 IPC。
  新 hook 整批只更新一次 `setPhotos` + 一次 `savePersistedConfig`，分片之间 `yieldToMain()` 让出主线程。
  写盘用真实的 `tagsRef`（而不是从当前 photos 重建），否则会丢掉「配置里有、但本次未导入」的标签。
- **撤销用 before 快照**：只还原本次真正变化的条目，不做「从所有照片删掉该标签」这种粗暴回退。
  快照只在 Toast 生命周期内有效，与 v0.6.2 文件操作日志的口径分开，文档已写明。
- **数字同源**：详情面板的覆盖统计、输入建议与侧栏标签列表共用 `rankTags`，不各算一套。
- **验证**：9 项单测；全套 typecheck / lint 0 / format / build / 单测 379 / 主进程 251 / 冒烟全绿。

**边界**：标签重命名 / 合并 / 删除、失败项重试（纯内存操作暂无失败路径，写盘失败沿用 persistence Toast）留待后续批次。

---

## 3. 仍未解决

### 3.1 P2 剩余（9 项 + 工程化收尾）

| 批次 | 项 | 说明 |
|---|---|---|
| 组件层 | Modal 基座（9 个）、虚拟化 hook、布局常量、地图离屏缓存、图标库剩余差异 | 都在 `components/`，可一次做完 |
| 交互 | `ActionDescriptor[]`、播放器 `useReducer`、`useBatchOperation` | 属行为收敛，需逐项手测 |
| 性能 | 受控并发（`movePhotosToTrash` 仍串行）、导出大图分块 | 需要真实大库才能验证收益 |
| 工程化 | CI、`strict: true` | 本机 `npm install` 与沙箱有环境限制；`noImplicitAny` 单独打开为 0 新增错误，代价集中在 `strictNullChecks` |

**关于「全串行」**：`move-files` 的串行是**正确性要求**（每项先原子占位，下一项才能正确探测同名），不要改成并发。可优化的是「批量删除」—— 它没有同名冲突，可以受控并发。

### 3.2 已记录但未改行为（需产品决定）

| 编号 | 现象 | 为什么不擅自改 |
|---|---|---|
| K31 | 「哪张是原图」两套判断：`LocationMap` 用 `photoOriginalTime(a)-photoOriginalTime(b)`，重复检测用逐字段 `compareByOriginalTime`。同组共享 EXIF 时前者全是并列 | 属行为变更，地图里的「原图」标注会变 |
| K32 | `sortPhotosByTimeline` 注释说缺失时间排末尾、实现排最前；`clusterBySize` 注释说 ±10%、实际以最小体积为锚点；`repairFileName` 会把扩展名转小写；`extOfName('.gitignore')` 返回 `'gitignore'` | 原则：**先补测试钉住现状，不擅自改行为** |
| N5 | `getFolderPath` 只取末两级 | 刻意的展示取舍，缺注释 |
| N6 | 相似度语义对用户不透明（并查集传递闭包会出现「组内相似 69%」而顶栏写 ≥80%） | 需要产品定义「组内相似度」口径 |

### 3.3 明确不做

签名 / 公证 / 自动更新 / CI（自用定位）；云同步、账号、遥测；`safeStorage`（X1）；
视频重编码（依赖 ffmpeg）；基础图片编辑；十万级库 Worker 化。

---

## 4. 复审（2026-11-06）

本轮复读主进程文件操作、IPC 契约、渲染层四个最大组件与 `lib/` 的错误路径，
**发现 5 处真实缺陷（均已修）与 2 处组织问题（已抽离）**。编号 `R*` 与正文体系并列。

### 4.1 修复项

| 编号 | 严重度 | 问题 | 修法 |
|---|---|---|---|
| **R1** | **高** | `moveFiles` 的 `priorTargets` 在 **preload 被丢弃**（形参只有 2 个，d.ts 与主进程都是 3 个）。后果不是报错而是**静默产生重复副本**：跨卷移动「复制成功、删源失败」后点重试，主进程拿不到 `priorTargets`，回退正常流程再复制一份 | preload 透传第三参；`ipc-contract.test.cjs` 从「登记缺口」改为钉「三处形参一致」 |
| R2 | 中 | 删除失败分流失效：`movePhotosToTrash` 先 `humanizeFsError` 再让调用方 `isFileGoneError` 判定，原始 `ENOENT` 已被替换成中文 → 永远判不出，失效条目被塞进重试集合，点重试只会再失败一次 | 在转译前分流，`TrashResult` 增加 `gonePhotos`；调用方直接使用。新增 4 项单测 |
| R3 | 中 | 地图浮层点击冒泡：照片条与缩放簇在地图容器内且无 `stopPropagation`。点缩略图会先开 QuickLook、再被 `handleClick` 判成「点空白」把照片条关掉；点缩放会顺带选中 / 取消一个地点 | 两处容器加 `onClick` 拦截 |
| R4 | 中 | 重复检测取消后误显示「未检测到相似图片」：`finally` 无条件把 `progress` 标成 `done`，组件用 `progress !== null` 判定「跑过一轮」 | 取消时 `progress` 置 `null`；被新一轮接管时跳过收尾（否则会把新轮进度标成瞬间完成） |
| R5 | 低 | 视频循环偏好不生效：`loop` 持久化了、控制条也显示开启，但 `<video>` 没有 `loop` 属性，重新打开预览播完即停 | `loop={loop}` 交给 React 管理 |
| R6 | — | `App.tsx` 空状态文案是 50 行四维嵌套三元（标题 / 描述 / 按钮 / 动作各按同一组条件分支） | 抽 `deriveEmptyStateCopy()` 纯函数（`libraryViewState.ts`），App 只把 `action` 映射成回调；7 项单测 |
| R7 | — | 复制图片 / 定位 / 复制路径 / 打开四个动作混在 App 编排里 | 抽 `usePhotoActions`，App 净减约 70 行 |

**净效果**：`App.tsx` 1426 → 1322 行；单测 315 → 326 项；主进程 197 项全过；typecheck / lint 0 problems。

### 4.2 确认不改的边界

- **`check-paths` / `authorize-paths` 允许渲染层自我授权已存在路径。** 这是设计边界而非漏洞：白名单防的是「内容级注入」（被当作图片加载的 SVG 等无法调用 IPC），**不是**「渲染进程被完全攻破」—— 后者天然拥有全部 IPC 能力。文档与注释都按这个口径写，不要把它当成第二道沙箱。
- **`undoOperation` 的重命名撤销有 existsSync 预判 + rename 的 TOCTOU 窗口。** 本地单用户、目标冲突时明确报错而非覆盖，可接受。
- **`useFileOperations` 返回的函数未 memo 化**，会让 `contextMenuActions` 的 `useMemo` 每次失效。ContextMenu 只在打开时渲染，实测无可感开销；包 `useCallback` 会引入十几个依赖声明，收益不抵风险。

---

## 5. 结语

功能实现质量值得肯定：内存、并发、原子性、可取消性这些「不容易被看见但最容易出事」的地方，都留下了经过思考的设计与解释性注释。

真正需要正视的曾经是安全边界的整体缺失 —— 它不是某个函数的疏漏，而是一组默认值的集体放松。好消息是这条链的修复成本很低：P0 的 5 项动作都在同一个文件、以数十行计。

**一条值得记住的经验**：审查结论本身也要被核对。本报告中至少三处判断在动手时被证伪或修正 ——
P1（配置损坏未备份，实际已备份）、N11/D2（两套日期分组，实际粒度不同不该合并）、
P0 引入的路径授权 bug（正向用例漏测）。把它们记下来，是为了让下一次审查知道「这里是踩过的」。

本轮（2026-11-06）又验证了一次同样的道理：**测试钉住的「已知缺口」不会自己变好**。
`moveFiles` 的形参不一致被契约测试明确登记了数月，但它带来的是静默重复副本而不是报错，
于是没有人在日常使用中撞见它。登记缺口只是止损，不是修复。
