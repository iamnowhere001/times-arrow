---
name: PhotoMinder 全量代码审查
overview: 对 PhotoMinder 做一次全量代码审查（渲染进程 + 主进程 + preload + lib 层），系统性排查各功能的逻辑漏洞，输出分级问题清单并回填 TODO.md，随后修复已确认的高危项。
todos:
  - id: baseline
    content: 确认未提交改动与基线：读 App.tsx/DetailsPane/ImageGrid 的 diff，跑 typecheck 与 build 记录初始状态
    status: completed
  - id: review-ipc-persist
    content: 用 [subagent:code-explorer] 审查 IPC 契约与持久化：main.js、preload.js、global.d.ts、lib/persistence、aiCache
    status: completed
    dependencies:
      - baseline
  - id: review-browse
    content: 用 [skill:lsp-code-analysis] 审查导入与浏览链路：App.tsx、ImageGrid、ThumbnailImage、TimelineGallery、lib/cache、utils
    status: completed
    dependencies:
      - baseline
  - id: review-filter
    content: 审查筛选搜索与整理功能：lib/filter、Sidebar、FilterPanel、ActiveFiltersBar、SaveAlbumModal、AdjustDateModal、DetailsPane 标签与日期
    status: completed
    dependencies:
      - baseline
  - id: review-fileops
    content: 审查文件操作与交互：RenameModal、ExportModal、DeleteConfirmModal、fileOperations、contextMenuActions、QuickLook、快捷键与焦点
    status: completed
    dependencies:
      - review-ipc-persist
  - id: review-dupe-ai
    content: 审查重复检测与 AI 链路：useDuplicateDetection、DuplicateDetector、aiService、AiSettingsModal、内存与缓存治理
    status: completed
    dependencies:
      - baseline
  - id: fix-and-backfill
    content: 修复已确认的 P0/P1 问题，并将全部问题按级别回填 TODO.md，最后跑 typecheck 与 build 验证
    status: completed
    dependencies:
      - review-ipc-persist
      - review-browse
      - review-filter
      - review-fileops
      - review-dupe-ai
---

## 用户诉求

对 PhotoMinder 全部功能做一次系统性代码审查，逐项检测是否存在逻辑漏洞（状态错乱、竞态、边界遗漏、异常未兜底等），输出问题清单，并直接修复已确认的高危问题，其余问题回填 TODO.md 作为待办。

## 审查范围（用户已确认）

- 全量：渲染进程全部功能 + `electron/main.js` 主进程（IPC、文件扫描、读写、重命名、删除、导出、持久化、AI 代理）+ `electron/preload.js` 桥接 + `src/lib/**` 各模块，约 15k 行。

## 核心审查内容（以 TODO.md 功能基线为用例）

1. 导入与浏览：文件夹/多选/拖放导入、扩展名白名单、递归扫描与取消、按路径去重、虚拟滚动网格/列表、排序与日期分组、QuickLook、按需缩略图与缓存。
2. 选择、搜索与筛选：⌘/Shift/方向键多选、关键词搜索、可组合筛选、已启用条件条、筛选变化后的选择收敛。
3. 文件操作：单张/批量重命名（不覆盖）、删除入回收站、批量导出、复制/在访达显示/外部打开/设为封面。
4. 状态持久化：config.json 原子写、ai-cache 淘汰、视图偏好、窗口状态。
5. 整理功能：隐藏、智能（条件）相簿、用户标签、调整日期与时间、收藏/封面。
6. 重复检测：dHash + 体积预筛 + 并查集聚类、阈值/范围、进度与取消、批量标记。
7. 支撑能力：EXIF 解析、AI 描述与标签代理、主题、右键菜单、错误边界、Toast 与失败重试、缓存治理与内存看门狗、快捷键与焦点。

## 产出与验收

- 每条问题包含：模块、文件与行号、触发路径（正常/边界/失败）、现象、级别（P0 数据丢失或崩溃或状态错乱 / P1 功能失效 / P2 体验或边界）、修复方案。
- P0/P1 且改动面可控者直接修复；其余作为待办追加到 `TODO.md`（不新建独立报告文件）。
- 每个修复后 `npm run typecheck` 与 `npm run build` 必须通过，不引入新依赖与新架构。

## 技术栈与基线（沿用现有，不引入新依赖/新工具链）

- Electron 44 主进程（`electron/main.js` 2074 行 + `electron/preload.js`）+ React 19 + TypeScript 7 + Vite 8 + Tailwind 4。
- 质量闸门仅 `npm run typecheck`（tsc --noEmit）与 `npm run build`；仓库无测试、无 ESLint，靠手动验证（TODO.md X8），因此审查以静态走查 + 契约交叉核对为主。
- 日志统一走 `src/lib/logger.ts` / `electron/lib/logger.cjs`；用户提示统一走 Toast（`src/hooks/useToasts.ts` + `src/components/common/Toast.tsx`）；异常兜底走 `ErrorBoundary`。

## 审查方法

1. **契约先行**：先对齐 `electron/preload.js` 暴露的 API → `src/types/global.d.ts` 声明 → `electron/main.js` 的 `ipcMain.handle` 实现 → 渲染进程调用点，核对 channel 名、参数顺序、返回结构、错误返回形态（throw vs `{ok:false}`）是否一致。契约不一致是本项目最易藏漏洞的位置。
2. **用例驱动**：以 TODO.md「现状基线」的功能条目为用例清单，每条走「正常路径 → 边界路径 → 失败路径」三遍，重点看失败路径是否有兜底与状态回滚。
3. **模式清单（bug pattern checklist）**，逐文件过筛：

- 异步竞态：IPC 返回后组件已卸载仍 setState；取消/翻页后旧请求回写；闭包捕获过期 state（`App.tsx` / `ImageGrid.tsx` / `ThumbnailImage.tsx` 高危）。
- 状态一致性：筛选/隐藏/删除/导入后 选中集合、锚点索引、当前项、`filteredItems` 是否收敛；是否残留已不存在路径。
- 索引错位：虚拟滚动与日期分组头（`photoGrouping.ts`）混入列表后，index ↔ item 映射是否仍成立；排序不稳定、zoom 变化后测量未失效。
- 文件操作：重命名并发与同名回退（`RenameModal` ↔ main.js 追加序号）、批量操作部分失败后的列表与持久化状态、导出中断残留、路径失效降级（属已知 N5，审查时细化成子项而非重复立项）。
- 持久化：config.json 读-改-写是否串行化（并发写覆盖）、ai-cache 淘汰是否按插入序而非 LRU、脏数据/字段缺失/版本缺失的容错、JSON 解析失败兜底。
- 时间与时区：拍摄时间修正（`AdjustDateModal`）、日期范围筛选边界（开闭区间、跨时区、无 EXIF 回退到文件时间的取值）、EXIF 时区解析。
- 缓存与内存：LRU 分级与释放、缩略图请求去重与并发闸门、大图/HEIC 解码 OOM 兜底。
- 交互：输入框聚焦时快捷键误触发、模态打开时全局快捷键未屏蔽、右键菜单项按媒体类型裁剪是否覆盖全部分支。
- 重复检测：阈值语义（汉明距离 vs 相似度）与并查集聚类正确性、取消后状态清理、跨目录范围是否真正生效、批量标记是否影响被隐藏项。

4. **分级与修复边界**：

- P0（丢数据、崩溃、状态不可自洽）/ P1（功能失效或结果错误）：确认且修复方案明确、改动面可控者**直接修复**。
- P2（体验/边界/理论风险）与需大改的问题：**只记录**并回填 TODO.md，不在本轮改动。
- 属于 TODO.md X 类（安全加固、拆分 App.tsx、引入测试/ESLint）与 F 类（新功能）的一律不修，仅记录。

5. **修复原则（最小爆炸半径）**：优先复用现有工具函数与模式（`src/utils/index.ts`、`lib/fs/*`、logger、Toast 重试）；不改公共签名与 IPC 契约；一次只改一处并在改动点就近注释原因；修复后跑 typecheck + build。

## 执行注意事项

- **先看清未提交改动**：工作区 `src/App.tsx`、`src/components/detail/DetailsPane.tsx`、`src/components/grid/ImageGrid.tsx` 有未提交修改，审查前先读 diff 明确意图，避免把进行中的改动误判为漏洞；修复时避免与之冲突。
- **不误报**：每条问题必须给出可复现的触发路径与代码位置，禁止「可能/应该」类结论；同因多果的问题合并为一条。
- **避免与已知待办重复**：N5（稳定性加固）、N7（封面落地）已有立项，相关发现归入其下作子项，并标注「细化 / 重复」。
- **不改行为默认值**：不调整阈值默认值、不改动持久化文件字段名与路径，避免用户现有 config.json / ai-cache.json 失效。
- **巨型文件阅读策略**：`App.tsx`（约 2k 行）、`ImageGrid.tsx`（1527）、`electron/main.js`（2074）、`TimelineGallery.tsx`（1292）、`DuplicateDetector.tsx`（1024）采用「先符号/接口扫描再定点精读」，避免全量通读拖慢与失真。

## 架构与影响面

审查不改变现有架构（渲染进程 UI → lib 工具层 → preload 桥 → main.js IPC → 文件系统/持久化）。变更集中在：

- 渲染进程：状态收敛、异步守卫、边界判定。
- 主进程：IPC 入参校验、失败返回结构统一、持久化写串行化。
- 文档：`TODO.md` 追加问题清单章节。

## 目录结构（审查对象与可能修改点）

```
photominder/
├── TODO.md                              # [MODIFY] 追加「代码审查问题清单」章节，按 P0/P1/P2 分组，含文件:行号、触发路径、修复方案
├── electron/
│   ├── main.js                          # [REVIEW/可能 MODIFY] IPC 契约与入参校验、扫描/取消、重命名同名回退、删除/导出失败返回、EXIF、视频抓帧、AI 代理、config/ai-cache 原子写与串行化、内存看门狗
│   ├── preload.js                       # [REVIEW] 暴露 API 与类型声明一致性
│   └── lib/logger.cjs                   # [REVIEW] 日志级别与静默策略
├── src/
│   ├── App.tsx                          # [REVIEW/可能 MODIFY] 全局状态机、导入编排、选择收敛、快捷键、异步竞态
│   ├── types/{index.ts,global.d.ts}     # [REVIEW] 类型与 IPC 返回结构是否与实际一致
│   ├── utils/index.ts                   # [REVIEW] 格式化/时间/dHash 等纯函数边界
│   ├── hooks/
│   │   ├── useDuplicateDetection.ts     # [REVIEW] 并查集聚类、阈值、取消清理
│   │   ├── useToasts.ts                 # [REVIEW] 重试回调与生命周期
│   │   └── useThemeMode.ts              # [REVIEW] 主题持久化竞态
│   ├── services/aiService.ts            # [REVIEW] 代理异常、超时、缓存 key
│   ├── lib/
│   │   ├── filter/{filters.ts,libraryViewState.ts}   # [REVIEW] 筛选/搜索求值、日期边界、状态共享
│   │   ├── media/{mediaTypes.ts,photoGrouping.ts,videoMeta.ts}  # [REVIEW] 分组索引、媒体类型判定、视频元数据
│   │   ├── cache/{cacheManager.ts,thumbCache.ts,dragThumbnail.ts} # [REVIEW] LRU 分级、请求去重、释放
│   │   ├── persistence/{persistence.ts,aiCache.ts}   # [REVIEW] 原子写、淘汰策略、脏数据容错
│   │   ├── fs/{fileOperations.ts,pathUtils.ts}       # [REVIEW] 路径规范化与非法字符
│   │   └── contextMenuActions.ts, logger.ts          # [REVIEW] 动作裁剪分支、日志脱敏
│   └── components/
│       ├── grid/{ImageGrid.tsx,ThumbnailImage.tsx}   # [REVIEW/可能 MODIFY] 虚拟滚动、多选、分组索引、缩略图闸门
│       ├── timeline/TimelineGallery.tsx              # [REVIEW] 时间线分组与滚动定位
│       ├── detail/{DetailsPane.tsx,QuickLook.tsx}    # [REVIEW] EXIF/AI/标签/日期修正、缩放旋转幻灯片、卸载清理
│       ├── duplicate/DuplicateDetector.tsx           # [REVIEW] 取消、进度、批量标记
│       ├── modal/{RenameModal,ExportModal,AdjustDateModal,DeleteConfirmModal,SaveAlbumModal,AiSettingsModal}.tsx  # [REVIEW] 预览与实际执行一致性、并发、边界
│       ├── layout/{Sidebar.tsx,Toolbar.tsx,ActiveFiltersBar.tsx}  # [REVIEW] 分类计数、条件条、快捷键
│       ├── filter/FilterPanel.tsx                    # [REVIEW] 条件组合与重置
│       └── common/{ContextMenu,Toast,ErrorBoundary,ShortcutsOverlay,LoadingOverlay,DragOverlay}.tsx  # [REVIEW] 焦点、重试、覆盖层
```

## 关键结构（TODO.md 条目模板，多条待办共用）

```markdown
- [ ] **[P0] 问题标题**（`文件:行号`）
  - 现象：一句话描述错误结果
  - 触发：操作路径（含前置条件）
  - 原因：根因定位
  - 修复：已修（简述改法）/ 待修（方案与影响面）
```

## Agent Extensions

### SubAgent

- **code-explorer**
- 用途：跨文件批量定位审查目标——IPC channel 的定义与全部调用点、异步回调与 setState 点、路径/索引计算点，避免在 15k 行里盲读。
- 预期产出：按模块给出「符号 → 文件:行号 → 调用点」清单，作为定点精读的输入。

### Skill

- **lsp-code-analysis**
- 用途：对 `App.tsx`、`ImageGrid.tsx`、`electron/main.js` 等巨型文件做符号跳转、引用查找与结构大纲提取，核对跨文件契约（preload 暴露 API ↔ global.d.ts ↔ main.js 实现 ↔ 调用点）是否一致。
- 预期产出：函数级调用链与契约差异清单，用于定位竞态与参数错配。