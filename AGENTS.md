# AGENTS.md

> 在本仓库工作的 AI 编码代理（以及新加入的人类）的操作手册。
> **先读这份，再动代码。** 它与 `README.md`（功能事实）、`ROADMAP.md`（产品方向）、`TODO.md`（执行清单）、`CODE_REVIEW.md`（技术审查）分工不同，不要用其中一份替代另一份。
>
> 文档地图与单一事实源见 [`docs/README.md`](./docs/README.md)；分层 / 依赖方向 / 扩展手册见 [`docs/architecture.md`](./docs/architecture.md)；验证基线与 DoD 见 [`docs/quality.md`](./docs/quality.md)；关键取舍见 [`docs/decisions.md`](./docs/decisions.md)。

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
| 当前版本 | `0.6.5`（2026-11-20 开发完成，待发版：左栏「应用 → 关于与更新」整页视图） |
| 质量基线 | `npm run verify` 全绿（typecheck / lint / format / test）；测试数量以命令输出为准，不写死 |

**产品判断与优先级以 `ROADMAP.md` 为准；任务级状态以 `TODO.md` 为准；行为描述以 `README.md` 为准；历史技术结论以 `CODE_REVIEW.md` 为准。**

---

## 2. 常用命令

```bash
# 环境：Node.js 20.19+ 或 22.12+
npm install

npm run dev            # 仅 Web，http://127.0.0.1:3000
npm run electron:dev   # Electron 桌面应用
npm run verify         # 提交前唯一必跑：typecheck + lint + format:check + test
npm run verify:full    # 改构建 / 入口 / 打包时
npm run electron:build # macOS arm64 DMG
```

其余命令、测试分层、lint 为什么分两层、本机沙箱限制、棘轮规则，统一见 [`docs/quality.md`](./docs/quality.md)。不要在本文件维护第二份命令表。

---

## 3. 代码地图

```text
electron/   # 主进程：main.js 组合根 + main/ 领域模块 + main/ipc/ 通道注册 + lib/ 基础设施
src/        # 渲染进程：App.tsx 组合 + components / hooks / services / lib / types
tests/      # 三层验证：unit / main-process / smoke
docs/       # 分层文档：架构 / 数据模型 / IPC / 外部依赖 / 质量 / 决策
build/      # electron-builder 资源与打包钩子
```

逐文件职责、分层边界、允许的依赖方向见 [`docs/architecture.md`](./docs/architecture.md) §2 / §3。依赖方向违规由 `tests/main-process/layering.test.cjs` 拦，不要靠约定。

---

## 4. 不可破坏的不变式

### 4.1 本地与隐私

- 除显式触发的 AI 分析、可关闭的更新检查外，**不引入任何网络请求**：不上报、不拉配置、不接第三方 SDK、不做遥测 / 崩溃收集 / 云同步。
- 更新检查只由主进程请求 GitHub Releases（`electron/main/updater.cjs`）；下载地址必须来自 API 且 host 在 `github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com` 白名单内；只下载 DMG、由用户确认安装，不静默覆盖 `/Applications`；渲染层不得直连 GitHub。
- AI 密钥只允许主进程读取。`ai-config-get` 只返回 `hasApiKey` + 尾号掩码，**不得**把明文回传给渲染层；不得把密钥写进日志、错误信息或导出的配置。
- 导出的配置**不包含 AI 密钥**。

### 4.2 路径授权与 IPC

- 任何接收渲染层路径的 IPC handler，入口**必须**调用 `isPathAuthorized()` 并拒绝未授权路径。
- 只有 6 个入口能产生授权：导入对话框、选择目录、扫描目录、监听目录、路径探测、拖放授权。不要新增“隐式信任”的入口。
- `pm://file/...` 每次请求都要做白名单校验；未授权返回 403。
- IPC 注册必须走 `handle()`（统一异常兜底 + 重复注册检测），**不要**直接 `ipcMain.handle`。
- 返回统一为 `IpcResult<T>`：`{ ok: true, data }` / `{ ok: false, error, code? }`。“用户取消”是 `{ ok: true, data: null }`，不是失败。
- 改 IPC 时五处必须同步（preload / `global.d.ts` / 注册 / 冻结清单 / 调用点），完整步骤与历史教训见 [`docs/ipc.md`](./docs/ipc.md) §1。
- 更新类 IPC（`update-*`）**不接收渲染层路径**：下载目录与文件名由主进程决定，打开 / 显示也只使用主进程内部记录的路径。不要为了“方便”新增 path 参数。

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

完整清单见 [`docs/quality.md`](./docs/quality.md) §4；该改哪份文档见 [`docs/README.md`](./docs/README.md) §5。这里只留三条底线：

- [ ] `npm run verify` 通过（改主进程额外跑 `test:main`；改构建 / 入口跑 `npm run build`）
- [ ] 新增纯逻辑有单测；新增 IPC / 权限 / 迁移有主进程测试
- [ ] 手动走一遍：导入 → 选择 → 操作 → 制造一次失败 → 重启恢复

---

## 6. 文档怎么改

**唯一源：[`docs/README.md`](./docs/README.md)** —— 文档地图、单一事实源登记、每份文档回答什么问题、冲突裁决顺序都在那里，本文件不重复。

改完代码按两句话判断该动哪里：

- 这份文档**该由谁回答**变了 → 改 `docs/README.md`。
- 需要**一起改的代码位置**（IPC 五处、持久化、主题令牌、品牌口径）→ [`docs/architecture.md`](./docs/architecture.md) §9。

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
| 在文档里复制字段名 / 通道清单 / 测试数量 | 只写「为什么 + 去哪看」，清单归代码与守卫；复制即漂移 |

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
| 虚拟网格 / 列表 | `src/components/grid/ImageGrid.tsx`、`src/hooks/useVirtualViewport.ts`、`src/lib/cache/` |
| QuickLook / 视频 | `src/components/detail/QuickLook.tsx`、`VideoPlayer.tsx`、`src/hooks/useQuickLook.ts` |
| 时光画廊 / 地图 | `src/components/timeline/TimelineGallery.tsx`、`src/components/map/LocationMap.tsx`、`src/lib/geo/` |
| 重复检测 | `src/components/duplicate/DuplicateDetector.tsx`、`src/lib/duplicate/duplicateDetection.ts`、`electron/lib/dhash.cjs` |
| AI | `electron/main/ai.cjs`、`src/services/aiService.ts`、`src/components/modal/AiSettingsModal.tsx` |
| 检查更新 / 下载 DMG | `electron/main/updater.cjs`、`src/hooks/useUpdateChecker.ts`、`src/components/modal/UpdateModal.tsx` |
| 主题 / 视觉 | `src/styles/styles.css`、`src/components/common/`、`src/components/icons/` |
| 打包 / 体积 | `package.json` 的 `build` 字段、`build/afterPack.js`、`build/recompressDmg.js` |
| 安全边界 | `electron/main/authorization.cjs`、`electron/lib/csp.cjs`、`CODE_REVIEW.md` 附录 A / B |

**新增一类东西**（整页视图 / hook / IPC 通道 / 持久化字段 / 纯逻辑与测试 / 主进程测试 / 文件操作 / 主题）的分步清单，见 [`docs/architecture.md`](./docs/architecture.md) §6。

---

**最后一条**：这个项目最值钱的不是功能数量，而是“不丢数据、可取消、可恢复、可解释”的工程习惯。任何改动如果让这四件事变差，就不算完成。
