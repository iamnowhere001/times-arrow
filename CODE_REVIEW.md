# PhotoMinder 代码审查报告

> **审查时快照**：`electron/`（主进程 2,350 行 + preload 108 行）、`src/`（28 个 tsx / 27 个 ts，约 22,850 行）、`build/`、`index.html`、`vite.config.mts`、`tsconfig*.json`、`package.json`
> **当前快照（2026-09-16）**：`electron/main.js` 2,746 行、`preload.js` 129 行，`electron/lib/` 4 个共享模块；`src/` 30 个 tsx（13,784 行）+ 49 个 ts（9,465 行）≈ 23,249 行，另新增 `src/hooks/` 18 个 hook（4,287 行）与 `tests/` 三层验证（11 个测试文件）
> 审查方式：逐模块通读源码 + 交叉验证（git 跟踪状态、配置项、IPC 契约）
> 严重程度定义：**高** = 安全风险 / 数据损坏 / 架构级债务；**中** = 明确的性能或正确性缺陷，或显著抬高维护成本；**低** = 一致性、可读性、局部优化
>
> **阅读顺序**：正文保留审查当时的原始判断（不回改，以便追溯为什么这么做）；
> 每条发现的修复进度见 **§0.1 状态总览** 与 **§14 行动清单**；
> 具体做法与验证记录在 **附录 A（P0）/ B（P1）/ C（P2 前半）/ D（P2 后半，2026-09-16）**。
> 图例：✅ 已完成 · 🔶 部分完成 · ⏳ 待做 · ⚠️ 已记录但未改行为（需产品决定）

---

## 0. 总体结论

这是一个**工程质量明显高于平均水准**的 Electron 桌面应用。亮点非常具体，不是套话：

- **内存治理有真实工程痕迹**：`pm://` 自定义协议以流式（含 HTTP Range 206）提供原图与磁盘缩略图，把「整张图 base64 常驻渲染进程」这个 Electron 照片应用最经典的 OOM 根因从架构上消除；磁盘缩略图落盘缓存 + `THUMB_RENDER_VERSION` 版本化 key + atime 淘汰；统一 LRU 注册表（volatile/sticky 分级）+ 内存看门狗（RSS 1.2GB soft / 2GB hard）。
- **长任务可取消、可重入、可恢复**：目录扫描 `scanId` 取消、重复检测 abort + 指纹缓存复用、跨卷移动 `EXDEV` → 复制+删源 + `partial` 中间态 + `priorTargets` 幂等重试（K2）、元数据回填时的滚动锚点补偿（K18）、列表深度滚动后筛选缩短的窗口夹取（K24）。
- **写盘原子性**：临时文件唯一名 + `rename` 替换 + `withStoreLock` 串行化「读-改-写」。
- **虚拟化与渲染性能**：justified 行布局 + 二分查找定位、rAF 节流滚动、`React.memo` + 稳定引用回调节流、`content-visibility: auto`、列表表头作为 element 传入避免滚动帧重渲染、刻意避开 `backdrop-filter` 长列表掉帧。
- **注释写「为什么」而非「是什么」**：绝大多数复杂分支都留下了决策依据，这在个人项目中非常罕见。

主要问题集中在**一个横切面**：**Electron 的安全边界被整体让渡了**。`no-sandbox` + `sandbox: false` + `bypassCSP` + 无 CSP + `pm://` 无路径白名单 + 全部 IPC 不校验路径，这五件事叠加起来，等于渲染进程一旦被攻破（哪怕只是一次 XSS 或一个恶意构造的 AI 返回内容被当 HTML 处理），攻击面就是**本机任意文件的读、写、删、改、外发**。这不是「理论风险」，而是这条链上没有任何一环在拦。

其次是**架构级可维护性债务**：`App.tsx` 3707 行、`utils/index.ts` 1019 行，且没有 ESLint、没有一行测试。功能在快速增长，但缺乏任何自动化护栏。

> **更新（2026-09-16）**：上面两个短板都已补上。
>
> - **安全**：P0（沙箱 / 路径白名单 / 体积闸门 / 构建残留）5 项与 P1（CSP / 原子占位 / IPC 统一协议 /
>   文件名与路径收口）全部完成，攻击面从「任意文件读写删」收敛到「仅授权目录内」。
>   实测改动量远小于预估 —— P0 全部落在同一个文件、以数十行计，当初「改动面大」的顾虑不成立。
> - **架构与工程化**：`App.tsx` 3707 → 1279 行（拆出 15 个功能域 hook）、`utils/index.ts` 1019 → 86 行 barrel、
>   dHash 与照片时间语义各自收敛为唯一实现、地名表外置为独立 chunk；
>   同时建成三层验证（单测 266 项 / 主进程集成 88 项 / Electron 冒烟）与 ESLint + Prettier 护栏。
>
> 详见 §14 与附录 A–D。§1–§13 正文按**审查当时**的表述保留，未逐条改写。

**综合评分（10 分制）**

| 维度 | 审查时 | 当前 | 说明 |
|---|---|---|---|
| 架构设计 | 7.0 | **8.5** | `App.tsx` 已拆为 hooks + 视图路由，`utils` 已按领域拆分；剩余债务在组件层（`ImageGrid` 两套虚拟化） |
| 代码质量与可读性 | 7.5 | **8.0** | 命名与注释仍属优秀；重复图标与重复 Modal 基座未清 |
| 性能 | 8.0 | **8.5** | 搜索索引缓存、地名 LRU、地名表拆包已落地，未见回退 |
| 安全 | 4.5 | **8.5** | 沙箱 / CSP / 路径白名单 / 体积闸门 / 原子写盘全部到位；未做 `safeStorage` 加密密钥（X1，风险可接受） |
| 错误处理与边界 | 7.0 | **8.0** | IPC 返回协议统一、分层 ErrorBoundary 已加；主进程仍无未捕获异常兜底（K4 半边未做） |
| 工程化 | 5.0 | **7.5** | 三层测试 + ESLint + Prettier 已纳入脚本；缺 CI，且 TS 侧 lint 因 TS 7 降级 |
| **加权总分** | **6.8** | **8.2** | 两块短板已补齐，剩余为组件层收敛与 CI |

---

## 0.1 发现项修复状态总览（截至 2026-09-16）

按正文章节列出全部编号。**「状态」列的 ✅ 均以测试或构建产物为凭，不是口头结论。**

> 注：§6 的 `K1` / `K2`（缓存层）与 `TODO.md` 里「已知问题」批次的 `K` 编号是**两套命名空间**，
> 互不相关。引用时请带上章节号。

| 章节 | 编号 | 一句话 | 状态 |
|---|---|---|---|
| §1.2 架构 | A1 | `App.tsx` 3707 行巨型组件 | ✅ 拆为 1279 行 + 15 个 hook（附录 D.1） |
| | A2 | `utils/index.ts` 1019 行混装 6 个领域 | ✅ 拆为 86 行 barrel + 9 个模块（附录 C.7） |
| | A3 | 虚拟化与滚动位置记忆复制到 3 处 | ⏳ 未动 |
| | A4 | 无分层错误隔离 | ✅ 四个整页视图共用 `ViewErrorFallback` + 详情面板内联降级（附录 D.4） |
| §2.1 安全 | S1 | 沙箱被完全关闭 | ✅ 默认开启 + 开发逃生口（附录 A.1） |
| | S2 | `pm://file` 无路径白名单 | ✅ 会话级授权 + 403（附录 A.2） |
| | S3 | 全部 IPC 不校验路径 | ✅ `isPathAuthorized()` 收口 14 处（附录 A.2） |
| | S4 | 无 CSP | ✅ `electron/lib/csp.cjs` 唯一定义（附录 B.2） |
| | S5 | 读取 / 上传无体积上限 | ✅ 64MB / 20MB，闸门前置（附录 A.3） |
| | S6 | dev server 监听 `0.0.0.0` | ✅ 改 `127.0.0.1`（附录 B.2） |
| §2.2 并发 | C1 | `buildUniquePath` TOCTOU | ✅ `reserveUniquePath`（`open(...,'wx')`，附录 B.3） |
| | C2 | `move-files` 全串行 | ⏳ 未动 |
| | C3 | `movePhotosToTrash` 全串行 | ⏳ 未动 |
| §3 Preload | I1 | 暴露 ~35 个方法，接口面偏大 | ⏳ 未动（低优先） |
| | I2 | 错误返回协议不统一 | ✅ 统一为 `IpcResult<T>`（附录 B.4） |
| | I3 | `analyzeImage` 无大小校验 | ✅ 同 S5 |
| §4 渲染层 | R1 | 巨型组件（同 A1） | ✅ 同 A1 |
| | R2 | 四条写盘管线各自实现 | 🔶 已收敛进 `useFileOperations` + `useFileOpFeedback`，但未抽成泛型 `useBatchOperation` |
| | R3 | 快捷键与右键菜单两套分发 | 🔶 各自收口（`useKeyboardShortcuts` / `contextMenuActions`），未合并为 `ActionDescriptor[]` |
| §5 工具层 | U1 | dHash 双实现 | ✅ 收敛为 `electron/lib/dhash.cjs`（附录 C.2） |
| | U2 | `matchesSearch` 每次 5 次 `toLowerCase()` | ✅ `WeakMap` 预小写索引（附录 C.4） |
| | U3 | 重复注释 `// 2) 精确相同分组` | ⏳ 未动（随 `utils` 拆分位置已变，待清理） |
| | U4 | 阈值与上限是硬编码魔数 | ⏳ 未动 |
| | U5 | `placeIndex` 超限 `cache.clear()` | ✅ 改 `createLruCache`（附录 C.4） |
| §6 缓存层 | K1 | `dragThumbnail` 与注册表隐式耦合 | ⏳ 未动 |
| | K2 | 缓存占用 / 清理入口未暴露 | ⏳ 未动 |
| §7 持久化 | P1 | 配置损坏未备份原文件 | ⚠️ **原判断有误**：备份逻辑当时已存在；真正缺的「告知用户」已补（附录 C.5 / C.6） |
| | P2 | `sources` 上限 200 静默截断 | ⏳ 未动 |
| §8 文件操作 | F1 | `sanitizeFilename` 与 `RenameModal` 两套规则 | ✅ 唯一入口 + 不变式测试（附录 B.5） |
| | F2 | `joinPath` 手写拼接 | ✅ 对齐 `node:path.join`（附录 B.5） |
| | F3 | 错误翻译未被所有路径复用 | 🔶 `humanizeFsError` 已在主链路复用；`ExportModal` 仍有自己的 `describeExportError` |
| | F4 | `movePhotosToTrash` 串行（同 C3） | ⏳ 未动 |
| §9 媒体 / 筛选 | M1 | 纯函数零测试 | ✅ 单测 266 项（附录 B.6） |
| | M2 | 智能分类规则硬编码 | ⏳ 未动 |
| | M3 | 两个相近用途缓存各自实现 | ✅ 均改用 `createLruCache`（附录 C.4） |
| §10 地理 | G1 | 1767 行城市数据内嵌在 `.ts` | ✅ 外置 `places.data.json` + 动态 `import()`（附录 D.3） |
| | G2 | `placeIndex` 超限 `clear()`（同 U5） | ✅ 同 U5 |
| | G3 | 标签避让线性扫描 | ⏳ 未动（48×48 可接受） |
| §11 组件层 | N1 | 网格与列表两套虚拟化 | ⏳ 未动 |
| | N2 | 模块级 `savedScrollTop` 污染 | ⏳ 未动 |
| | N3 | 布局常量分散、跨文件靠人工纪律 | ⏳ 未动 |
| | N4 | 情境条 / 选择条 JSX 重复 | ⏳ 未动 |
| | N5 | `getFolderPath` 只取末两级 | ⏳ 未动（刻意取舍，缺注释） |
| | N6 | 相似度语义对用户不透明 | ⏳ 未动 |
| | N7 | `VideoPlayer` 25+ `useState` | ⏳ 未动 |
| | N8 | `ExportModal` 大图三份内存 | ⏳ 未动 |
| | N9 | 静默吞错 | ⏳ 未动 |
| | N10 | canvas 重编码导出重复 | ⏳ 未动 |
| | N11 | 月份分组与日期分组两套实现 | ⚠️ **原判断不准确**：粒度本就不同（按年月 vs 按日）；真正的问题「时间回退链散落 12 处」已收敛（附录 C.3） |
| | N12 | `drawLandMask` 每帧重建 `Path2D` | ⏳ 未动 |
| | N13 | 图标组件重复定义 | ⏳ 未动（5 个文件） |
| | N14 | 失效的 `eslint-disable` 注释 | 🔶 ESLint 已装，6 条失效指令已处理；`RenameModal` 仍有 1 条残留 |
| | N15 | Modal 基座重复 | ⏳ 未动（8 个 modal） |
| §12 构建 | B1 | `default.profraw` 入库 | ✅ 退出跟踪 + `.gitignore`（附录 A.4） |
| | B2 | 无 ESLint / Prettier | ✅ 已落地（TS 侧降级，附录 B.7） |
| | B3 | 零测试 | ✅ 三层验证（附录 B.6） |
| | B4 | `react` 放 `devDependencies` | ⏳ 未动（运行时无影响） |
| §13 重复代码 | D1–D10 | 十类重复 | ✅ D1 / D2（部分）/ D10 随收敛解决；D3 / D4 / D5 / D6 / D7 / D8 / D9 未动 |

---

## 1. 架构与模块划分

### 1.1 分层结构（评价：良好）

```
electron/main.js       主进程：文件系统、协议、IPC、AI 代理、存储、看门狗
electron/preload.js    contextBridge 暴露 ~35 个 IPC 方法（白名单式）
src/App.tsx            应用编排层（路由 + 状态 + 副作用）
src/lib/*              纯逻辑领域层（fs / cache / persistence / media / filter / geo）
src/hooks/*            可复用状态域（重复检测 / 主题 / Toast）
src/components/*       UI 层（grid / detail / duplicate / timeline / map / layout / modal / common）
src/utils/index.ts     通用工具 + 算法
```

**合理之处**：领域逻辑（`lib/`）与 UI（`components/`）分离得相当干净，`lib/` 下的模块基本是纯函数或薄封装，可测试性本来很好。`ipcGuard`（`reportFailure`/`reportGone`/`handleGone`）把「文件已消失」这一高频语义收敛成统一出口，是个好设计。

### 1.2 问题

| 编号 | 问题 | 严重程度 |
|---|---|---|
| A1 | `src/App.tsx` 3707 行、单组件承载全部编排：导入管线、单张/批量重命名、删除、移动、拖放、键盘快捷键、右键菜单装配、~40 个 state、数十个 `useMemo`。任何一处 state 变化都会让整棵子树进入 reconcile 流程，且**无法对任何单一功能写测试**。 | **高** |
| A2 | `src/utils/index.ts` 1019 行混合职责：扩展名表、`pmFileUrl`、`fileToBase64`、两套 dHash、`hammingDistance`、乱码修复、`mapWithConcurrency`、`UnionFind`、`clusterBySize`、`precomputeHashes`、`selectHashCandidates`、`findDuplicatePhotos`。这是 6 个互不相关的领域挤在一个文件里。 | **中** |
| A3 | 虚拟化与滚动位置记忆被复制到 3 个组件（`VirtualGrid`/`VirtualList` 在 `ImageGrid.tsx`、`TimelineGallery` 的 `savedScrollTop`、`DuplicateDetector` 的 `mountedGroups` 策略），模块级可变变量 `savedGridScrollTop`/`savedListScrollTop`/`savedScrollTop` 各自维护。 | **中** |
| A4 | 无顶层错误隔离：`ErrorBoundary` 只有一处（85 行，包裹根节点）。单个面板（如 `LocationMap` 的 canvas 绘制）抛错会让整页白屏，而不是局部降级。 | **低** |

**改进建议**

- **A1**：按「功能域」把 `App.tsx` 拆成 hooks：`useImportPipeline`、useRenameActions`、`useDeleteActions`、`useMoveActions`、`useDragDrop`、`useGlobalShortcuts`、`useContextMenu`。每个 hook 自持状态与副作用，`App.tsx` 只做组合与视图路由。目标是把它压到 400 行以内。这是**收益最高的一次重构**，且可以渐进进行（先抽最独立的快捷键与拖放）。
- **A2**：拆成 `utils/format.ts`、`utils/path.ts`、`utils/concurrency.ts`、`utils/hash.ts`、`utils/cluster.ts`、`utils/filename.ts`。
- **A3**：抽 `useScrollRestore(key)` 与 `useVirtualRows(...)` 两个 hook，三处共用。
- **A4**：在 `Sidebar`/`Toolbar`/主内容区/详情面板/各整页视图各挂一层 `ErrorBoundary`，崩溃时降级为「该面板不可用」而非整页失效。

---

## 2. Electron 主进程（`electron/main.js`，2350 行）

### 2.1 安全（本节是整份报告的最高优先级）

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **S1** | `app.commandLine.appendSwitch('no-sandbox')` + `'disable-setuid-sandbox'` + `'disable-gpu-sandbox'`，配合 `webPreferences.sandbox: false`。Chromium 的进程沙箱被**完全关闭**。渲染进程一旦被攻破，攻击者直接获得主进程级别的系统能力，`contextIsolation: true` 提供的那层隔离形同虚设。 | **高** |
| **S2** | `pm://file/<base64url>` **没有任何路径白名单**。`const filePath = Buffer.from(payload, 'base64url').toString('utf8');` 之后直接读盘。任何一段 base64 都能读到本机任意文件。该协议注册为 `standard: true, secure: true, corsEnabled: true, bypassCSP: true`，且响应头带 `Access-Control-Allow-Origin: *`。 | **高** |
| **S3** | 全部 IPC handler **不校验路径范围**，只校验类型：`read-file`（任意读）、`delete-file`（`shell.trashItem` 任意路径进回收站）、`rename-file`（任意改名）、`move-files`（任意移动）、`write-file-unique`（向任意目录写任意文件名）、`open-path`（`shell.openPath` 用系统默认程序打开任意文件）、`show-in-folder`。 | **高** |
| **S4** | 无 CSP：`index.html` 无 CSP meta，主进程也未注入 `Content-Security-Policy` 响应头，同时 `pm` 协议 `bypassCSP: true`。等于零 XSS 纵深防御。 | **中**（若将来引入远程内容 → **高**） |
| **S5** | `read-file` / `ai-analyze` **无体积上限**。`read-file` 把整个文件转 base64 返回渲染进程（100MB 文件 → ~133MB 字符串常驻）；`analyzeImage` 接受任意 base64 直接转发 DeepSeek，既无大小校验也无「本次将上传 N MB 到远端」的告知。 | **中高** |
| **S6** | `vite.config.mts` 中 `server.host: '0.0.0.0'` —— 开发服务器监听所有网卡，同局域网可访问。虽仅开发期，但配合无 CSP 的页面，是一台「可被扫描的调试端点」。 | **中** |

**改进建议（按性价比排序）**

1. **S1**：删掉三个 `appendSwitch`。若某个平台/环境确实需要，改成**仅开发期生效**（`if (!app.isPackaged)`）并写清原因。同时把 `sandbox` 改回 `true`（`preload.js` 已只用 `contextBridge` + `ipcRenderer`，与 sandbox 兼容，不需要 Node 能力）。
2. **S2**：给 `pm://file` 引入**会话级授权白名单**。渲染层在「导入 / 扫描 / 恢复库」时把已授权的根目录上报主进程，协议 handler 内用 `path.resolve` + `fs.realpath` 规范化后校验「目标路径位于某个已授权根目录之下」（注意用 `path.relative` 判断，避免 `/a/bc` 匹配到 `/a/b` 这类前缀穿透）。未授权的 `pm://file` 一律 403。
3. **S3**：在 `ipcGuard` 旁增加一个统一的 `assertWithinRoots(filePath)`，所有涉及文件路径的 handler 入口调用。这是**一处改动、全面生效**的收口点。
4. **S4**：`index.html` 加 CSP meta（`default-src 'self'; img-src 'self' pm: data: blob:; media-src 'self' pm: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.deepseek.com`），并在主进程对 `file://` 加载的页面通过 `session.defaultSession.webRequest.onHeadersReceived` 注入同名响应头。注意 Tailwind 与内联 `style` 需要 `'unsafe-inline'`（可接受，因为脚本已收紧）。
5. **S5**：`read-file` 增加 `stat` 前置检查与上限（如 64MB）并返回明确错误；`ai-analyze` 在主进程再校验一次 payload 长度，并在 UI 上对「将上传原图」给出一次性告知。
6. **S6**：改为 `host: '127.0.0.1'`。

### 2.2 正确性 / 并发

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **C1** | `buildUniquePath`（L1125）是典型 **TOCTOU**：`while (fs.existsSync(candidate))` 检查与随后 `writeFile`/`rename` 之间存在窗口。`write-file-unique` 是独立 IPC，两个并发导出会话（或导出与移动同时进行）可能选中同一路径并互相覆盖。注释里「逐个串行执行」只保证单次调用内部串行。 | **中高** |
| **C2** | `move-files` 内 `for (const srcPath of filePaths)` 全串行 —— 移动 500 张跨卷文件时是 500 次串行的「复制 + 删源」往返。 | **中** |
| **C3** | 渲染层 `movePhotosToTrash`（`src/lib/fs/fileOperations.ts`）同样串行 `await`，批量删除数百张时逐次 IPC 往返。 | **中** |

**改进建议**

- **C1**：改用原子创建语义 —— `await fs.promises.open(candidate, 'wx')` 抢锁成功后写入（`wx` = 独占创建，已存在则 `EEXIST`），失败则递增序号重试。这样「探测 + 占用」合并为一个原子操作。
- **C2/C3**：在**保留串行语义的地方之外**引入受控并发（限流 4~8）。注意 `move-files` 内部的串行有明确理由（批内同名探测），所以正确做法是：把「同一目标目录内的文件」串行、**不同目标目录之间并行**；`movePhotosToTrash` 则可以直接并发（回收站操作无同名冲突）。

### 2.3 其他观察（正面）

`streamFileResponse` 的 Range 解析覆盖了 `bytes=a-b` / `bytes=a-` / `bytes=-n` 三种形式并对越界返回 416，处理正确；`protocol.handle` 的整体 try/catch 把异常转成 500 而非崩溃，稳妥。`watch-directory` 的 `fs.watch recursive` + 防抖聚合（500ms 尾沿 / 3s maxWait）+ `touchedPathsRef` 回环防护设计合理。

---

## 3. Preload / IPC 契约（`electron/preload.js`，108 行）

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **I1** | 暴露 ~35 个方法，接口面偏大。`contextBridge` 的白名单模式本身正确，但缺少分组与注释，渲染层 `window.electronAPI.xxx` 的调用点分散在数十个文件里，契约变更时难以定位影响面。 | **低** |
| **I2** | **错误返回协议不统一**：同一层 API 中并存 `{ error }`（`read-file`）、`{ ok: false, error }`（`copy-image`）、`{ success: false, error }`（`rename-file` / `delete-file` / `write-file-unique`）、`{ error, results }`（`move-files`）、纯 `null`（`choose-directory` 取消）。调用方必须逐个记忆，`ipcGuard` 只覆盖了部分路径。 | **中** |
| **I3** | `analyzeImage` 透传任意 base64，无大小校验（同 S5）。 | **中高** |

**改进建议**：统一为 `Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }`，在主进程用一个 `wrapHandler()` 高阶函数统一包裹，preload 侧只做类型透传。这能顺带把 I2 与 E4（见下）一起解决。

---

## 4. 渲染层编排（`src/App.tsx`，3707 行）

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **R1** | 巨型组件（同 A1）。除可维护性外，还有实际的渲染成本：大量 `useMemo` 的依赖数组很长，任一依赖变化都会重算；`photos` 数组的每次替换都会传导到多个下游 memo。 | **高** |
| **R2** | 导入 / 重命名 / 删除 / 移动四条「写盘管线」的处理逻辑高度同构（进度 → 逐项执行 → 汇总成功/失败 → Toast → 更新列表），但各自独立实现，错误处理与 Toast 文案风格存在细微差异。 | **中** |
| **R3** | 键盘快捷键与右键菜单是两套独立的分发逻辑，同一动作（如删除）在两处各自判断可用性与二次确认，容易出现「快捷键能删但菜单项灰掉」这类不一致。 | **中** |

**改进建议**：抽 `useBatchOperation<T>()` 泛型 hook 统一「进度 / 取消 / 汇总 / 失败剔除」骨架；把「动作定义」收敛成一份 `ActionDescriptor[]`（含 `id`/`label`/`shortcut`/`isEnabled`/`run`），快捷键与右键菜单都从这份定义渲染，从根上消除 R3。

---

## 5. 工具与算法层（`src/utils/index.ts`，1019 行）

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **U1** | **dHash 存在两份独立实现**：主进程 `dHashFromBitmap`（`electron/main.js`，基于 `sharp`/bitmap）与渲染进程 `dHashFromPixels`（基于 canvas ImageData）。同一算法两处维护，且**缩放插值方式、灰度权重、采样点**若任一处改动或本就存在细微差异，会导致同一张图在两处算出不同哈希 → 重复检测漏检或误检。 | **中** |
| **U2** | `matchesSearch`（`lib/filter/filters.ts`）对每张照片每次调用都执行最多 5 次 `toLowerCase()`（name / type / camera / tags / aiDescription）。搜索框每敲一个字符就对全库跑一遍，数万张库时是明显的 CPU 抖动。 | **中** |
| **U3** | 文件中存在**重复注释**：`// 2) 精确相同分组` 在约 L950-961 与 L980 各出现一次，说明该段逻辑经历过复制粘贴。 | **低** |
| **U4** | `clusterBySize` 用 ±10% 体积阈值做预筛，配合 `SIMILAR_CLUSTER_LIMIT=150` 防 O(n²) —— 设计正确，但阈值与上限都是硬编码魔数，未提到配置层。 | **低** |
| **U5** | `placeIndex` 的最近邻用 1° 网格 + `Map` 缓存，**超限时直接 `cache.clear()`**。突发流量下会把整张缓存清空，随后所有请求全部 miss 并重新计算，形成「清空 → 抖动 → 再清空」的循环。 | **低中** |

**改进建议**

- **U1**：把 dHash 收敛为**单一实现**。推荐：主进程计算（已有缓存与限流），渲染层通过 `get-image-hashes` 拿结果；渲染层的 `dHashFromPixels` 仅作为「主进程不可用」的降级路径，并在两处加一条**一致性断言**（开发期对同一张图比对两实现结果，不一致就告警）。
- **U2**：为 `Photo` 增加惰性计算的 `searchIndex`（首次访问时把 name/type/camera/tags/description 拼成一个已小写的字符串并缓存到 `WeakMap`），`matchesSearch` 退化为一次 `includes`。
- **U5**：把 `cache.clear()` 换成 LRU 淘汰（项目已有 `createLruCache`，直接复用即可）。

---

## 6. 缓存层（`src/lib/cache/*`）

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **K1** | `thumbCache` 的并发闸门（12）+ inflight 去重 + generation 世代号防回写，设计**很好**。但 `dragThumbnail` 独立维护了另一套 120 条缓存，与 `cacheManager` 的注册表机制并行，`releaseMemory` 时需要保证两处都被清到 —— 属于隐式耦合。 | **低** |
| **K2** | `THUMB_CACHE_LIMIT = 20000` 与淘汰策略（atime）未在 UI 暴露「缓存占用 / 一键清理」入口，用户遇到缩略图异常时只能手动删目录。 | **低** |

---

## 7. 持久化层（`src/lib/persistence/*`）

这层质量较高：原子写（临时文件 + `rename`）、`withStoreLock` 串行化读-改-写、失败走 Toast 出口、来源归一化/去重/上限 200、旧配置迁移、AI 缓存上限 2000。

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **P1** | 配置损坏（JSON parse 失败）时的策略是「回退默认值」—— 但**没有把损坏的原文件备份**，用户的自定义相簿、收藏等会静默丢失。 | **中** |
| **P2** | `sources` 上限 200 是静默截断，超出时用户无感知。 | **低** |

**改进建议**：解析失败时把原文件重命名为 `*.corrupt-<timestamp>` 保留，并 Toast 告知用户「配置已重置，旧文件已备份」。

---

## 8. 文件操作层（`src/lib/fs/*`）

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **F1** | `sanitizeFilename`（`pathUtils.ts`）**未过滤 `\` 与 NUL 字符，也未处理 Windows 保留名**（CON/PRN/AUX/NUL/COM1-9/LPT1-9）。而 `RenameModal.tsx` 里**另起了一套校验**：`INVALID_CHARS = /[<>:"|?*\\/]/`（含 `\`）+ `RESERVED_WINDOW_NAMES` 集合。两套规则不一致，存在「预览通过但主进程拒绝」或「主进程接受但系统拒绝」的缝隙。 | **中** |
| **F2** | `joinPath` 手写路径拼接，未处理 `..`、重复分隔符、Windows 盘符与前导分隔符。跨平台场景下应统一用 `path.join`（主进程）或一个规范化函数。 | **中** |
| **F3** | `humanizeFsError` / `isFileGoneError` 是很好的收敛点，但**并非所有错误路径都经过它们**（`ExportModal` 自己又写了一层 `describeExportError`）。 | **低** |
| **F4** | `movePhotosToTrash` 串行（同 C3）。 | **中** |

**改进建议**：把 `sanitizeFilename` 提为**唯一**的文件名规范化入口（含 `\`、NUL、保留名、首尾空格/点、长度上限），`RenameModal` 与主进程都调用它；`joinPath` 替换为基于 `path` 的实现。

---

## 9. 媒体 / 筛选 / 分组（`src/lib/media/*`、`src/lib/filter/*`）

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **M1** | 筛选与分组是**纯函数**（`matchesFilters`、`matchesSearch`、`buildDateGroups`、`clusterBySize` 等），可测试性极佳，却零测试覆盖。这些函数一旦回归，用户看到的是「照片莫名其妙不见了」。 | **中** |
| **M2** | `mediaTypes.ts` 的智能分类（截屏分辨率白名单、自拍、实况配对）是启发式规则，硬编码在源码里。规则本身合理，但缺少「为什么是这些分辨率」的可追溯注释与集中配置。 | **低** |
| **M3** | `dateKeyCache` 用 LRU 5000 缓存日期分组 key，`videoMeta` 用 LRU 10000 —— 两个相近用途的缓存各自实现。 | **低** |

---

## 10. 地理模块（`src/lib/geo/*`）

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **G1** | `places.ts` 1767 行内嵌城市数据（含 `rank`），是数据而非代码，却与逻辑同目录同格式。建议改为独立 JSON 资源并按需加载，减少主 bundle 体积。 | **低中** |
| **G2** | `placeIndex` 超限 `clear()`（同 U5）。 | **低中** |
| **G3** | `landMask.ts` 的点阵采样 + `forEachLandDot` 逐格绘制，在拖拽时点距翻倍保帧率 —— 处理得当。但 `drawPlaceLabels` 的标签避让是 O(已放置标签数) 的线性扫描，标签多时（`MAX_PLACE_LABELS = 48`）是 48×48 的二次开销，可接受但可优化为网格加速。 | **低** |

---

## 11. 组件层

### 11.1 `ImageGrid.tsx`（1685 行）

**做得好的**：justified 行布局 + `findRowAt` 二分、rAF 节流、`handlersRef` 保持回调引用稳定以让 `React.memo` 真正生效、K18 元数据回填锚点补偿、K24 窗口起点夹取、列表行高实测校正、表头作为 element 传入避免滚动帧 reconcile、刻意避开 `backdrop-filter`。

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **N1** | 网格与列表**两套虚拟化实现**（`VirtualGrid` + `VirtualList`）在同一文件内，各自维护 viewport/scrollTop/恢复逻辑/测量逻辑，共约 700 行。两者抽象层次相同，本可共享一套「虚拟化原语」。 | **中** |
| **N2** | 模块级可变状态 `savedGridScrollTop` / `savedListScrollTop` 在组件外，多个 `ImageGrid` 实例（若将来出现）会互相污染。 | **低** |
| **N3** | `photoAspect` 的钳制常量（`MIN 0.2` / `MAX 5`）、`FALLBACK_IMAGE_ASPECT`、`BASE_ROW_HEIGHT = 200` 分散定义，而注释明确要求「VirtualGrid 的布局计算与 ImageCard 的 className 必须保持一致」—— 这是**靠人工纪律维持的跨文件不变量**，容易在改样式时漏改。 | **中** |

**改进建议**：N1 抽 `useVirtualization()`；N3 把布局常量集中到一个 `gridLayout.ts` 并导出，注释改为「改这里即可」，降低漏改概率。

### 11.2 `DuplicateDetector.tsx`（1064 行）

**做得好的**：`mountedGroups` 惰性挂载策略（未展开的组完全不产生 DOM 与缩略图请求）是打开大重复库时最关键的优化，且注释说清了原因；`groupMeta` 一次算清相似度避免渲染期重算 hamming；`groupKeyOf` 用照片 id 而非下标，避免删除后展开态「替位继承」；`content-visibility: auto` 跳过屏外布局；删除前的二次确认与主图库对齐。

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **N4** | 情境条 / 选择条的 JSX 与样式类与 `ImageGrid` 的选择条**几乎逐字重复**（约 60 行）。 | **低中** |
| **N5** | `getFolderPath` 只取末两级目录（`segments.slice(-2)`），同名文件夹（如两个 `2024/01`）会显示成一样，用户无法区分——这是刻意的取舍，但缺注释说明。 | **低** |
| **N6** | `similarityVs` 用 64bit dHash 换算百分比，`similarityToDistance` 向下取整。逻辑正确，但「相似度 90%」的语义（汉明距离 ≤ 6）对用户是不透明的，UI 只有一句 tooltip。 | **低** |

### 11.3 `QuickLook.tsx`（901 行）/ `DetailsPane.tsx`（826 行）/ `VideoPlayer.tsx`（1025 行）

**做得好的**：QuickLook 的缩放锚点、旋转、平移钳制、相邻预加载、交叉淡入、幻灯片 localStorage 记忆、完整键盘映射；VideoPlayer 自建控制条（缓冲区间、倍速、画质 1:1、PiP、全屏），`describeMediaError` 把媒体错误码翻译成人话；`handleProgress` 取「包含当前播放位置的缓冲段末端」而非最后一段，细节正确。

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **N7** | `VideoPlayer` 有 25+ 个 `useState`，状态机隐含在多个 `useEffect` 的交互里（控制条显隐 × 播放态 × 菜单 × 拖拽 × 缓冲 × 全屏）。这类状态用 `useReducer` 收敛会显著降低理解成本，也更容易发现非法状态组合。 | **中** |
| **N8** | `ExportModal` 的格式转换路径把整张图 `drawImage` 到 canvas 再 `toBlob` → `FileReader` → base64 → IPC。超大图（如 8000×6000）会同时占用 canvas 位图 + blob + base64 三份内存（峰值约 4× 原图解码后体积），有 OOM 风险，且无尺寸/体积上限。 | **中** |
| **N9** | 多个 `catch {}` 静默吞错（抓帧失败、`exitFullscreen` 失败、`localStorage` 失败、PiP 失败）。其中大部分是合理的降级，但**抓帧失败**（`captureVideoPoster`）属于「功能静默失效」，应当至少 `logger.warn` 一次。 | **低中** |
| **N10** | `DetailsPane` / `QuickLook` / `ExportModal` 各自实现「导出 / 压缩」，canvas 重编码逻辑重复。 | **低中** |

### 11.4 `TimelineGallery.tsx`（1314 行）/ `LocationMap.tsx`（1008 行）

**做得好的**：TimelineGallery 的 IntersectionObserver「进入视口邻域才请求缩略图」+ `everActive` 一次性闩锁（离开不卸载，省重新解码）、时间脊几何常量集中推导、`content-visibility` 思路一致；LocationMap 无地图 SDK、无网络的点阵底图（`Path2D` 批量填充避免逐格 `fillRect`）、双层同心圆代替 `createRadialGradient` 避免每帧 GC 抖动、标签避让表、相机钳制。

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **N11** | TimelineGallery 的月份分组与 `photoGrouping.ts` 的日期分组是**两套独立实现**（`groupByTime` vs `buildDateGroups`），口径若漂移会出现「图库分组与时光画廊分组不一致」。 | **中** |
| **N12** | LocationMap 的 `drawLandMask` 每帧重建 `Path2D` 并遍历全部采样格。相机不变时（仅 hover 变化）重绘整张底图是浪费，可缓存底图为离屏 canvas。 | **低中** |

### 11.5 `Sidebar.tsx`（770 行）/ `Toolbar.tsx`（389 行）/ Modals

**做得好的**：Sidebar 把「视图行（右端箭头）」与「筛选行（右端计数）」用同一套 `ROW_BASE`/`ROW_STATE`/`ROW_ICON` 拼装，设计语言统一且注释说明了组织原则；Toolbar 的 `SOFT_ACTIVE` 软激活语义、`ToolButton` 的 hover 着色与 Tooltip 一致性好；`React.memo` 包裹且有注释说明「只要父级回调稳定就不会白重渲染」。

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **N13** | 图标组件在**各文件内重复定义**：`ChevronLeftIcon` 在 `TimelineGallery`/`LocationMap` 各一份，`PlusIcon` 在 `Sidebar`/`LocationMap` 各一份，`TrashIcon`、`HeartIcon`、`RefreshIcon`、`DurationBadge`（`TimelineGallery` 与 `LocationMap` 各一份，仅 `text-[9.5px]` vs `text-[10px]` 之差）…… 未抽公共 `components/icons/`。 | **低中** |
| **N14** | `RenameModal` 的 `// eslint-disable-next-line no-new` 注释残留 —— **项目根本没装 ESLint**，这条注释是无意义的。 | **低** |
| **N15** | Modal 层缺少统一的 `Modal` 基座：遮罩、`Esc` 处理、`aria-modal`、点击遮罩关闭、`max-h` 与滚动容器在 8 个 modal 里各写一遍。 | **中** |

---

## 12. 样式与构建

| 编号 | 问题 | 严重程度 |
|---|---|---|
| **B1** | `default.profraw`（444KB）**已被 git 跟踪**（`git ls-files` 可查到）且**未被 `.gitignore` 忽略**（`git check-ignore` 无输出）。这是构建/性能剖析残留，不应入库。 | **低**（但应立即处理） |
| **B2** | 无 ESLint / Prettier / EditorConfig。`package.json` 只有 `typecheck`。代码风格（缩进、引号、`as const` 用法、注释格式）目前靠人工一致，随着文件增长会漂移。 | **中** |
| **B3** | 零测试。纯函数层（`filters`、`mapMath`、`placeIndex`、`clusterBySize`、`photoGrouping`、`repairFileName`、`formatDateForNaming`、`hammingDistance`）是单测的**理想标的**，投入产出比极高。 | **中** |
| **B4** | `react` / `react-dom` 放在 `devDependencies`。Vite 会打包进产物，所以运行时无影响，但语义上它们属于运行时依赖；若将来引入 SSR 或外部打包工具会踩坑。 | **低** |
| **B5** | `build/afterPack.js` 删除 `libvk_swiftshader.dylib`（16MB）与多余语言包，注释写明了「若将来接入 WebGL 需恢复」—— 处理得当，属于加分项。`recompressDmg.js` 用 `hdiutil convert` 转 ULMO 且失败时以 0 退出保留原 DMG，稳妥。 | — |
| **B6** | `vite.config.mts` 的 `strictPort: true` 有明确理由（Electron 固定连 3000），注释到位。 | — |

---

## 13. 重复代码与可优化逻辑汇总

| 编号 | 重复内容 | 位置 | 严重程度 |
|---|---|---|---|
| **D1** | dHash 双实现 | `electron/main.js` ↔ `src/utils/index.ts` | **中** |
| **D2** | 日期分组两套实现 | `TimelineGallery.groupByTime` ↔ `lib/media/photoGrouping.buildDateGroups` | **中** |
| **D3** | 虚拟化两套实现 | `ImageGrid` 的 `VirtualGrid` + `VirtualList` | **中** |
| **D4** | 图标组件重复定义 | Sidebar / ImageGrid / DuplicateDetector / TimelineGallery / LocationMap | **低中** |
| **D5** | 日期格式化重复 | `formatDate`(utils) / `formatDateTime`(DuplicateDetector) / `formatDayCapsule`(ImageGrid) / `formatMonthDay`(TimelineGallery) | **低** |
| **D6** | 滚动位置记忆重复 | 三处模块级变量 + 恢复 effect | **低** |
| **D7** | 选择条 / 情境条 UI 重复 | `ImageGrid` ↔ `DuplicateDetector` | **低中** |
| **D8** | Modal 基座重复 | 8 个 modal 各写遮罩/Esc/aria | **中** |
| **D9** | canvas 重编码导出重复 | `DetailsPane` / `QuickLook` / `ExportModal` | **低中** |
| **D10** | 重复注释 `// 2) 精确相同分组` | `src/utils/index.ts` L950-961 与 L980 | **低** |

---

## 14. 优先级排序的行动清单

### P0 — 立即处理（安全与数据安全）✅ 已完成

> 全部 5 项已实施并通过验证，详见文末「附录 A：P0 修复记录」。

| # | 动作 | 对应问题 | 影响面 | 状态 |
|---|---|---|---|---|
| 1 | 移除 `no-sandbox` / `disable-setuid-sandbox` / `disable-gpu-sandbox`；`sandbox` 改回 `true` | S1 | 1 个文件，数行 | ✅ |
| 2 | 为 `pm://file` 引入授权根目录白名单（`realpath` + `path.relative` 校验） | S2 | `main.js` 协议 handler | ✅ |
| 3 | 新增 `assertWithinRoots()`，在所有文件类 IPC handler 入口调用 | S3 | `main.js` 14 个 handler | ✅ |
| 4 | `read-file` / `ai-analyze` 增加体积上限与明确错误 | S5 / I3 | 2 个 handler | ✅ |
| 5 | 从 git 移除 `default.profraw` 并加入 `.gitignore` | B1 | 1 行 + `git rm --cached` | ✅ |

### P1 — 近期处理 ✅ 全部完成（2026-09-16）

| # | 动作 | 对应问题 | 状态 |
|---|---|---|---|
| 6 | 注入 CSP（meta + `onHeadersReceived`），`vite` host 改 `127.0.0.1` | S4 / S6 | ✅ 附录 B.2 |
| 7 | `buildUniquePath` 改用 `fs.open(path, 'wx')` 原子创建 | C1 | ✅ 附录 B.3 |
| 8 | 统一 IPC 返回协议为 `Result<T>`，主进程 `wrapHandler` 包裹 | I2 / F3 | ✅ 附录 B.4（30 个 handler，实为 `IpcResult<T>`） |
| 9 | 统一 `sanitizeFilename` 为唯一文件名规范化入口，`RenameModal` 复用 | F1 | ✅ 附录 B.5 |
| 10 | `joinPath` 替换为 `path` 实现 | F2 | ✅ 附录 B.5 |
| 11 | 引入 ESLint + Prettier，加 `lint` script 与 CI 校验 | B2 | ✅ 附录 B.7（**CI 未做**，见遗留） |
| 12 | 为纯函数层补单元测试 | B3 / M1 | ✅ 附录 B.6（266 项） |
| 13 | 拆 `App.tsx` | A1 / R1 | ✅ 附录 D.1（3707 → 1279 行 + 15 hook） |
| 14 | 抽 `ActionDescriptor[]` 统一快捷键与右键菜单 | R3 | ⏳ 并入 P2（附录 D.5 遗留） |
| 15 | 抽 Modal 基座 | N15 / D8 | ⏳ 并入 P2（附录 D.5 遗留） |

### P2 — 规划处理（进行中，9 / 20 完成）

> 共 20 项 = 原 P2 的 17 项（16–32）+ 并入的 P1-13/14/15。

| # | 动作 | 对应问题 | 状态 |
|---|---|---|---|
| 13 | 拆 `App.tsx` 为功能域 hook | A1 / R1 | ✅ 附录 D.1 |
| 16 | 拆 `utils/index.ts` 为 9 个模块 | A2 | ✅ 附录 C.7 |
| 17 | dHash 收敛为单一实现 + 一致性断言 | U1 / D1 | ✅ 附录 C.2 |
| 18 | 照片时间语义收敛（原「日期分组收敛」判断已修正） | N11 / D2 | ✅ 附录 C.3 |
| 19 | 搜索索引缓存（`WeakMap` + 预小写） | U2 | ✅ 附录 C.4 |
| 22 | `placeIndex` / `dateKeyCache` 的 `clear()` 改 LRU 淘汰 | U5 / G2 / M3 | ✅ 附录 C.4 |
| 24 | 配置损坏时告知用户（原「备份原文件」判断已修正） | P1 | ✅ 附录 C.5 / C.6 |
| 27 | `places.ts` 数据外置为 JSON 按需加载 | G1 | ✅ 附录 D.3 |
| 30 | 分层 `ErrorBoundary` | A4 | ✅ 附录 D.4 |
| 14 | 抽 `ActionDescriptor[]` 统一快捷键与右键菜单 | R3 | ⏳ 待做 |
| 15 | 抽 Modal 基座 | N15 / D8 | ⏳ 待做 |
| 20 | 抽 `useVirtualization()` / `useScrollRestore()` | N1 / N2 / D3 / D6 | ⏳ 待做 |
| 21 | 抽公共图标库 | N13 / D4 | ⏳ 待做 |
| 23 | 批量删除与跨目录移动引入受控并发 | C2 / C3 / F4 | ⏳ 待做 |
| 25 | `VideoPlayer` 状态机改 `useReducer` | N7 | ⏳ 待做 |
| 26 | `ExportModal` 大图分块 / 尺寸上限保护 | N8 | ⏳ 待做 |
| 28 | 布局常量集中到 `gridLayout.ts` | N3 | ⏳ 待做 |
| 29 | 抽 `useBatchOperation()` 统一写盘管线 | R2 | 🔶 部分（已收进 `useFileOperations` + `useFileOpFeedback`，未抽成泛型） |
| 31 | LocationMap 底图离屏缓存 | N12 | ⏳ 待做 |
| 32 | 清理 `utils/index.ts` 重复注释、`RenameModal` 的 eslint 注释 | U3 / N14 | 🔶 部分（6 条失效指令已处理，`RenameModal` 仍有 1 条） |

---

## 15. 结语

PhotoMinder 的**功能实现质量**值得肯定：内存、并发、原子性、可取消性这些「不容易被看见但最容易出事」的地方，都留下了经过思考的设计与解释性注释。这说明作者对 Electron 照片管理应用的痛点有真实的一手经验。

真正需要正视的是**安全边界的整体缺失**——它不是某个函数的疏漏，而是一组默认值的集体放松（沙箱关闭 + CSP 关闭 + 无路径白名单 + IPC 不校验）。好消息是这条链的修复**成本很低**：P0 的 5 项动作都在同一个文件里，改动量以「数十行」计，却能一次性把攻击面从「任意文件读写删」收敛到「仅授权目录内」。

其次是**工程化护栏**：lint 与测试的缺失，让上面所有这些重构（尤其是 `App.tsx` 拆分）都变成「无安全网的高空作业」。建议**先补 lint 与纯函数测试，再动架构拆分**——顺序反了，重构的风险会显著高于收益。

> **后记（2026-09-16）**：上面两条建议都已被执行，且顺序是对的。
>
> - 安全链 P0 + P1 共 15 项全部完成，实测改动量确实以「数十行 / 单文件」为主 —— 当初
>   「改动面大、收益低」的预估偏保守，这也是为什么 TODO 里的 X2 从「延后」改成了「已完成」。
> - 工程化护栏先落地（ESLint + 三层测试），`App.tsx` 拆分紧随其后。拆分过程中
>   typecheck 一次通过、既有主进程测试未回归，说明护栏确实起了作用。
> - **一条值得记住的经验**：审查结论本身也要被核对。本报告中至少三处判断在动手时被证伪
>   或修正 —— P1（配置损坏未备份，实际已备份）、N11/D2（两套日期分组，实际粒度不同不该合并）、
>   P0 引入的路径授权 bug（正向用例漏测）。把它们记在 C.6 / C.3 / B.9 里，
>   是为了让下一次审查知道「这里是踩过的」。

---

## 附录 A：P0 修复记录

实施日期：2026-09-15　｜　改动文件：`electron/main.js`、`electron/preload.js`、`src/App.tsx`、`src/types/global.d.ts`、`.gitignore`、`default.profraw`（取消跟踪）

### A.1 沙箱（对应 S1）

**做法**：删除无条件追加的三个开关，改为「默认开启沙箱 + 显式逃生口」。

```js
const SANDBOX_DISABLED = !app.isPackaged && process.env.PHOTOMINDER_DISABLE_SANDBOX === '1';
if (SANDBOX_DISABLED) { /* no-sandbox / disable-setuid-sandbox / disable-gpu-sandbox */ }
// webPreferences: sandbox: !SANDBOX_DISABLED
```

**为什么不是「直接删掉」**：实测发现当前受限执行环境**无法初始化 Chromium 沙箱**（`sandbox initialization failed: Operation not permitted`），这正是当初加 `no-sandbox` 的原因。若直接删除，开发者在同类环境里将无法启动应用。因此保留一个**必须主动打开**的开关，并用 `!app.isPackaged` 保证**打包产物永远强制开启沙箱**——不安全配置不会被带到用户机器上。

`preload.js` 只使用 `contextBridge` / `ipcRenderer` / `webUtils`，三者均为沙箱安全 API，无需改动即可兼容 `sandbox: true`。

### A.2 路径白名单（对应 S2 / S3）

**做法**：在 `main.js` 引入会话级授权表，并新增 `authorize-paths` IPC 作为拖放入口。

| 组件 | 说明 |
|---|---|
| `authorizedRoots` / `authorizedFiles` | 会话级授权集合（目录 / 单个文件） |
| `canonicalize()` | 优先 `fs.realpathSync.native` 解析符号链接，失败退回 `path.resolve` |
| `comparable()` | Windows 下统一小写后再比较 |
| `isPathAuthorized()` | 用 `path.relative` 判定包含关系，**避免 `/a/bc` 被误判为在 `/a/b` 之下** |
| `authorizePaths()` | 批量登记；路径暂不存在时按有无扩展名推断形态（兼容「外接卷未挂载」） |

**授权入口（只有这几处能产生授权）**

1. `select-paths` / 菜单导入 → `openImportDialog()` 中登记
2. `choose-directory` → 登记所选目录
3. `scan-directory` → 扫描即授权
4. `watch-directory` → 登记
5. `check-paths` → 对存在的路径登记（支撑「重启恢复图库」）
6. `authorize-paths`（新增）→ 拖放进窗口的路径

**校验点（共 14 处 handler + 1 处协议）**

| 类别 | 位置 | 未授权时的行为 |
|---|---|---|
| 协议 | `pm://file/<base64url>` | 返回 **403 Forbidden**，并记一条 warn（不记录路径本身） |
| 危险操作 | `read-file`、`write-file-unique`、`delete-file`、`rename-file`（源+目标）、`move-files`（源逐条 + 目标整批）、`open-path`、`show-in-folder`、`copy-image` | 返回明确错误「未授权的路径…」 |
| 探测类 | `stat-files`、`get-image-hashes` | 归入 `failedPaths` / 返回 `null`，与「读不到」走同一条降级路径，不额外暴露路径是否存在 |
| 元数据 | `get-metadata`、`get-thumbnail`、`cache-thumbnail` | 返回明确错误 |

**顺带修掉的一个真实漏洞**：`write-file-unique` 此前把渲染层传来的 `fileName` 直接 `path.join(targetDir, fileName)`，`../../` 前缀可把文件写到授权目录之外。现改为 `path.basename()` 归一化并拒绝 `.` / `..`。

**安全边界（写在代码注释里，避免被误认为更强的保证）**：这层防的是「内容级攻击」——被当作图片加载的 SVG、将来可能引入的远程内容等，它们能构造 `pm://` 请求但**无法调用 IPC**。对于「渲染进程被完全攻破」的场景，攻击者天然拥有全部 IPC 能力，IPC 层无法拦住，需要靠 CSP（P1-6）与沙箱（已修复）收敛。

### A.3 体积闸门（对应 S5 / I3）

| 位置 | 上限 | 错误文案 |
|---|---|---|
| `read-file` | 64MB（源文件；HEIC 转码产物再判一次） | 「文件过大（X MB），超过 64.0MB 的单次读取上限」 |
| `ai-analyze` | 20MB base64（≈15MB 原图） | 「图片过大（约 X MB），AI 分析单次上限约 20MB。可先用「导出」转成较小的 JPEG 后再分析。」 |

闸门都设在**读取之前**（先 `stat` 再决定是否读），避免「base64 已经进了内存才判断」。

> 附带发现（建议纳入 P1）：`DetailsPane` 的 AI 分析路径是把**原图**整份 `readFile` → base64 后上传，渲染层没有做缩放。更合适的做法是在渲染层先缩到长边 ~1568px 再提交，可同时改善体积、耗时与上游接口的接受率。本次仅按 P0 要求加了主进程闸门。

### A.4 构建残留（对应 B1）

`git rm --cached default.profraw`（文件保留在磁盘），`.gitignore` 新增 `*.profraw` / `*.profdata`。

### A.5 验证

| 验证项 | 结果 |
|---|---|
| `node --check electron/main.js` / `preload.js` | 通过 |
| `npm run typecheck`（tsc app + node 两个 project） | 通过，零错误 |
| `npm run build`（vite build） | 通过 |
| 路径比较边界用例（15 项） | 全部通过 —— 含 `/a/b` vs `/a/bc` 前缀穿透、`..` 穿越、绝对路径、空值 |
| 主进程集成测试（37 项） | 全部通过 —— 打桩 electron 加载真实 `main.js`，逐项验证 14 个 handler 的拒绝行为、`pm://` 403/200、三条授权链路、体积闸门、文件名穿越防护 |
| 端到端启动 | 通过 —— 应用正常启动，渲染进程经 preload 成功调用 `watch-directory` 并恢复图库 |

### A.6 未做的事（明确边界）

- **未加 CSP**（P1-6）：`index.html` 仍无 CSP，`pm` 协议仍为 `bypassCSP: true`。这是 P1 的第一项。
- **未改 `vite.config.mts` 的 `host: '0.0.0.0'`**（P1-6）。
- **未做 `buildUniquePath` 的 TOCTOU 修复**（P1-7）。
- **未统一 IPC 返回协议**（P1-8）——因此本次新增的错误分支沿用了各 handler 既有的返回形状，没有引入第三种风格。
- **未在渲染层做 AI 图片缩放**（见 A.3 附带发现）。

---

## 附录 B：P1 修复记录

实施日期：2026-09-16　｜　P1 共 10 项（编号 6–15），本文记录已完成部分。

### B.1 状态总览

| # | 动作 | 状态 |
|---|---|---|
| 6 | 注入 CSP（meta + `onHeadersReceived`），`vite` host 改 `127.0.0.1` | ✅ |
| 7 | `buildUniquePath` 改用 `fs.open(path, 'wx')` 原子创建 | ✅ |
| 8 | 统一 IPC 返回协议为 `Result<T>`，主进程 `wrapHandler` 包裹 | ✅ |
| 9 | 统一 `sanitizeFilename` 为唯一文件名规范化入口，`RenameModal` 复用 | ✅ |
| 10 | `joinPath` 替换为 `path` 语义实现 | ✅ |
| 11 | 引入 ESLint + Prettier | ✅ 见 B.7（TS 侧降级） |
| 12 | 为纯函数层补单元测试 | ✅ |
| 13–15 | 拆 `App.tsx` / 抽 `ActionDescriptor[]` / 抽 Modal 基座 | ⏸ 并入 P2 架构批次 |

> P1 全部 10 项处理完毕。13–15 未做，但**不是遗漏**：它们与 P2-20/21/29/30/32 动的是同一批文件
> （`App.tsx` 拆分、hook 抽取、Modal 基座），分批做等于把同一批文件翻两遍，因此并入 P2 一起改。

### B.2 CSP（对应 S4 / S6）

- 策略唯一定义在新增的 `electron/lib/csp.cjs`，主进程 `onHeadersReceived` 与 Vite 构建期注入的 `<meta>` **共用同一份字符串**，避免两处各写一份导致漂移。
- 生产策略 `default-src 'none'` 起手，逐项放行；`script-src` 生产**不给** `'unsafe-inline'`。开发策略额外放行内联脚本与 HMR 的 ws —— 因为 `@vitejs/plugin-react` 会注入内联的 RefreshRuntime 前导脚本，不给会直接白屏。
- meta 版本剔除 `frame-ancestors`：该指令在 `<meta>` 中被规范忽略，带上去只会多一条控制台告警。
- `vite.config.mts` 的 `host` 由 `0.0.0.0` 改为 `127.0.0.1`；`electron:dev` 的 `ELECTRON_START_URL` 同步改为 `127.0.0.1`（否则在 localhost 解析到 `::1` 的机器上连不上只绑了 IPv4 的服务器）。

### B.3 原子占位（对应 C1）

`buildUniquePath`（`existsSync` 探测 + 再写）替换为 `reserveUniquePath`（`open(path, 'wx')` 独占创建，EEXIST 则递增序号）。三处调用方（重命名 / 移动 / 导出写盘）一并改造，因为「只换探测函数」无法消除竞态 —— 落盘原语本身也得是原子的：

- **重命名 / 移动**：先原子占位，再 `rename` 覆盖自己占下的占位文件（POSIX 语义）。失败时 `discardReservedPath` 清掉占位，不留空文件。
- **跨卷移动**：占位文件已存在，因此 `copyFile` 不再用 `COPYFILE_EXCL`（否则必然失败），改为普通复制覆写自己的占位。
- **导出写盘**：占位后直接写入。

### B.4 统一 IPC 返回协议（对应 I2 / F3）

- 全部 30 个 handler 收敛为 `{ ok: true, data }` / `{ ok: false, error, code? }`。
- 新增 `handle()` 注册函数包裹 `ipcMain.handle`：异常统一兜底为 `fail()`、带通道名的日志、重复注册检测。**不允许**再直接调用 `ipcMain.handle`（已有静态断言守着）。
- 副产品：删掉了 20 余处重复的 `try/catch`。
- `global.d.ts` 重写为 `IpcResult<T>`，`tsc` 直接给出 123 处渲染层破坏点，逐一迁移 —— 这是本次重构的安全网。

### B.5 文件名与路径（对应 F1 / F2）

- `sanitizeFilename` 加固为唯一规范化入口（非法字符、控制字符、保留设备名、尾部点/空格、255 字节截断、空结果兜底），并新增 `validateFilename` 供 UI 报错。
- 建立并测试了一条不变式：**`validateFilename(name).ok` ⟹ `sanitizeFilename(name) === name`**，即「校验通过的名字规范化后原样不变」。这从机制上杜绝了「预览显示合法、落盘却被改名」。
- `RenameModal` 删掉自带的 `INVALID_CHARS` 正则与保留名集合，改为复用 `validateFilename`。
- `joinPath` 重写为对齐 `node:path.join` 语义，修掉了空目录产出 `/a`、`//` 折叠、`.`/`..` 折叠、以及「用目录里有没有反斜杠猜平台」（POSIX 下反斜杠是合法文件名字符）。

### B.6 验证体系

本次建立了三层验证，全部纳入 `npm run test`：

| 层 | 位置 | 建立时规模 | **当前规模（2026-09-16）** |
|---|---|---|---|
| 纯函数单测（vitest） | `tests/unit/` | 174 项 | **266 项** / 10 文件，覆盖 filters / mapMath / placeIndex / photoGrouping / pathUtils / photoTime / dhash / placesData / repairFileName+clusterBySize / utilsBarrel |
| 主进程集成测试（打桩 electron） | `tests/main-process/` | 69 项 | **88 项**（22 + 18 + 48），覆盖 IPC 协议形态、路径白名单、`pm://` 403、体积闸门、文件名穿越、原子占位、存储恢复通知、沙箱与 CSP 静态断言 |
| 端到端冒烟（真启动 Electron） | `tests/smoke/` | 1 项 | 校验 CSP 未误伤应用、渲染层无错误、`#root` 有产出、preload 暴露 API |

脚本：`npm run test`（= `test:main` + `test:unit`）/ `test:main` / `test:unit` / `test:smoke`。
冒烟**不并入** `test`：它要真启动 Electron，在本机受沙箱限制必须走 `test:smoke:no-sandbox`
（见 C.8），并入会让默认测试在本环境恒失败。

### B.7 ESLint + Prettier（对应 B2）

已落地，但 **TypeScript 侧处于降级状态**，原因值得记录：

- 本项目的 TypeScript 是 **7.x（原生移植版）**，而 `typescript-eslint` 的 peer 范围是
  `typescript >=4.8.4 <6.1.0`。ESLint 启动时会直接打印
  `typescript-eslint does not support TS 7.0`，其解析器无法加载。
- 因此 `eslint.config.mjs` 做成**能力探测**：装得上就开类型感知规则，装不上就退化为只检查
  JS/CJS。**降级后仍有实际价值** —— 主进程（路径白名单、CSP、IPC 兜底这些安全边界所在）
  与构建脚本都是 JS/CJS，本来就在这一侧。
- 当前 `npm run lint` 结果为 **0 problems**。过程中修掉的真实问题：
  - `catch (error)` 但从未使用 `error`（2 处）→ 改为 `catch {`
  - `throw new Error('DeepSeek 请求超时')` 丢掉了原始错误 → 补 `{ cause: error }`
  - 6 条失效的 `eslint-disable` 指令：其中 4 条 `no-await-in-loop` 通过**启用该规则**
    恢复生效（作者用它们标记「此处串行是刻意的」），2 条 `global-require` 属插件规则、
    本项目不用，替换为说明性注释
- Prettier 已配置但**未对既有文件执行格式化**：仓库从未格式化过，一次性 `--write` 会产生
  数千行 diff，把本次的安全改动淹没。新文件已格式化；全量格式化建议单独找时间做
  （`npm run format`），不要和功能改动混在一起。

### B.8 未完成项

- ~~**P1-13/14/15 并入 P2**~~：13 已于 2026-09-16 完成（附录 D.1）；14 / 15 仍在 P2 遗留（附录 D.5）。
- **CI 未接**：lint / test / build 都能本地跑通，但没有自动化流水线（见 TODO X8）。
- **全量 Prettier 格式化**：见 B.7，建议独立执行（已回填 TODO F17）。

### B.9 P1 过程中新发现的真实缺陷（均已修或记录）

| 严重度 | 问题 | 处置 |
|---|---|---|
| **高** | **P0 引入的路径授权 bug**：`canonicalize` 对**尚不存在**的路径（重命名/导出的新目标名）退化为 `path.resolve`，拿到未解析符号链接的形式；而授权根存的是 realpath 形式。在 macOS 上 `/var` → `/private/var`，导致**临时目录下的合法重命名被整体判为未授权**。P0 的测试只覆盖了「拒绝未授权」的负向用例，正向路径漏掉了 | ✅ 已修：改为向上找最深已存在祖先做 realpath 再拼回尾部；并补了回归用例 |
| 中 | `sortPhotosByTimeline` 注释称「缺失时间戳的条目排到末尾」，实现用 `\|\| 0` 实际排到**最前** | ⚠️ 已记录在测试中，未改行为（需产品决定） |
| 低 | `clusterBySize` 注释称「±10%」，实现是**以簇内最小体积为锚点**，实际区间 `[anchor, anchor×1.1]` 不对称 | ⚠️ 已记录在测试中 |
| 低 | `repairFileName` 会把扩展名转成小写（`photo.JPG` → `photo.jpg`） | ⚠️ 已记录在测试中 |
| 低 | `extOfName('.gitignore')` 返回 `'gitignore'` 而非 `''`（照片库扫描阶段已跳过点开头条目，无实际影响） | ⚠️ 已记录在测试中 |
| 低 | `getDateGroupKey` 的模块级缓存与 `todayKey` 绑定，跨天时依赖传入值变化来失效 | ✅ 已补跨天失效用例 |

---

## 附录 C：P2 修复记录（进行中）

实施日期：2026-09-16 起　｜　P2 共 20 项 = 原 17 项（编号 16–32）+ 并入的 P1-13/14/15。
**本附录记录前半批（收敛类）；后半批（拆分类 / 分层 ErrorBoundary / places 外置）见附录 D。**

### C.1 状态总览

> **本节状态已于 2026-09-16 刷新**：27 / 30 已完成，13 完成、14 / 15 并入遗留；
> 后续完成的第 13 / 27 / 30 项记录在**附录 D**。

| 批次 | 覆盖项 | 状态 |
|---|---|---|
| 收敛类 | 17 dHash 单一实现 | ✅ |
| 收敛类 | 18 照片时间语义收敛 | ✅ |
| 收敛类 | 19 搜索索引缓存 / 22 缓存 LRU / 24 存储损坏通知 | ✅（24 原判断有误，见 C.6） |
| 收敛类 | 27 places 外置 | ✅ → 附录 D.3 |
| 拆分类 | 16 拆 `utils/index.ts` | ✅ |
| 拆分类 | 13 `App.tsx` hooks | ✅ → 附录 D.1 |
| 拆分类 | 14 ActionDescriptor / 15 Modal 基座 | ⏳ 待做（附录 D.5） |
| 拆分类 | 20 图标库·虚拟化·布局常量 | ⏳ 待做（附录 D.5） |
| 性能与交互 | 23 受控并发 / 29 `useBatchOperation` / 25 播放器状态机 / 26 导出分块 / 31 地图缓存 | ⏳ 待做（29 部分完成） |
| 收尾 | 30 分层 ErrorBoundary | ✅ → 附录 D.4 |
| 收尾 | 32 注释清理 | 🔶 部分完成（`RenameModal` 尚有 1 条） |

### C.2 dHash 收敛为单一实现（对应 U1 / D1）—— 已完成

**改造前**：同一算法有两份手写实现 —— 主进程 `dHashFromBitmap`（`electron/main.js`）
与渲染层 `dHashFromPixels`（`src/utils/index.ts`）。二者只要有一处被改动
（亮度权重、采样尺寸、比较方向、位打包顺序），同一张图在两处就会算出**不同的哈希**；
而重复检测正是拿哈希互相比较的，于是会**静默**漏判或误判，没有任何报错。

**改造后**：算法本体只定义一次，位于 `electron/lib/dhash.cjs`，两边都从这里取：

| 使用方 | 方式 |
|---|---|
| 主进程 | `require('./lib/dhash.cjs')`，`dHashFromBitmap` 退化为转交 BGRA 的薄封装 |
| 渲染层 | `import { dHashFromRGBA } from '../../electron/lib/dhash.cjs'`（Vite 做 CJS 互操作） |

已实测确认这是**真收敛而非镜像副本**：构建产物中出现
`var n=9,r=8,i=.299,a=.587,o=.114,s=16`，即共享模块被完整内联进 bundle。

**仍然存在的差异（不是算法问题）**：「把原图缩到 9x8」这一步两边工具不同 ——
主进程用 `nativeImage.resize`，渲染层用 `createImageBitmap` / canvas `drawImage`。
重采样算法不同，极少数处在阈值边界的像素可能翻转，让哈希差 1~2 bit。
因此渲染层实现**只作为主进程不可用时的降级路径**（如主进程解不了的 SVG），
正常流程一律走 `get-image-hashes` 由主进程计算。

**顺带修掉的一处**：共享实现对字节数不足的输入返回 `null`，而旧的渲染层实现从不返回 null
（会产出垃圾哈希）。现在渲染层的包装函数改为**抛错**而不是把 null 传下去 ——
`getImageData(0,0,9,8)` 恒为 288 字节，真走到 null 只可能是调用点采样尺寸写错，
那是编程错误，应当立刻炸出来；返回半截哈希更糟。

**验证**：`tests/unit/dhash.test.ts` 13 项，含
①确定性（纯色图全 0、单调递减全 1、长度恒为 16 位十六进制）；
②RGBA/BGRA 等价性 + 反向保险（R/B 交替图必须能区分排布，否则等价性断言失去意义）；
③异常输入（字节不足返回 null、多余字节被忽略）；
④**跨入口一致**：静态断言渲染层源码中不再出现自己的亮度权重常量，且确实从共享模块引入。

### C.3 照片时间语义收敛（对应 N11 / D2）—— 已完成

**先纠正一处原报告的判断**：`photoGrouping.getDateGroupKey`（按**日**分组，用于网格列表头）
与 `TimelineGallery.groupByTime`（按**年→月**分组，用于时间线导航）**不是同一件事的重复实现** ——
粒度本就不同，不应合并。原报告把它们并列为「两套实现」并不准确。

真正的问题是另一件事：**「取照片有效时间」的回退链在 12 处被各自内联，且存在两种不同定义**：

| 链 | 出现位置 | 语义 |
|---|---|---|
| `dateTaken → lastModified`（2 级） | 分组 / 筛选 / 排序 / 时间线 / 重命名预览 / 网格吸顶日期 | 「这张照片是什么时候拍的」 |
| `dateTaken → dateCreated → lastModified`（3 级） | 原图判定 / 日期修正弹窗 | 「原始时间基准」 |

对「有文件创建时间但没有 EXIF 拍摄时间」的照片，两者给出**不同的时间**。这本身是刻意设计，
但散成十几份内联表达式之后，就再也分不清哪些是刻意不同、哪些是抄漏了 —— 抄漏的后果是
**网格分组与筛选结果自相矛盾**。

**改造**：新增 `src/lib/media/photoTime.ts` 作为唯一入口，把两种语义各自命名并说明适用场景：

- `photoTakenTime(photo)` —— 2 级链，面向展示
- `photoOriginalTime(photo)` —— 3 级链，面向「哪份是原图」的判定（`@/utils` 改为再导出，兼容既有引用）
- `calendarDayKey(ts)` —— 本地日历日 key，集中说明「不能用 UTC 日界」的原因
- `hasUsableTime(ts)` —— 显式排除 `NaN`（`!NaN` 为真，只写 `!ts` 会漏判）

12 处调用点全部改为按语义选用函数。`AdjustDateModal` 里那份连注释都抄了一遍的
`baseTimeOf` 已删除。

**验证**：`tests/unit/photoTime.test.ts` 18 项，含一条**静态断言**扫描 `src` 全部 `.ts/.tsx`，
确保回退链不会在调用点重新内联（附清晰的报错信息指向该用哪个函数）。

**测试过程中发现的真实限制（新增记录）**：

> 回退链 `dateTaken || dateCreated || lastModified` **无法区分「共享 EXIF 拍摄时间的拷贝」** ——
> 两张拷贝拍摄时间相同，链式求值在第一步就返回了，`dateCreated` 根本没被用到。
> 而「拷贝件继承 EXIF 拍摄时间」正是重复检测里最典型的场景。
> 所以重复检测用的是**逐字段比较**的 `compareByOriginalTime`，而不是回退链。
>
> 由此引出一个**尚未修复的不一致**：`LocationMap` 用
> `photoOriginalTime(a) - photoOriginalTime(b)` 排序，在「同组共享 EXIF」时全是并列，
> 排不出先后；而重复检测用 `compareByOriginalTime` 能排出。
> 两处对「哪张是原图」的判断因此可能不一致。建议后续把 `LocationMap` 也改用
> `compareByOriginalTime`（属行为变更，未擅自改）。

### C.4 缓存与搜索索引（对应 U2 / U5 / G2）—— 已完成

**`placeIndex` 的整表清空改为真 LRU**（`src/lib/geo/placeIndex.ts`）：

原实现是普通 `Map` + `if (cache.size >= CACHE_LIMIT) cache.clear()`。一次清空会让刚查过的
地名全部重算，而地图标签**每帧都在查**，表现为拖动时周期性的卡顿尖峰。
改用项目已有的 `createLruCache` 后：
1. 只淘汰最久未用的条目，热点地名（当前视野附近）始终留在缓存里；
2. 自动纳入 `cacheManager` 注册表，系统内存吃紧时会被统一裁剪。

`dateKeyCache` 的 `clear()` 保留 —— 那是**跨天失效**（日期语义变了，旧文案本就作废），
与「容量淘汰」是两件事，不应混为一谈。

**搜索索引缓存**（`src/lib/filter/filters.ts`）：

`matchesSearch` 原先每次调用都要对**每张照片**重新做一遍 `toLowerCase()`
（文件名 / MIME / 相机 / 每个标签 / AI 描述）。一万张图 × 每次按键 = 每帧几万次字符串分配，
输入框因此明显发涩。

现在用 `WeakMap<Photo, {fingerprint, haystack}>` 缓存预小写的 haystack。
选 `WeakMap` 是因为照片更新走的是**整体替换**（`{...p, ...updates}`），
旧对象失去引用后条目自动回收，不需要手工清理。

一个容易踩的坑（已写进测试）：**相机标识必须整体入索引**，不能拆成厂商与机型两段 ——
`cameraKeyOf` 可能返回「厂商 + 机型」拼接结果，拆开放入会让 `canon eos` 这类
跨字段关键词匹配不到（`'…canon\u0000eos r5…'.includes('canon eos')` 为 false）。

### C.5 存储损坏通知（对应 P1）—— 已完成

**先更正原报告的一处误判**：原报告称「配置损坏时**没有**把损坏的原文件备份」。
经核对 `git show HEAD:electron/main.js`，备份逻辑（`rename` 到 `*.corrupt-<时间戳>`）
**在审查时就已经存在**。该条判断有误。

但报告建议的后半句确实没做：**「并 Toast 告知用户」**。原来的备份是完全静默的 ——
用户只会发现「相册/收藏凭空消失」，既不知道原因，也不知道磁盘上有一份备份可以捞回来。

**改造**：
- 主进程新增 `storageNotices` 队列；`readStore` 只有在**改名真的成功**时才入队
  （文件不存在导致的失败是「首次运行」，不该提示用户）；
- 新增 IPC `storage-notices`，**取走即清空**（一次性事件，反复提示只会变成噪音）；
- 渲染层在启动加载完配置后调用一次，非空时 Toast 告知「哪个文件损坏、备份在哪」。

**验证**：新增 `tests/main-process/storage-recovery.test.cjs` 18 项，覆盖
「备份留证 → 备份内容与原文一致 → 从空配置继续启动 → 通知内容完整 → 取走即清空 →
恢复后仍可正常写入 → 不误伤其它存储」。

> 该测试**必须单独成文件**：`app.on('ready')` 会预读 `config.json` / `ai-config.json`
> 并写入 `storeCache`，因此损坏文件必须在 `require(main.js)` **之前**放好 ——
> 加载之后再往目录里放是不会被重读的。脚手架为此新增了 `beforeRequire` 钩子。
> 另外 `ready` 里的 `Promise.all([readStore(...)])` 是 fire-and-forget，
> 断言前需要等一个宏任务让改名落地。

### C.6 原报告中的一处误判（需记录）

| 编号 | 原判断 | 核对结果 |
|---|---|---|
| P2-24 / 配置损坏备份 | 「没有把损坏的原文件备份」 | **不成立** —— 备份逻辑在 HEAD 中已存在。真正缺的是「告知用户」这半句，已在 C.5 补上 |

记录这条是为了说明：审查结论也应当被核对。这一处是在动手修的时候才发现前提不成立的。

### C.7 拆分 `utils/index.ts`（对应 A2）—— 已完成

**改造前**：1024 行单文件，混装 6 个互不相关的领域 —— 想看 `formatBytes` 得先翻过
500 行哈希聚类代码；改一处哈希算法要承担误伤格式化函数的心理成本。

**改造后**：`src/utils/index.ts` 缩到 **86 行的纯再导出 barrel**，实现按领域拆成 9 个模块：

| 模块 | 行数 | 领域 |
|---|---|---|
| `@/lib/duplicate/duplicateDetection` | 486 | 重复检测（预筛 / 聚类 / 并查集 / 进度 / 取消） |
| `@/lib/fs/pathUtils` | 222 | 路径与文件名（含 `folderOfPath` / `extOfName` / `pmFileUrl`） |
| `@/lib/media/mediaTypes` | 202 | 媒体类型判定 + 智能分类 |
| `@/lib/media/filenameRepair` | 198 | 乱码修复与文件名清理 |
| `@/lib/media/photoHash` | 162 | dHash 与汉明距离 |
| `@/lib/media/photoTime` | 106 | 照片时间语义 |
| `@/lib/format/format` | 61 | 展示格式化 |
| `@/lib/concurrency` | 42 | 并发受控的 map |
| `@/lib/fs/fileToBase64` | 27 | File → base64 |

**关键设计：保留 barrel，既有 `from '@/utils'` 的引用一行都不用改。**
这让迁移变成零破坏的重构 —— 否则要同时改 20 多个文件的 import，一旦漏改就是编译错误刷屏，
反而看不清真正的行为变化。

**顺带解掉的一个循环依赖风险**：`mediaTypes.ts` 原先从 `@/utils` 取 `extOfName` / `isVideoPhoto`。
一旦 `@/utils` 变成 barrel 再导出 `mediaTypes`，就会形成 `utils → mediaTypes → utils` 的环。
现在 `mediaTypes` 只依赖 `pathUtils` 与 `types`，且 `isVideoPhoto` 就在自己文件里。

**新增守卫**：`tests/unit/utilsBarrel.test.ts` 40 项，守住两件事 ——
① 34 个公开符号一个都不能少（删导出立刻失败）；
② barrel 里不允许出现任何实现代码（按 `;` 切分语句逐段校验，只允许 import/export），
并断言文件规模 < 120 行。这样「拆分悄悄退化」会变成测试失败，而不是几个月后才被发现。

**顺带修掉的测试脆弱点**：`dhash.test.ts` 里那条「渲染层必须从共享模块引入 dHash」的静态断言
原本指向 `src/utils/index.ts`；拆分后该断言立刻失败（这正是静态断言的价值），
已改为指向新位置 `src/lib/media/photoHash.ts`，并**加强**为「整个 `src` 里只允许一处引用
dHash 算法本体」。

### C.8 冒烟测试的可诊断性（工具改进）

`tests/smoke/electron-smoke.cjs` 原先在环境不满足时抛 `TypeError: Cannot read properties of
undefined (reading 'on')`，看不出该做什么。现在：

- `require('electron')` 拿不到 `app` 时，直接打印**可操作的排查步骤**并以 2 退出
  （常见诱因：环境注入了 `ELECTRON_RUN_AS_NODE`，或把本命令与 `npm run xxx` 串在同一条
  shell 命令里 —— npm 会污染子进程环境）；
- 窗口始终没加载完成时以 3 退出并提示沙箱逃生口 —— 这一条尤其重要：
  页面压根没跑起来时「CSP 违规 0」是**假阴性**，不能当成通过。

另新增 `npm run test:smoke:no-sandbox`（带 `PHOTOMINDER_DISABLE_SANDBOX=1`）。
本机无法初始化 Chromium 沙箱，不带逃生口时 Electron 会直接 `FATAL: GPU process isn't usable`
崩溃（退出码 133），因此**本环境只能用这个脚本跑冒烟**。默认的 `test:smoke` 保持不带逃生口，
以免在正常机器上白白跳过沙箱路径。

---

## 附录 D：P2 后半批（实施日期 2026-09-16）

覆盖：**P2-13**（`App.tsx` 拆分）、**P2-27**（places 外置）、**P2-30**（分层 ErrorBoundary），
以及配套的 `ToastStack` 抽出。改动文件：`src/App.tsx`、新增 `src/hooks/*`（15 个）、
新增 `src/components/layout/ToastStack.tsx` / `src/components/common/ViewErrorFallback.tsx`、
`src/lib/geo/places.ts` + `places.data.json`、`tsconfig.app.json`。

### D.0 本轮验证结果

全部为实际执行结果，非推断：

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过，零错误 |
| `npm run build` | 通过。主 bundle `663.05 kB`（gzip 184.41）+ 地名 chunk `58.80 kB`（gzip 24.42）+ CSS `101.26 kB` |
| `npm run lint` | **0 problems**（TS 侧降级，见 B.7） |
| `npm run test:unit` | **266 项通过** / 10 个文件 |
| `npm run test:main` | **88 项通过** / 3 个文件（22 + 18 + 48） |
| `npm run test:smoke` | 本环境需用 `test:smoke:no-sandbox`（见 C.8） |

### D.1 拆 `App.tsx`（P2-13，对应 A1 / R1）—— 已完成

**改造前**：3707 行单组件，承载导入管线、单张 / 批量重命名、删除、移动、拖放、全局快捷键、
右键菜单装配、约 40 个 state 与数十个 `useMemo`。任何一处 state 变化都触发整棵子树 reconcile，
且**无法对任何单一功能写测试**。

**改造后**：`App.tsx` **1279 行**，只做两件事 —— 组合 hooks、视图路由。逻辑按功能域拆到
`src/hooks/`，新增 15 个 hook 共 **3856 行**（目录内另含既有的 `useToasts` / `useThemeMode` /
`useDuplicateDetection`，合计 18 个 / 4287 行）：

| 分组 | hook | 行数 | 职责 |
|---|---|---|---|
| 编排 | `useAppConfig` | 312 | 启动加载配置、视频元数据回写、视图偏好落盘 |
| | `useLibraryImport` | 452 | 高层导入编排（对话框 / 拖放 / 菜单 / 点来源 → 一条链路）+ 恢复图库 |
| | `useIngestPipeline` | 316 | 入库管线（去重、分批、进度、取消）+ 元数据批量补齐 |
| 数据 | `usePersistedLibraryData` | 248 | 收藏 / 隐藏 / 标签 / 时间修正 / AI 结果等「按路径存储」的数据与路径迁移 |
| | `useLibraryDerived` | 209 | 全部派生数据：分组、时间线、实况配对、可见列表、侧栏统计、空状态判定 |
| | `useLibrarySources` | 196 | 常驻来源（N8）的记录与移除 |
| 交互 | `useSelection` | 145 | 选择集与区间连选锚点、筛选变化后自动收敛 |
| | `useFileOperations` | 742 | 重命名 / 删除 / 移动三条链路（提交锁、回环防护、失败分流） |
| | `useFileOpFeedback` | 76 | 统一进度反馈（K19：超 320ms 才升遮罩） |
| | `useDragAndDrop` | 343 | 拖放分流（媒体文件 / 文件夹 / 无路径降级）与遮罩进出场 |
| | `useKeyboardShortcuts` | 284 | 全局键盘闭环 + 方向键导航 + 焦点让行 |
| | `useQuickLook` | 116 | 预览开关、翻页范围与相邻预加载 |
| 其它 | `useSmartAlbums` | 76 | 智能相簿（只存筛选条件） |
| | `useWatcherSync` | 254 | 目录监听与外部变动同步（含回环双保险） |
| | `useCollapseAnimation` | 87 | 删除后的塌陷动画与 blob URL 回收 |

**拆分原则（三条，后续继续拆时照此办理）**

1. **按「状态 + 副作用」的归属分，不按 JSX 分。** 一个 hook 自持它的 state、refs 与副作用，
   对外只暴露回调与派生值。这样 `App.tsx` 里的每一段都是在「读什么、调什么」，读起来是目录而不是实现。
2. **保留显式参数传递，不引入 Context。** 15 个 hook 之间存在依赖（如 `useFileOperations`
   需要 `usePersistedLibraryData` 的路径迁移函数）。全部走参数传入而非全局 Context ——
   Context 会让「谁改了什么」重新变得不可见，恰好是拆 3707 行想解决的问题。
3. **不改行为。** 本次是纯结构迁移：hook 内部的判断分支、边界条件、文案逐条照搬，
   没有顺手「优化」。因此回归面等于「有没有漏搬」，而这一点由 typecheck + 既有手工验证覆盖。

**尚未解决的部分（不假装完成）**

- `App.tsx` 仍是**组合层最长的一块**（1279 行），其中相当部分是 JSX 与 modal 装配。
  真正的下一步是拆 `ActionDescriptor[]`（P2-14）与 Modal 基座（P2-15），但两者都属行为收敛，
  不在本批范围内。
- **没有给这些 hook 补测试。** 它们依赖 `window.electronAPI` 与真实 React 渲染时序，
  需要一套 preload 打桩 + `@testing-library/react` 才测得动；本批只做到「可测性不再为零」。
- `R2`（四条写盘管线同构）只做到「收进一个 hook」，未抽成泛型 `useBatchOperation`。

### D.2 `ToastStack` 抽出（配套）

Toast 的渲染与队列原先内联在 `App.tsx`。抽出为 `src/components/layout/ToastStack.tsx` 后，
`useToasts` 只管状态、`ToastStack` 只管渲染 —— 与上面的拆分原则一致。行为未变。

### D.3 地名数据外置（P2-27，对应 G1）—— 已完成

**改造前**：1767 行城市数据以字符串常量内嵌在 `src/lib/geo/places.ts`。两个问题：
数据与逻辑同目录同格式；**静态导入会被打包器内联进主 chunk** —— 从不打开地图的用户，
也要在启动时解析这 50KB。

**改造后**：数据迁到 `src/lib/geo/places.data.json`（1731 条，67KB），
`places.ts` 缩到 **96 行**，只留类型与加载入口，用动态 `import()` 拉取。
构建产物中它是独立 chunk（`places.data-*.js` 58.80 kB / gzip 24.42 kB），
**只有真正进入地图视图时才加载**。

几个实现细节：

- JSON 行编码为 `[经度, 纬度, 名称, 上级, 层级]`，比逐条对象省掉 1731 份键名；
  编码说明写在 JSON 头部的 `encoding` 字段里，避免后人不看代码猜格式。
- `tsconfig.app.json` 需显式开 `resolveJsonModule`，否则 `typecheck` 不给 JSON 推类型。
- **动态 import 只允许一个入口**（`lib/geo/places.ts`）。多处各自 `import()` 虽然打包器会去重，
  但会让「到底加载了几次、缓存了没有」变成需要推理的问题。

**验证**：新增 `tests/unit/placesData.test.ts` 13 项，其中 4 项是静态断言，守住三条不退化：
① 没有任何文件**静态导入** `places.data.json`（静态导入会被内联回主 chunk，本项工作直接白做）；
② 动态 import 只有一个入口；③ 没有任何文件把城市数据行抄回源码。

### D.4 分层 `ErrorBoundary`（P2-30，对应 A4）—— 已完成

**改造前**：只有一处顶层 `ErrorBoundary`。单个面板（如 `LocationMap` 的 canvas 绘制）抛错
会让整页白屏，而顶层「重试」以相同入参重挂载，**多半会再次抛错**。

**改造后**：四个整页视图（图库 / 时光画廊 / 按地点浏览 / 重复检测）各挂一层 `ErrorBoundary`，
共用新增的 `ViewErrorFallback`（`src/components/common/ViewErrorFallback.tsx`）：
降级为「该视图不可用 + 一键返回图库」，其余部分继续可用。
此外详情面板也挂了一层，但用的是**内联降级**（保留 320px 侧栏宽度的一句提示）而非整页接管 ——
面板是附属区域，让它把主内容区顶掉反而不合理。

**仍未做**：主进程没有 `uncaughtException` / `unhandledRejection` 兜底；
`Toolbar` 与各 modal 仍只有顶层那一层。已回填 TODO 的 K4，并将其优先级由「低」上调为「中低」——
主进程缺兜底意味着触发后是整个应用静默退出，比原来的「只是白屏」后果更重。

### D.5 本轮遗留（P2 剩余 11 项 + 工程化收尾）

按「动的是哪批文件」重排，避免同一批文件翻两遍：

| 批次 | 项目 | 说明 |
|---|---|---|
| **组件层收敛** | 15 Modal 基座、20 虚拟化 hook、21 图标库、28 布局常量、31 地图离屏缓存 | 都在 `components/`，可一次做完 |
| **交互与状态** | 14 `ActionDescriptor[]`、25 播放器 `useReducer`、29 `useBatchOperation` | 属行为收敛，需逐项验证 |
| **性能** | 23 受控并发（`movePhotosToTrash` 仍串行）、26 导出大图分块 | 需要真实大库才能验证收益 |
| **收尾** | 32 注释清理（`RenameModal` 尚有 1 条失效 `eslint-disable`）、U3 重复注释 | 零风险 |
| **工程化** | CI 未接；全量 Prettier 格式化未做（会产生数千行 diff，须独立提交）；`strict: true` 未开 | 见 TODO 的 X7 / X8 / F17 |

### D.6 本轮新发现（已记录，未改行为）

| 严重度 | 问题 | 处置 |
|---|---|---|
| 中 | 「哪张是原图」两套判断：`LocationMap` 用 `photoOriginalTime(a)-photoOriginalTime(b)` 排序，重复检测用逐字段的 `compareByOriginalTime`。同组共享 EXIF 拍摄时间时前者全是并列，两处结论可能不一致 | 回填 TODO **K31**。建议 `LocationMap` 改用 `compareByOriginalTime`，但**属行为变更**（地图里的「原图」标注会变），未擅自改 |
| 低 | 四处注释与实现不符（`sortPhotosByTimeline` 排序方向、`clusterBySize` 的 ±10%、`repairFileName` 扩展名转小写、`extOfName('.gitignore')`）。已全部在测试中钉住现状 | 回填 TODO **K32**。原则是**先钉住、再决定**，避免「改注释还是改实现」变成无人负责 |
| 低 | `App.tsx` 组合层仍长（1279 行），主要是 JSX 与 modal 装配 | 见 D.1「尚未解决的部分」，依赖 P2-14 / 15 |
| — | 本轮**没有**产生新的安全面：新增代码未引入任何新的 IPC 通道、未放宽 CSP、未绕过路径白名单 | — |

