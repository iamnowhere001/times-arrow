# 架构说明

> **最后更新**：2026-11-20 · **适用版本**：0.6.5
> **事实源**：`electron/main.js`、`electron/main/`、`electron/lib/`、`src/`（分层与依赖方向由 `tests/main-process/layering.test.cjs` 断言）
>
> 这是「系统怎么分层、依赖往哪走、改一处要动哪些地方」的唯一技术地图。
> 产品方向看 [`ROADMAP.md`](../ROADMAP.md)，任务状态看 [`TODO.md`](../TODO.md)，用户行为看 [`README.md`](../README.md)。
> **标了「守卫」的条目都有可执行测试，不是建议。**

---

## 1. 设计目标

| 目标 | 在架构上的体现 |
| --- | --- |
| 纯本地 | 除可选的 AI 分析与可关闭的更新检查外，无网络能力；没有账号 / 遥测 / 云同步依赖 |
| 不丢数据 | 写盘原子替换 + 备份轮转；删除进回收站；内容指纹做持久化主键；迁移失败留 `orphans` |
| 可取消、可恢复 | 扫描 / 导入 / 导出 / 重复检测都有取消链路；跨卷移动有 `partial` 中间态 |
| 主进程管重活 | 扫描、EXIF、HEIC、dHash、缩略图都在主进程限流执行；渲染层只拿地址与元数据 |
| 唯一入口 | 文件名、时间语义、dHash、搜索、LRU、IPC 返回类型各只有一份实现 |
| agent 友好 | 领域目录清晰、单文件职责可读、边界由静态测试守住、验证只需一条命令 |

---

## 2. 进程与分层

```text
┌──────────────────────────── 渲染进程（React / ESM） ────────────────────────────┐
│  main.tsx                                                                        │
│    └─ App.tsx                 组合与视图路由                                     │
│        ├─ components/*        UI：布局 / 网格 / 整页视图 / 弹窗 / 详情           │
│        ├─ hooks/*             状态编排：导入、选择、文件操作、筛选、更新…         │
│        ├─ services/*          跨进程用例：AI 分析（经 IPC 走主进程）              │
│        ├─ lib/*               领域与基础设施纯逻辑                               │
│        ├─ types/*             领域类型 + window.electronAPI 契约                 │
│        └─ utils/index.ts      纯再导出 barrel（不得加实现）                       │
└───────────────────────────────────┬─────────────────────────────────────────────┘
                                    │ contextBridge（preload.js）
                                    │ IpcResult<T>：{ok:true,data} / {ok:false,error,code?}
┌───────────────────────────────────┴─────────────────────────────────────────────┐
│ 主进程（Node / CommonJS）                                                        │
│  electron/main.js             组合根：装配依赖、生命周期、崩溃上报              │
│    ├─ main/*.cjs              领域服务：window / menu / protocol / security /   │
│    │                          watch / fs-ops / memory-watchdog / ai /          │
│    │                          authorization / media-pipeline / store /         │
│    │                          data-assets / migrations / updater /             │
│    │                          crash-report / health                            │
│    ├─ main/ipc/               registry（ok / fail / handle）+ 按域通道注册      │
│    └─ lib/*.cjs               基础设施：csp / fingerprint / dhash / logger        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 渲染进程各层职责

| 层 | 路径 | 负责 | 不负责 |
| --- | --- | --- | --- |
| 入口 | `src/main.tsx` | 挂载 React、顶层 ErrorBoundary | 业务逻辑 |
| 组合 | `src/App.tsx` | 组合 hooks、视图路由、跨域连线 | 新业务规则（应下沉到 hook / lib） |
| UI | `src/components/` | 渲染、交互、可访问性 | 持久化、文件系统、算法 |
| 编排 | `src/hooks/` | 状态机、副作用、取消、进度 | 直接写 DOM / 直接算领域规则 |
| 用例 | `src/services/` | 跨进程用例封装（当前只有 AI） | UI 状态、组件 |
| 领域 | `src/lib/` | 纯函数、算法、缓存、持久化、格式 | React、组件、hooks |
| 契约 | `src/types/` | 领域类型、`IpcResult`、`electronAPI` | 运行时依赖 |
| 兼容层 | `src/utils/index.ts` | 纯再导出 | 任何实现 |

### 2.2 主进程各层职责

| 层 | 路径 | 负责 |
| --- | --- | --- |
| 组合根 | `electron/main.js` | 装配依赖、`app` 生命周期、崩溃上报；**不放业务逻辑** |
| 领域服务 | `electron/main/*.cjs` | 授权、存储、媒体管线、AI、更新、数据资产、迁移、崩溃、健康、窗口、菜单、协议、安全、监听、落盘工具 |
| IPC 注册 | `electron/main/ipc/` | `registry.cjs` 提供 `ok` / `fail` / `handle`（全进程唯一）；通道按域分组注册 |
| 基础设施 | `electron/lib/*.cjs` | CSP、内容指纹、dHash、日志 |
| 契约桥 | `electron/preload.js` | `contextBridge` 暴露 `window.electronAPI` |

### 2.3 允许的依赖方向

```text
components ──→ hooks ──→ lib ──→ types
     │           │        ↑
     ├───────────┴────────┘
     └──→ services ──→ lib / types

electron/main.js ──→ electron/main/*.cjs ──→ electron/lib/*.cjs
```

| 从 \ 到 | components | hooks | services | lib | types |
| --- | --- | --- | --- | --- | --- |
| components | ✅（同域） | ✅ | ✅（仅 `aiService`） | ✅ | ✅ |
| hooks | ❌ | ✅ | ❌ | ✅ | ✅ |
| services | ❌ | ❌ | ✅ | ✅ | ✅ |
| lib | ❌ | ❌ | ❌ | ✅（同层跨域） | ✅ |
| types | ❌ | ❌ | ❌ | ❌ | ✅ |

**守卫**：`tests/main-process/layering.test.cjs`。现有唯一棘轮项是 `src/components` 直连 `window.electronAPI`——额度记在该文件的 `BASELINE`，**只允许下调**，不接受新增文件。

### 2.4 跨进程契约

同一份 IPC 契约的五处同步点、返回语义、授权规则见 [`ipc.md`](./ipc.md)。这里只记结构事实：`preload.js` 是唯一暴露面，`global.d.ts` 是唯一类型面，注册只能在 `electron/main.js` / `main/*.cjs`。

**守卫**：`tests/main-process/ipc-contract.test.cjs` 静态解析四处并比对冻结通道清单。新增 / 删除通道必须显式改清单 —— 这是刻意的变更成本。

---

### 2.5 技术选型

| 分类 | 选型 | 落点 |
| --- | --- | --- |
| 桌面壳 | Electron 44 | `electron/main.js` 组合根 + `electron/main/` 领域模块 + `electron/preload.js` |
| 前端 | React 19 · TypeScript 7 | `src/` |
| 构建 | Vite 8（`@vitejs/plugin-react`） | `vite.config.mts` |
| 样式 | Tailwind CSS 4（CSS-first `@theme`）+ CSS 变量 | `src/styles/styles.css` |
| 元数据 | exifreader（只读前 512KB） | `electron/main/media-pipeline.cjs` |
| 图片格式 | heic-convert（HEIC/HEIF → JPEG，带磁盘缓存） | `electron/main/media-pipeline.cjs` |
| 内容指纹 | `sha256(size + 头尾各 64KB)` 截 128 bit | `electron/lib/fingerprint.cjs` |
| AI | DeepSeek 视觉模型，无第三方 SDK，主进程代理 | `electron/main/ai.cjs` |
| 测试 | Vitest + 自建主进程 runner + Electron 冒烟 | `tests/` |

依赖边界（能连什么、不能连什么）见 [`external.md`](./external.md)。

---

## 3. 目录地图

```text
electron/
├── main.js                 # 组合根：装配依赖 + 生命周期 + 崩溃上报（只装配，不放业务）
├── preload.js              # contextBridge → window.electronAPI
├── main/                   # 领域服务（CommonJS）
│   ├── window.cjs          #   主窗口创建 / 尺寸记忆 / 多屏保护 / send
│   ├── menu.cjs            #   应用菜单（只把点击翻译成窗口事件）
│   ├── protocol.cjs        #   pm:// 协议（流式 + HTTP Range + 每次请求的授权校验）
│   ├── security.cjs        #   CSP 安装（响应头那一半；meta 那一半在构建期）
│   ├── watch.cjs           #   目录监听（扩展名过滤 + 防抖聚合）
│   ├── fs-ops.cjs          #   落盘工具：不覆盖 / 原子占位 / 跨卷移动
│   ├── memory-watchdog.cjs #   内存看门狗（两级回收 + 广播冷却）
│   ├── ai.cjs              #   DeepSeek 代理、AI 配置读写、密钥掩码
│   ├── authorization.cjs   #   会话级路径白名单
│   ├── crash-report.cjs    #   主进程异常落盘与下次启动提示
│   ├── data-assets.cjs     #   指纹 / 配置导入导出 / 重连 / 日志 / 备份
│   ├── health.cjs          #   数据健康检查与迁移报告
│   ├── media-pipeline.cjs  #   扫描 / EXIF / 缩略图 / HEIC / dHash
│   ├── migrations.cjs      #   config / ai-cache 的 v1→v2 迁移
│   ├── store.cjs           #   JSON 存储、原子写、损坏备份
│   ├── updater.cjs         #   GitHub Release 检查 / DMG 下载 / 安装引导
│   └── ipc/                #   IPC 通道注册（按域拆分）
│       ├── registry.cjs    #     ok / fail / handle：全进程唯一实例
│       ├── files.cjs       #     重命名 / 删除 / 移动 / 导出 / 系统开放
│       └── dialog.cjs      #     导入 / 选择目录 / 授权 / stat / read-file
└── lib/
    ├── csp.cjs             #   CSP 唯一定义（响应头与构建期 meta 共用）
    ├── dhash.cjs           #   dHash 唯一实现（主进程与渲染层共用）
    ├── dhash.d.cts         #   上者的类型声明
    ├── fingerprint.cjs     #   内容指纹（size + 头尾各 64KB 的 sha256）
    └── logger.cjs          #   主进程日志器

src/
├── App.tsx                 # 组合根：状态装配 + 布局骨架（含图库视图内联）
├── main.tsx                # 挂载入口
├── components/             # 按域分组的 UI
│   ├── layout/             #   Sidebar / Toolbar / ActiveFiltersBar / ToastStack /
│   │                       #   AppViews（整页视图路由）/ AppOverlays（全部弹层与浮层）
│   ├── grid/               #   ImageGrid（工具栏与组合）/ VirtualGrid / VirtualList / ImageCard /
│   │                       #   ThumbnailImage / EmptyStates
│   ├── timeline/           #   TimelineGallery
│   ├── map/                #   LocationMap
│   ├── detail/             #   DetailsPane / QuickLook / VideoPlayer / BatchTagsPanel
│   ├── duplicate/          #   DuplicateDetector / DuplicateReportPanel
│   ├── about/              #   AboutView
│   ├── filter/             #   FilterPanel
│   ├── modal/              #   业务弹窗（设置 / 导出 / 数据资产 / 关于更新 / 确认…）
│   ├── common/             #   Toast / ErrorBoundary / ModalShell / ImmersiveView / Stat…
│   └── icons/              #   跨文件复用的通用图标（唯一入口）
├── hooks/                  # 功能域状态编排（导入 / 选择 / 文件操作 / 筛选 / 更新…）
├── services/               # aiService（经 IPC 走主进程）
├── lib/                    # 领域与基础设施
│   ├── about/              #   关于页静态内容与更新文案
│   ├── album/              #   相簿命名
│   ├── cache/              #   cacheManager / thumbCache / dragThumbnail
│   ├── dataAssets/         #   健康检查展示逻辑
│   ├── duplicate/          #   重复检测 / 忽略组 / 常量
│   ├── filter/             #   filters / libraryViewState / viewContext
│   ├── format/             #   展示格式化
│   ├── fs/                 #   fileOperations / pathUtils / ipcGuard / rename…
│   ├── geo/                #   mapMath / landMask / places / placeIndex
│   ├── grid/               #   justifiedLayout
│   ├── media/              #   photoTime / photoIdentity / mediaTypes / videoMeta…
│   ├── persistence/        #   persistence / aiCache / sources
│   ├── platform/           #   runtime
│   ├── tags/               #   tagOperations
│   ├── concurrency.ts
│   ├── contextMenuActions.ts
│   └── logger.ts
├── types/                  # index.ts（领域类型）+ global.d.ts（IPC 契约）
├── utils/index.ts          # 纯再导出 barrel（不得加实现）
└── styles/styles.css       # 主题令牌与基础样式（Tailwind v4 CSS-first）

tests/
├── unit/                   # Vitest 纯函数单测
├── main-process/           # 打桩 electron 的集成测试 + run.cjs + harness.cjs
└── smoke/                  # 真启动 Electron 的端到端冒烟

docs/                       # 架构 / 质量 / 决策 / 文档地图 / 历史存档
build/                      # electron-builder 资源与打包钩子
```

---

## 4. 关键运行链路

### 4.1 导入与扫描

```text
用户选择 / 拖放 / 恢复来源
  → 主进程授权入口登记路径（authorization.cjs）
  → media-pipeline.cjs 递归扫描（限深、跳过隐藏与符号链接、扩展名白名单）
  → 读文件头尺寸 + EXIF/GPS（只读前 512KB）
  → 计算内容指纹（fingerprint.cjs）→ Photo.fileId
  → 渲染层 useIngestPipeline 接收分批结果、显示进度、可取消
  → 扫描结果写入常驻来源（sources），重启时询问是否恢复
```

**边界**：扫描失败必须返回失败明细，不能吞成空结果；取消后不得回写半状态。

### 4.2 媒体访问（`pm://`）

```text
渲染层 <img src="pm://file/<base64url>" />
  → 主进程 protocol.handle('pm') 校验会话白名单
  → 未授权 403
  → 图片 / 视频以流返回；视频支持 HTTP Range（206）
  → 缩略图按需生成，落盘缓存 + LRU + 内存压力裁剪
```

**边界**：大图 / 视频不得以 base64 常驻渲染进程；`pm://` 每次请求都要校验。

### 4.3 持久化

```text
收藏 / 隐藏 / 标签 / 时间修正 / 智能相簿 / AI 结果
  → 键 = Photo.fileId（内容指纹），不是路径、不是会话 id
  → config.json（临时文件 + rename 原子替换）
  → 写前轮转 config.json.bak / .bak.1
  → 解析失败备份为 config.json.corrupt-<timestamp> 并 Toast 告知
```

**迁移**：`migrations.cjs` 把 v1 路径键换算成指纹；不可达记录进 `orphans`，供「路径重连」使用，不得静默丢弃。

### 4.4 IPC

```text
渲染层 window.electronAPI.xxx(args)
  → preload 转发 ipcRenderer.invoke('channel', args)
  → 主进程 handle('channel') 包装：异常兜底 + 重复注册检测
  → 文件类 handler 入口 isPathAuthorized()
  → 返回 IpcResult<T>
```

**约定**：用户取消是 `{ok:true, data:null}`；失败必须有 `error`，可选 `code`。

### 4.5 网络边界

| 能力 | 触发 | 限制 |
| --- | --- | --- |
| AI 分析 | 用户显式点击 / 配置 | 主进程代理；密钥只在主进程；读取只回掩码；20MB base64 闸门 |
| 更新检查 | 启动静默一次 + 手动 | 只请求 GitHub Releases；下载 host 白名单；不静默安装；可关闭 |

其余任何网络请求都不应存在。新增网络能力前先读 `ROADMAP.md` 的产品边界。

---

### 4.6 安全边界

Electron 默认配置偏松，下面九个面是逐项收紧后的现状。规则本体（不可破坏的约束）在 [`AGENTS.md`](../AGENTS.md) §4.1 / §4.2，本表只说明「收紧在哪一层」。

| 面 | 做法 | 落点 |
| --- | --- | --- |
| 沙箱 | 默认开启；仅未打包且显式 `PHOTOMINDER_DISABLE_SANDBOX=1` 时关闭；打包产物强制开启 | `electron/main.js` |
| 路径授权 | 会话级 `authorizedRoots` / `authorizedFiles`；只有 6 个入口能产生授权（列举见 [`AGENTS.md`](../AGENTS.md) §4.2） | `electron/main/authorization.cjs` |
| 协议 | `pm://file/<base64url>` 每次请求校验白名单，未授权 403 | `electron/main.js` |
| IPC | 文件类 handler 入口 `isPathAuthorized()`；统一返回 `IpcResult<T>` | `electron/main.js` + `main/*.cjs` |
| CSP | 唯一定义，响应头与构建期 `<meta>` 共用；生产 `script-src` 不含 `unsafe-inline` | `electron/lib/csp.cjs` |
| 体积闸门 | 读取前先 `stat`：`read-file` 64MB、`ai-analyze` 20MB base64 | `electron/main.js` |
| 写盘 | `reserveUniquePath()` 用 `open(path,'wx')` 原子占位，消除 TOCTOU | `electron/main/data-assets.cjs` |
| AI 密钥 | 主进程读取并代理；读取只回 `hasApiKey` + 尾号掩码 | `electron/main/ai.cjs` |
| 更新检查 | 只由主进程请求 GitHub；下载 host 白名单；不静默安装；更新类 IPC 不收渲染层路径 | `electron/main/updater.cjs` |

> 这层防的是**内容级攻击**（被当作图片加载的 SVG 等能构造 `pm://` 请求但无法调用 IPC）。渲染进程若被完全攻破，攻击者天然拥有全部 IPC 能力，需要靠 CSP 与沙箱收敛。

---

### 4.7 渲染层性能约定

长列表的性能不是「优化项」，是正确性的一部分：做不到就会在万级图库上卡死。

| 约定 | 做法 | 落点 |
| --- | --- | --- |
| 缩略图 | 按需生成（卡片进视口才请求），不在导入时批量预生成；并发上限 + 同 key 去重 + 先解码后替换避免闪烁 | `src/lib/cache/thumbCache.ts`、`src/components/grid/ThumbnailImage.tsx` |
| 虚拟化 | 网格与列表只渲染视口内元素（含 overscan），滚动事件 rAF 节流 | `src/components/grid/ImageGrid.tsx`、`src/hooks/useVirtualViewport.ts` |
| 内存治理 | 真 LRU（命中刷新 + 逐项淘汰）+ `volatile` / `sticky` 分级；主进程按 RSS 广播内存压力，渲染进程另有堆占用巡检 | `src/lib/cache/cacheManager.ts` |
| 行内材质 | 长列表行避免 `backdrop-filter`，惯性滚动会掉帧 | 各卡片 / 行组件 |

---

## 5. 唯一入口

| 事项 | 唯一入口 | 守卫 | 边界（为什么只留一份） |
| --- | --- | --- | --- |
| 文件名校验 / 规范化 | `src/lib/fs/pathUtils.ts` | `tests/unit/pathUtils.test.ts` | 校验（`validateFilename`）与落盘规范化（`sanitizeFilename`）成对；不变式「校验通过 ⟹ 规范化后原样不变」。组件内不另写非法字符正则 |
| 照片时间语义 | `src/lib/media/photoTime.ts` | `tests/unit/photoTime.test.ts` + 静态扫描 | `photoTakenTime`（2 级链，面向展示）与 `photoOriginalTime`（3 级链，面向原图判定）分开命名；`calendarDayKey` 用本地日历日，不用 UTC 日界 |
| 内容指纹 | `electron/lib/fingerprint.cjs` | 主进程测试 | 渲染层只持有 `fileId`，不重算 |
| 感知哈希 | `electron/lib/dhash.cjs` | `tests/unit/dhash.test.ts` | 主进程与渲染层共用唯一实现；渲染层只在主进程解不了时降级使用 |
| 搜索匹配 | `matchesSearch`（`src/lib/filter/filters.ts`） | `tests/unit/filters.test.ts` | 内部用 `WeakMap` 预小写索引；相机标识整体入索引，不拆成厂商 / 机型两段 |
| 进程内缓存 | `createLruCache`（`src/lib/cache/cacheManager.ts`） | 单测 | 不写「普通 Map + 满了 `clear()`」；跨天失效（`dateKeyCache`）与容量淘汰是两回事，前者该 clear |
| IPC 返回 | `IpcResult<T>`（`src/types/global.d.ts`） | `ipc-contract.test.cjs` | 注册走 `handle()`；「用户取消」是 `ok:true` + `data:null`，不是失败 |
| CSP | `electron/lib/csp.cjs` | Electron 冒烟 | 响应头与构建期 `<meta>` 共用同一份字符串 |
| 布局几何 | `src/lib/grid/justifiedLayout.ts` | `tests/unit/gridLayout.test.ts` + 静态断言 | 铺行宽度是滚动容器**扣除横向 padding 后**的内容区宽度，不是 `clientWidth`；`CARD_PADDING` 与 `ImageCard` 内边距必须成对修改 |
| 主题令牌 | `src/styles/styles.css` 的 `@theme` + `:root` / `.light-theme` | `tests/unit/designTokens.test.ts` | 两处声明必须同步；组件里不写十六进制色值 |
| 通用图标 | `src/components/icons/index.tsx` | 代码审查 | 只收「图形相同且被两处以上使用」的图标；尺寸 / 线宽由调用点传参，不在图标库里写死 |
| 日期胶囊文案 | `formatDayCapsule`（`src/components/grid/VirtualGrid.tsx`） | 代码审查 | 调用方与胶囊内部共用，避免「今天 / 昨天」出现两套判定 |
| `@/utils` | 纯再导出 barrel | `tests/unit/utilsBarrel.test.ts` | 不得加实现；新代码直接 import 具体模块 | 不得加实现；新代码直接 import 具体模块 |
| 日志器 | `src/lib/logger.ts`（渲染）/ `electron/lib/logger.cjs`（主进程） | 代码审查 | 两端**同构两份**实现，不是重复代码：进程隔离无法共享。接口固定 `debug` / `info` / `warn` / `error`，`debug` 与 `info` 仅开发构建输出。禁止出现第三份 |

---

## 6. 扩展手册

### 6.1 新增一个整页视图

1. 在 `src/components/<domain>/` 建视图组件，挂 `ErrorBoundary` + 共用 `ViewErrorFallback`。
2. 在 `src/App.tsx` 的 `MainView` 联合类型加值，并接路由 / Esc 返回。
3. 入口放 `Sidebar` 对应任务分组；按 `sidebarIA.test.ts` 的分组顺序。
4. 需要数据时写 `hooks/use<Domain>.ts`，纯逻辑放 `lib/<domain>/`。
5. 补空状态、加载态、失败态、窄窗口、深浅主题、键盘可达。
6. 更新 `README.md` 功能一览 + `CHANGELOG.md`。

### 6.2 新增一个 hook

1. 只做编排：状态、副作用、取消、进度；算法与规则放 `lib/`。
2. 不得 import `@/components`（守卫）。
3. 需要 IPC 时经 `window.electronAPI`（现有惯例）或 `services/`；文件路径参数必须来自授权入口。
4. 依赖数组写全，不关 `react-hooks/exhaustive-deps`。

### 6.3 新增一个 IPC 通道

完整步骤、文件类通道的授权与返回要求见 [`ipc.md`](./ipc.md) §5。不要在这里维护第二份步骤清单。

### 6.4 新增持久化字段

1. 先确认能否挂在现有结构下；能不加迁移就不加。
2. 需要结构变更时改 `electron/main/migrations.cjs`，并补 `migration-version-guard.test.cjs`。
3. 写入走 `store.cjs`（原子写 + 备份轮转），不要自己 `writeFile`。
4. 键用 `fileId`，不用路径。
5. 更新 `README.md` 数据存储表 + `CHANGELOG.md`。

### 6.5 新增纯逻辑与测试

1. 放 `src/lib/<domain>/`，函数优先纯函数、可注入依赖。
2. 单测放 `tests/unit/<name>.test.ts`，Vitest 自动发现。
3. 需要源码静态断言时，参考 `photoTime` / `dhash` / `designTokens` 的写法。
4. 不在 `src/utils/index.ts` 加实现。

### 6.6 新增主进程测试

1. 放 `tests/main-process/<name>.test.cjs`，**自动被发现**（`run.cjs` 扫描 `*.test.cjs`）。
2. 用 `harness.cjs` 的 `loadMainProcess()`，不要真启动 Electron。
3. 独立文件 / 独立进程：harness 在同一进程不能二次 `require(main.js)`。
4. 失败信息给出「文件:行号」或具体行为，不只写 `assert failed`。

### 6.7 改文件操作

1. 校验 / 规范化走 `pathUtils.ts`。
2. 占位走 `reserveUniquePath()`（`open(..., 'wx')`），不要先 `existsSync` 再写。
3. 绝不覆盖同名文件；最终文件名回传 UI。
4. 删除走 `shell.trashItem`；撤销按「文件名 + 体积 + mtime」三重校验。
5. 所有失败路径都要有用户可见反馈。

### 6.8 改主题 / 视觉

1. 令牌只在 `styles.css` 的 `@theme` + `:root` / `.light-theme` 两处声明，同步修改。
2. 组件里不写十六进制色值，优先用语义变量。
3. Tailwind v4 基础规则放 `@layer base`。
4. 不要把 `--blur-*` 命名成 `--blur-sm`（与 Tailwind 命名空间冲突）。
5. 跑 `designTokens.test.ts`。

---

## 7. 结构性债务与重构顺序

> 这些不是「坏味道清单」，而是**已知的、有边界的债务**。每项都给出目标与验收，避免 agent 自由发挥。

| 优先级 | 债务 | 现状 | 目标 | 风险 | 验收 |
| --- | --- | --- | --- | --- | --- |
| ~~P1~~ | ~~`electron/main.js` 组合根过大~~ | ✅ **已完成（2026-11-20）**：拆出 `window` / `menu` / `protocol` / `security` / `watch` / `fs-ops` / `memory-watchdog` 与 `ipc/`（registry / files / dialog）；`main.js` 只剩装配与生命周期 | — | 已用 `test:main` 与 `verify` 全绿验证；行为零变化 | `ipc-contract` 全绿；`main.js` 不含业务逻辑 |
| ~~P2~~ | ~~`ImageGrid.tsx` 同时含网格与列表两套虚拟化~~ | ✅ **已完成（2026-11-20）**：拆为 `VirtualGrid` / `VirtualList` / `ImageCard`，`ImageGrid` 只留工具栏与组合；滚动位置记忆随各自组件下沉，清空时由 `reset*ScrollMemory()` 统一丢弃 | — | 已用 `verify` + 构建 + 真实冒烟验证（`#root` 内容长度与拆分前一致） | 滚动 / 键盘 / 选择行为未改动；`gridLayout.test.ts` 的静态断言改为扫描整个 `grid/` 目录 |
| ~~P3~~ | ~~`App.tsx` 仍承担较多跨域连线~~ | ✅ **已完成（2026-11-20）**：抽出 `AppViews`（四个整页视图路由）、`AppOverlays`（右键菜单 / Toast / 业务弹窗 / 全屏预览）、`useAppMenuEvents`（四个菜单事件订阅） | — | 已用 `verify` + 构建 + 真实冒烟验证（`#root` 长度不变） | **图库视图刻意未抽**：它与 App 状态有六十余处直接耦合，抽出去只是一次同规模的 props 转发；真正减负要靠「状态下沉」，属结构性改动 |
| P4 | `services/` 只有 AI 一个用例 | 组件直接调 IPC 的额度见 `layering.test.cjs` 的 `BASELINE` | 按域补 service，逐步下调棘轮基线 | 低 | 每次只迁一个域；基线只降不升 |
| P5 | `strictNullChecks` 未开 | `noImplicitAny` 已 0 新增错误 | 分目录开启并修 | 中 | 每个 project 单独通过 |
| P6 | 无 CI | 本地手工跑 | 个人自用定位下暂不做；保持 `npm run verify` 一条命令 | 低 | 换机器一条命令可复现 |

**重构纪律**：

1. 一次只拆一个模块，行为零变化，单独提交。
2. 先补测试再搬代码；搬完跑 `npm run verify`。
3. 不顺手改命名 / 格式化 / 功能。
4. 拆完更新本文与 `AGENTS.md` 的代码地图。

---

## 8. 机器守卫清单

| 守卫 | 文件 | 锁住什么 |
| --- | --- | --- |
| 分层依赖 | `tests/main-process/layering.test.cjs` | hooks ↛ components、lib ↛ 上层、services ↛ UI、types 无运行时依赖、主进程 ↛ src |
| IPC 契约 | `tests/main-process/ipc-contract.test.cjs` | preload / d.ts / 调用点 / 注册通道四处一致 |
| IPC 安全 | `tests/main-process/ipc-security.test.cjs` | 未授权路径被拒、`pm://` 403、六条授权链路、体积闸门 |
| 唯一路径 | `tests/main-process/unique-path.test.cjs` | 并发占位不覆盖 |
| 存储恢复 | `tests/main-process/storage-recovery.test.cjs` | 损坏备份 + 不阻塞 + 告知用户 |
| 迁移版本 | `tests/main-process/migration-version-guard.test.cjs` | v2 不被重复迁移、不清空标注 |
| 重命名预演 | `tests/main-process/rename-probe.test.cjs` | 预览名 === 落盘名；只读 |
| AI 密钥边界 | `tests/main-process/ai-config-privacy.test.cjs` | 读取不回明文 |
| 更新检查 | `tests/main-process/updater.test.cjs` | 版本比较、资产白名单、下载校验、取消 |
| 数据资产 | `tests/main-process/data-assets.test.cjs` | 指纹与路径无关、导入导出、重连 |
| 崩溃 / 健康 | `crash-report.test.cjs` / `data-health.test.cjs` | 异常落盘、提示一次、健康汇总 |
| 品牌 | `tests/unit/branding.test.ts` | 显示名与 `productName` / `appId` / `payload.app` 边界 |
| 文档一致 | `tests/unit/docsConsistency.test.ts` | 版本号一致、文档链接存在、模块清单不遗漏 |
| 设计令牌 | `tests/unit/designTokens.test.ts` | 令牌单一来源、无硬编码色值 |
| 侧栏 IA | `tests/unit/sidebarIA.test.ts` | 分组名与顺序 |
| 关于页 | `tests/unit/aboutContent.test.ts` / `aboutUpdateFlow.test.ts` | 更新记录版本、交互决策 |

---

## 9. 技术变更同步矩阵

> 本表只管**代码侧必须一起改的位置**。文档之间的职责边界与冲突裁决见 [`docs/README.md`](./README.md) §2 / §3，不在这里重复。

| 你改了 | 必须同步（代码 / 守卫） |
| --- | --- |
| IPC 通道 | 见 [`ipc.md`](./ipc.md) §5 的五处清单 |
| 持久化结构 | `migrations.cjs` + 迁移守卫测试 |
| 主题令牌 | `styles.css` 两处 + `designTokens.test.ts` |
| 品牌口径 | `branding.test.ts` 守住的三处标识 |
| dev server 监听面 / 端口 | `vite.config.mts` + `electron:dev` + `devServerConfig.test.ts` |
