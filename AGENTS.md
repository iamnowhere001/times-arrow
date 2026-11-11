# AGENTS.md

> 在本仓库工作的 AI 编码代理（以及新加入的人类）的操作手册。
> **先读这份，再动代码。** 它与 `README.md`（功能事实）、`ROADMAP.md`（产品方向）、`TODO.md`（执行清单）、`CODE_REVIEW.md`（技术审查）分工不同，不要用其中一份替代另一份。

---

## 1. 项目速览

| 项 | 内容 |
| --- | --- |
| 产品 | 界面显示名「时光画框」（副标题「本地照片整理工作台」）；仓库 / 英文名 / `appId` / 数据目录保留 PhotoMinder：macOS 优先的**本地**照片整理工作台 |
| 定位 | **个人自用**，不对外分发；不做签名 / 公证 / 自动更新；不做云同步、账号、遥测 |
| 核心承诺 | 文件操作直接作用于磁盘；除可选的 DeepSeek AI 分析外，全程不联网 |
| 技术栈 | Electron 44 · React 19 · TypeScript 7 · Vite 8 · Tailwind CSS 4 |
| 主进程 | Node.js / CommonJS（`electron/**/*.cjs`、`electron/main.js`、`electron/preload.js`） |
| 渲染进程 | React + TypeScript ESM（`src/`） |
| 数据目录 | macOS：`~/Library/Application Support/PhotoMinder/` |
| 当前版本 | `0.6.2`（2026-11-11 发布，git tag `v0.6.2`） |
| 质量基线 | typecheck / lint / 单测 370 项 / 主进程 251 项 / Electron 冒烟 全绿 |

**产品判断与优先级以 `ROADMAP.md` 为准；任务级状态以 `TODO.md` 为准；行为描述以 `README.md` 为准；历史技术结论以 `CODE_REVIEW.md` 为准。**

---

## 2. 常用命令

```bash
# 环境：Node.js 20.19+ 或 22.12+
npm install

npm run dev                  # 仅 Web，http://127.0.0.1:3000
npm run electron:dev         # Electron 桌面应用

npm run typecheck            # tsc 三个 project（渲染 / node / tests）
npm run lint                 # ESLint(JS/CJS) + oxlint(TS/TSX, type-aware)
npm run format:check         # Prettier
npm run test                 # test:main + test:unit
npm run test:unit            # Vitest 纯函数
npm run test:main            # 打桩 electron 的主进程集成测试
npm run test:smoke           # 真实启动 Electron 的冒烟（受限环境改用下一行）
npm run test:smoke:no-sandbox

npm run build                # 前端产物到 dist/
npm run electron:build       # macOS arm64 DMG + 重压
```

### 环境注意事项

- **端口**：`electron:dev` 的 `ELECTRON_START_URL` 必须与 `vite.config.mts` 的 `server.port` 一致（当前 3000）。改端口要两处同步，否则 Electron 白屏。
- **沙箱**：本机可能无法初始化 Chromium 沙箱。开发时用 `PHOTOMINDER_DISABLE_SANDBOX=1` 或 `npm run test:smoke:no-sandbox`；**打包产物永远强制开启沙箱**，不要为了本地方便把默认值改松。
- **lint 分层**：ESLint 只检查 JS/CJS；TS/TSX 交给 oxlint（TypeScript 7 与 `typescript-eslint` 的 peer 范围不兼容）。不要在 ESLint 配置里重新纳入 TS。
- **测试口径**：`test:main` 用打桩的 electron，不是真启动应用；`test:smoke` 才是真启动，且在本机可能因沙箱失败。

---

## 3. 代码地图

```text
electron/
├── main.js                 # 入口：窗口、菜单、IPC 注册、pm:// 协议
├── preload.js              # contextBridge → window.electronAPI
├── main/                   # 领域模块（CommonJS）
│   ├── ai.cjs              #   DeepSeek 代理、AI 配置读写与密钥掩码
│   ├── authorization.cjs   #   会话级路径白名单
│   ├── media-pipeline.cjs  #   扫描 / EXIF / 缩略图 / HEIC / dHash
│   ├── store.cjs           #   JSON 存储、原子写、损坏备份
│   ├── data-assets.cjs     #   指纹 / 配置导入导出 / 重连 / 日志 / 备份
│   └── migrations.cjs      #   config / ai-cache 的 v1→v2 迁移
└── lib/
    ├── csp.cjs             # CSP 唯一定义
    ├── fingerprint.cjs     # 内容指纹
    ├── dhash.cjs           # dHash 唯一实现
    └── logger.cjs          # 主进程日志器

src/
├── App.tsx                 # 组合 hooks + 视图路由（不要再堆业务逻辑）
├── hooks/                  # 20 个功能域 hook：编排 / 数据 / 交互
├── components/             # 按域分组：layout / grid / timeline / map / detail / duplicate / filter / modal / common / icons
├── services/               # aiService（经 IPC 走主进程）
├── lib/                    # 领域与基础设施：cache / media / filter / persistence / geo / fs / duplicate / format
├── types/                  # 领域类型 + global.d.ts（IpcResult / electronAPI）
├── utils/index.ts          # 纯再导出 barrel（86 行，不得加实现）
└── styles/styles.css       # 主题令牌（@theme + :root + .light-theme）与基础样式

tests/
├── unit/                   # Vitest 纯函数
├── main-process/           # 打桩 electron 的集成测试 + harness
└── smoke/                  # 真启动 Electron

build/                      # electron-builder 资源 / afterPack / DMG 重压
```

---

## 4. 不可破坏的不变式

### 4.1 本地与隐私

- 除显式触发的 AI 分析外，**不引入任何网络请求**：不上报、不拉配置、不接第三方 SDK、不做遥测 / 崩溃收集 / 云同步。
- AI 密钥只允许主进程读取。`ai-config-get` 只返回 `hasApiKey` + 尾号掩码，**不得**把明文回传给渲染层；不得把密钥写进日志、错误信息或导出的配置。
- 导出的配置**不包含 AI 密钥**。

### 4.2 路径授权与 IPC

- 任何接收渲染层路径的 IPC handler，入口**必须**调用 `isPathAuthorized()` 并拒绝未授权路径。
- 只有 6 个入口能产生授权：导入对话框、选择目录、扫描目录、监听目录、路径探测、拖放授权。不要新增“隐式信任”的入口。
- `pm://file/...` 每次请求都要做白名单校验；未授权返回 403。
- IPC 注册必须走 `handle()`（统一异常兜底 + 重复注册检测），**不要**直接 `ipcMain.handle`。
- 返回统一为 `IpcResult<T>`：`{ ok: true, data }` / `{ ok: false, error, code? }`。“用户取消”是 `{ ok: true, data: null }`，不是失败。
- 改 IPC 时同步四处：`electron/preload.js`、`src/types/global.d.ts`、测试冻结清单（`tests/main-process/ipc-contract.test.cjs`）、调用点。

### 4.3 身份与持久化

- **品牌口径（2026-11-06 拍板）**：界面显示名「时光画框」、副标题「本地照片整理工作台」；`package.json` 的 `productName` / `appId` 与导出文件的 `payload.app` 一律保持 `PhotoMinder`。前者决定 `userData` 目录，后者是旧备份的格式标识，改动会丢数据或让备份无法导入。由 `tests/unit/branding.test.ts` 静态断言守住。
- `Photo.fileId` = **内容指纹**（`sha256(size + 头尾各 64KB)` 截 128 bit），是跨会话、跨重命名 / 移动的稳定身份。
- `Photo.id` 只是会话内唯一 id，**不要**拿它做持久化键。
- 收藏 / 隐藏 / 标签 / 时间修正 / 智能相簿 / AI 结果都按 `fileId` 记录。不要重新引入按路径记录、`rekeyPathData` / `dropPathData` 那条补丁链。
- 配置写盘：临时文件 + rename 原子替换；写前轮转 `config.json.bak` / `.bak.1`；解析失败备份为 `config.json.corrupt-<timestamp>` 并 Toast 告知。
- 迁移器产生的 `orphans` 是给“路径重连”用的，不要静默丢弃。

### 4.4 文件操作

- 文件名校验与规范化**唯一入口**：`src/lib/fs/pathUtils.ts`（`validateFilename` / `sanitizeFilename`）。不变式：校验通过 ⟹ 规范化后原样不变（有测试守）。
- 写入占位用 `reserveUniquePath()`（`open(path, 'wx')`），不要“先 exists 再写”。
- **绝不覆盖**同名文件：目标已存在且不是自身时追加 `-1`、`-2`…，并把最终文件名回传 UI。
- 删除走系统回收站（`shell.trashItem`）；撤销取回要按“文件名 + 体积 + mtime”三重校验，失败必须明确报错。
- 所有失败路径都要有用户可见的反馈（Toast / 行内错误 / 重试），**不得静默吞错**。

### 4.5 时间与哈希

- 照片时间语义唯一入口：`src/lib/media/photoTime.ts`。
  - `photoTakenTime`：2 级链，面向展示。
  - `photoOriginalTime`：3 级链，面向原图判定。
  - `calendarDayKey` 用本地日历日，不用 UTC 日界。
  - 不要在调用点内联回退链（有静态扫描断言）。
- dHash 唯一实现：`electron/lib/dhash.cjs`。渲染层只在主进程解不了时降级使用，不要复制算法。

### 4.6 缓存、媒体与性能

- 进程内缓存统一用 `createLruCache()`（命中刷新 + 逐项淘汰 + volatile/sticky）。不要写“Map 满了 clear()”。
- 大图 / 视频**不得**以 base64 常驻渲染进程。原图与缩略图走 `pm://` 流式协议；视频要实现 HTTP Range（206）。
- 缩略图按需生成，不导入时批量预生成；磁盘缓存 + LRU + 内存压力裁剪。
- 长列表必须虚拟化；滚动事件用 rAF 节流；行组件避免 `backdrop-filter`（惯性滚动会掉帧）。
- 主进程重活（扫描 / EXIF / HEIC / dHash / 缩略图）必须限流；不要把同步解码塞回渲染进程。

### 4.7 设计与文案

- 界面文案、注释、文档统一用**中文**；代码标识符用英文。
- 主题令牌有两处声明：`styles.css` 的 `@theme` 与 `:root` / `.light-theme`。改色必须同步，新增颜色优先复用语义变量（`--text-*` / `--bg-*` / `--accent-*` / `--border-*`），不要在组件里新写十六进制色值。
- Tailwind v4：基础规则必须放在 `@layer base`；未分层样式会压掉 utilities。
- **不要**把 `--blur-*` 主题令牌命名成 `--blur-sm`（与 Tailwind 命名空间冲突，会生成非法 `blur(blur(...))`）。
- 通用图标只收“图形相同且被两处以上使用”的；尺寸 / 线宽由调用点传参，不在图标库里写死。
- `EmptyStates.tsx`、`Stat.tsx`、`DotField.tsx`、`ImmersiveView.tsx` **不是死代码**：它们是 K27–K30 已实现但尚未完全接线的设计资产，不要删除；接线任务见 `ROADMAP.md`。

### 4.8 代码组织

- `src/utils/index.ts` 是纯再导出 barrel，**不得**加实现（`tests/unit/utilsBarrel.test.ts` 会失败）。新代码直接 import 具体模块。
- `App.tsx` 只做组合与路由；新功能逻辑放对应 `hooks/` 或 `lib/`。
- 复用既有唯一入口：文件名、时间语义、dHash、搜索匹配（`matchesSearch`）、LRU、IPC 返回类型。
- 不引入 `any`（oxlint 会报错）；不关闭 `react-hooks/exhaustive-deps` 来“消音”，要写清依赖或说明为什么稳定。
- 新增依赖前先问：能否用现有实现？是否破坏“纯本地”？是否会显著增大 DMG？

---

## 5. 改动流程

### 改动前

1. 读相关文档与代码，确认“唯一入口”在哪里。
2. 用 `grep` / `glob` 找现有测试与同类实现，不要另起一套。
3. 明确这次改动是否触及：路径授权、数据模型 / 迁移、文件写盘、IPC 契约、安全边界。触及任一项，先看 `CODE_REVIEW.md` 对应附录。

### 改动中

- 一次只做一件事；行为变更与全量格式化**不要**混在同一提交。
- 保留现有结构与命名；注释解释“为什么”，不是“是什么”。
- 破坏性操作默认加二次确认或可撤销；能撤销的优先做撤销，而不是只加确认。
- UI 变更要同时考虑：空状态、加载态、失败态、窄窗口、深浅主题、键盘可达性。

### 改动后（Definition of Done）

- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 0 problems
- [ ] `npm run test` 通过；改主进程必须跑 `test:main`
- [ ] `npm run format:check` 通过
- [ ] 改构建 / 打包 / 入口时 `npm run build` 通过
- [ ] 新增纯逻辑有单测；新增 IPC / 权限 / 迁移有主进程测试
- [ ] 手动验证相关路径：导入、选择、操作、失败、重启恢复
- [ ] 同步文档：行为变化 → `README.md`；任务状态 → `TODO.md`；用户可感知变化 → `CHANGELOG.md`；方向 / 优先级变化 → `ROADMAP.md`；技术结论 → `CODE_REVIEW.md`

---

## 6. 文档同步规则

| 文档 | 回答什么问题 | 什么时候改 |
| --- | --- | --- |
| `README.md` | 现在能做什么、怎么用、边界在哪 | 功能 / 快捷键 / 配置 / 已知限制变化 |
| `ROADMAP.md` | 为什么做、先做什么、做到什么算完成 | 定位、优先级、版本主题变化 |
| `TODO.md` | 具体任务、编号、状态、验收 | 任务开始 / 完成 / 拆分 / 延期 |
| `CHANGELOG.md` | 每个版本交付了什么 | 用户可感知的 Added / Changed / Fixed / Security |
| `CODE_REVIEW.md` | 技术审查结论与修复证据 | 架构 / 安全 / 重构批次 |
| `AGENTS.md` | 代理与新人怎么安全地改 | 命令、约束、入口变化 |

**冲突处理**：方向冲突以 `ROADMAP.md` 为准；任务状态冲突以 `TODO.md` 为准；行为描述冲突以代码 + `README.md` 为准，并立刻修正文档。不要靠“以后再同步”留下四份互相矛盾的文档。

---

## 7. 提交规范

- Conventional Commits：`feat` / `fix` / `refactor` / `docs` / `chore` / `style` / `test`，可带 scope（如 `feat(data):`）。
- 一次提交只做一件事；重构与行为变更分开；全量 Prettier 单独提交。
- 提交信息写“为什么”，不要只写“update”。
- 不提交 `dist/`、`release/`、`default.profraw`、密钥、`node_modules/`。

---

## 8. 常见陷阱

| 陷阱 | 正确做法 |
| --- | --- |
| 直接 `ipcMain.handle` | 用项目封装的 `handle()`，返回 `IpcResult<T>` |
| 新 IPC 忘了鉴权 | 入口调用 `isPathAuthorized()` |
| 用路径当持久化键 | 用 `Photo.fileId`（内容指纹） |
| 改名后标注丢失 | 不要重新引入按路径 rekey；测迁移 / 重连 |
| 写文件先 `existsSync` 再写 | 用 `reserveUniquePath()` 原子占位 |
| 用 `Map` 满了 `clear()` | 用 `createLruCache()` |
| 把大图转 base64 传渲染层 | 用 `pm://` 流式 + 缩略图 |
| 为了消 lint 加 `eslint-disable` | 先修根因；确需禁用要写明原因 |
| 在长列表行里用 `backdrop-filter` | 改用不透明实色 / 简化材质 |
| 在 `utils/index.ts` 加实现 | 放到 `src/lib/<domain>/`，barrel 只 re-export |
| 删除“没被引用”的设计组件 | 先查 `ROADMAP.md` K27–K30，它们是有意预留 |
| 改端口只改一处 | `vite.config.mts` 与 `electron:dev` 同步 |
| 关闭沙箱图省事 | 仅本地显式环境变量；打包产物强制开启 |
| 全量格式化混进功能提交 | 单独提交，避免数千行 diff 淹没 review |

---

## 9. 需要先问、不要擅自做的事

以下改动影响面大，动手前先向维护者确认：

- 修改数据模型、迁移策略、内容指纹算法。
- 放宽路径授权 / CSP / 沙箱 / 体积闸门。
- 批量删除、覆盖、移动的语义变化。
- 引入新依赖、网络能力、遥测、云服务。
- 提升 / 变更版本号、改产品名 / `appId` / 包名。
- 大规模重命名、全量格式化、删除文件或整个模块。
- 改变 `ROADMAP.md` 的版本主题与优先级。

---

## 10. 快速定位

| 我要改… | 先看 |
| --- | --- |
| 导入 / 扫描 / 缩略图 / EXIF | `electron/main/media-pipeline.cjs`、`src/hooks/useIngestPipeline.ts`、`useLibraryImport.ts` |
| 文件重命名 / 删除 / 导出 / 移动 | `src/hooks/useFileOperations.ts`、`src/lib/fs/fileOperations.ts`、`electron/main/data-assets.cjs` |
| 收藏 / 标签 / 相簿 / 时间修正 | `src/hooks/usePersistedLibraryData.ts`、`src/lib/persistence/persistence.ts`、`src/lib/media/photoIdentity.ts` |
| 搜索 / 筛选 | `src/lib/filter/filters.ts`、`src/components/filter/FilterPanel.tsx` |
| 虚拟网格 / 列表 | `src/components/grid/ImageGrid.tsx`、`src/lib/cache/` |
| QuickLook / 视频 | `src/components/detail/QuickLook.tsx`、`VideoPlayer.tsx`、`src/hooks/useQuickLook.ts` |
| 时光画廊 / 地图 | `src/components/timeline/TimelineGallery.tsx`、`src/components/map/LocationMap.tsx`、`src/lib/geo/` |
| 重复检测 | `src/components/duplicate/DuplicateDetector.tsx`、`src/lib/duplicate/duplicateDetection.ts`、`electron/lib/dhash.cjs` |
| AI | `electron/main/ai.cjs`、`src/services/aiService.ts`、`src/components/modal/AiSettingsModal.tsx` |
| 主题 / 视觉 | `src/styles/styles.css`、`src/components/common/`、`src/components/icons/` |
| 打包 / 体积 | `package.json` 的 `build` 字段、`build/afterPack.js`、`build/recompressDmg.js` |
| 安全边界 | `electron/main/authorization.cjs`、`electron/lib/csp.cjs`、`CODE_REVIEW.md` 附录 A / B |

---

**最后一条**：这个项目最值钱的不是功能数量，而是“不丢数据、可取消、可恢复、可解释”的工程习惯。任何改动如果让这四件事变差，就不算完成。
