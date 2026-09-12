# N5 · 稳定性加固（本地场景）实现计划

## Context

TODO.md 中 N5（v0.5.1，优先级高）要求补齐本地场景的文件操作异常兜底：外部删/移文件时明确提示并自动剔除、目录监听感知外部增删、IPC 失败统一 Toast、导入失败可重试不留半状态、并发保护补齐目录场景。经用户确认：

- 目录监听行为：**自动同步 + Toast 汇总**（新增自动入列、删除自动移除，一条 Toast 汇总）
- 范围：**顺带修复同源的 K1**（scan/stat 失败被吞成空结果）**与 K2**（跨卷移动删源失败无中间态）

验收标准：模拟文件被外部删除 / 移动 / 权限变化，应用不崩、状态自洽、提示清晰。

## 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `electron/main.js` | 新增目录 watcher + 2 个 IPC；改 `scan-directory` / `stat-files` / `moveAcrossDevices` / `move-files` |
| `electron/preload.js` | 新增 4 个映射（2 invoke + 2 事件，仿 `onImportPaths` L75-79 模式） |
| `src/types/global.d.ts` | 新增 watcher 类型契约；改 `scanDirectory` / `statFiles` / `MoveFileResult` 签名 |
| `src/lib/fs/fileOperations.ts` | 新增 `isFileGoneError` |
| `src/lib/fs/ipcGuard.ts`（新建） | 统一 IPC 错误上报 + 「文件已消失」自动剔除（参照 `persistence.ts` L14-33 的 handler 注册模式） |
| `src/App.tsx` | watcher 生命周期与事件应用、失败自动剔除接线、导入失败重试、扫描结果适配 |
| `TODO.md` | 完成后回填 N5 / K1 / K2 状态 |

## 一、主进程（electron/main.js）

### 1. 目录监听（新段落，置于 scanDirectory L554 附近）

模块级状态：`dirWatcher`、`watchedDir`、`pendingWatchEvents: Map<path, type>`、`flushTimer`。

- **`watch-directory` handler**：先 `stat` 校验是目录（失败返回 `{success:false, error}`）；与 `watchedDir` 相同则 `{success:true, already:true}`；否则关旧 watcher → `fs.watch(dirPath, { recursive: true })`（macOS FSEvents 支持递归）。
- **事件聚合**：`event` 回调过滤——`relPath` 为空跳过；`basename` 以 `.` 开头跳过（`.DS_Store` / `._*`）；扩展名不在 `isMediaFile` 白名单（main.js L166，复用）跳过。路径存入 Map 去重（同路径覆盖 type）。**尾沿 500ms 防抖 + 3s maxWait 强制 flush**（防整目录拷入时永不 flush）。
- **flush 分类**：逐路径 `stat`——成功且 isFile → `added`；ENOENT → `removed`；removed 路径 stat 出来是目录 → 归入 `removedDirs`。完成后 `webContents.send('directory-changed', { dir: watchedDir, added, removed, removedDirs })`（均为绝对路径数组，空数组不发）。
- **`watcher.on('error')`**（目录被外部删除/卸载）：log + `send('directory-watch-error', { dir, code })` + 清理全部 watcher 状态。
- **`unwatch-directory` handler**：关 watcher、清 timer、清 Map。
- 主进程**不做自我回环过滤**（无法区分应用内删除与 Finder 删除），由渲染层过滤（见下）。

### 2. K1 — `scanDirectory`（L554-625）与 `scan-directory`（L1528-1535）

- `readdir` 失败分支（L580 `continue`）→ 计数 `failedDirs++`；单项 `stat` 失败（L610 `return null`）→ 计数 `failedFiles++`；取消分支（L618）返回 `{ files: [], cancelled: true }`。
- 新返回：`{ files: FileInfo[], failedDirs?, failedFiles?, cancelled?, error?, errorCode? }`；handler catch 改为返回 `{ files: [], error: message, errorCode: code }`，**不再 `return []` 冒充空目录**。
- 渲染层调用点共 2 处（已核实）：[App.tsx L1013](file:///Users/yongxu/Documents/code/photominder/src/App.tsx#L1013)（loadDirectory）、[App.tsx L2365](file:///Users/yongxu/Documents/code/photominder/src/App.tsx#L2365)（拖放文件夹分支）——直接改形状，不做兼容垫片。

### 3. K1 — `stat-files`（L1590-1613）

- 新返回 `{ infos: FileInfo[], failedPaths: string[], error?: string }`：单项失败不再过滤丢弃，路径进 `failedPaths`；整体 catch 返回 `{ infos: [], failedPaths: 入参, error }`。
- 渲染层调用点共 2 处（已核实）：App.tsx L1073（文件选择导入）、L2317（拖放补 stat）。

### 4. K2 — `moveAcrossDevices`（L1025-1028）与 `move-files`（L1076-1129）

- `moveAcrossDevices`：`copyFile(COPYFILE_EXCL)` 成功后 `unlink` 源失败时**不 throw**，返回 `{ copied: true, sourceRetained: true, error }`。
- `move-files` EXDEV 分支（L1109）幂等重试：`copyFile` 抛 EEXIST（重试场景目标已存在）时，`stat` 两侧 size 相等 → 直接重试 unlink 源，成功记 success；size 不等 → `buildUniquePath` 重新复制。
- results 单项新增 `partial: true`（复制成功但源未删）；渲染层对 partial 项**不更新列表**（源仍在），单独 Toast 说明并可重试删源。

## 二、preload.js 与类型契约

- preload 新增：`watchDirectory(dirPath)`、`unwatchDirectory()`、`onDirectoryChanged(cb)`、`onDirectoryWatchError(cb)`（事件返回取消订阅函数，仿 L75-85）。
- global.d.ts：
  - `scanDirectory` 返回改为 `ScanDirectoryResult`（含 `files/failedDirs/failedFiles/cancelled/error/errorCode`）
  - `statFiles` 返回改为 `{ infos, failedPaths, error? }`
  - `MoveFileResult` 增 `partial?: boolean`
  - 新增 `DirectoryChangeEvent { dir; added: string[]; removed: string[]; removedDirs: string[] }` 与 4 个新 API 签名

## 三、渲染进程 lib 层

### `src/lib/fs/fileOperations.ts`

- 新增 `export const isFileGoneError = (msg?: string) => /\bENOENT\b/.test(msg ?? '')`（与 `humanizeFsError` L17-48 相邻；主进程错误统一走 `error.message` 字符串，正则判定即可）。

### `src/lib/fs/ipcGuard.ts`（新建）

参照 `persistence.ts` 的统一上报模式，提供：

- `createFsErrorReporter(showToast)` → `{ reportFailure(scope, err), reportGone(photos) }`
- `reportFailure`：logger.error + `humanizeFsError` 转译 + error 级 Toast（统一「IPC 失败走 Toast」）。
- `reportGone(photos: Photo[])`：`removeWithCollapse(ids)` + **`importedPathsRef` 删除对应路径**（否则同路径文件重建后 `ingestFiles` L922 去重会拒绝重新入库——已核实 `dropPathData` L644 有同款清理）+ `pruneDuplicateGroups(ids)` + 收敛 selection + Toast「N 个文件已不在原位置，已从列表移除（收藏与标签保留）」。**不调用 `dropPathData`**——按路径的收藏/标签记录有意保留（README 已知限制声明：文件可能从其它目录重新导入）。

## 四、App.tsx

### 1. 失败自动剔除（接线点，均已核实）

- 单张重命名（L1360-1456）失败分支：`isFileGoneError(result.error)` → `reportGone([photo])`，否则维持原 Toast。
- 批量重命名（L1461-1678）逐项失败收集处：失败项按 ENOENT 拆两组，gone 组剔除、其余进现有重试集合。
- `runDelete`（L1681-1730）：`movePhotosToTrash` 返回的 `errors[i]` 与 `failedPhotos[i]` 对位（fileOperations.ts L50-99 已保证），ENOENT 项剔除且**不进 retryPhotos**。
- `runMove`（L1765-）`failedResults`：`r.error` 为 ENOENT → 剔除对应条目，不进重试；`r.partial` → 不更新该条目、Toast「已复制到目标位置，但原文件删除失败」并支持重试。
- 导出 `readFile` / `writeFileUnique` 失败同样判定剔除。

### 2. watcher 生命周期与事件应用

- 新 refs：`watchedDirRef`、`pendingWatcherEventsRef`、`touchedPathsRef: Map<path, expiryTs>`（TTL 8s）。
- **watch**：`loadDirectory` 成功末尾（`pushRecentDirectory` L1037 之后）`watchDirectory(dirPath)`；**unwatch**：`handleClearList`（L814）与 App 卸载 effect。
- 挂载 effect 订阅 `onDirectoryChanged` / `onDirectoryWatchError`（卸载时调用取消订阅）。Handler：
  1. `e.dir !== watchedDirRef.current` → 丢弃（旧目录残响）；
  2. 过滤 `touchedPathsRef` 未过期路径（应用自身操作回环防护）；
  3. `fileOpLockRef.current === true`（L271）→ 事件并入 `pendingWatcherEventsRef` 暂存；
  4. 否则立即 `applyWatcherEvent(e)`。
- `applyWatcherEvent(e)`：removed ∪ removedDirs 前缀命中 → `reportGone`（走统一剔除管线）；added → 过滤 `importedPathsRef` 已有路径 → `statFiles` → `ingestFiles`（天然去重、分批，不弹 loading 遮罩）；有实际变动时一条 info Toast「外部变动：新增 X 项 / 移除 Y 项」（均 0 不弹）。
- **flush 时机**：所有持 `fileOpLockRef` 的操作（单张/批量重命名、删除、移动）`finally` 释放锁后调 `flushPendingWatcherEvents()`（合并暂存事件走 applyWatcherEvent；重命名/移动的新路径被 importedPathsRef 去重、旧路径在列表已更新后为空操作，天然幂等）。
- **回环防护写入**：单张/批量重命名、删除、移动发起前，把涉及的新旧路径写入 `touchedPathsRef`（双保险：锁内暂存 + TTL 过滤，覆盖事件在锁释放后才抵达的窗口）。
- **watch error**：error Toast「目录已不可访问，已停止监听」+ 清 `watchedDirRef`，列表不动。

### 3. 导入失败可重试（K1 接入）

- `loadDirectory`（L1001-1052）：结果 `error` → 现有错误 Toast + 重试（已有）；`failedDirs/failedFiles > 0` → warning Toast「N 个子目录 / M 个文件无法读取，已跳过」+「重试」重跑 `loadDirectory(dirPath)`（importedPathsRef 去重，只补漏）。
- 文件选择导入（L1073）：`failedPaths.length > 0` → Toast +「重试」仅对 failedPaths 再 stat + ingest。
- 拖放分支（L2317 / L2365）：适配新返回形状，failedPaths / failedFiles 计入提示。

## 五、风险与边界

1. **FSEvents rename 对**：Finder 改名 = 旧路径 removed + 新路径 added → 表现为条目重建；收藏/标签留旧路径不迁移（符合保留策略）。
2. **事件风暴**：单 flush added 数千时 `ingestFiles` 分批 2000 可承受；Toast 文案「新增 X 项」即可。
3. **TOCTOU**：flush 分类与实际入库有时间差，极端情况 add 到已消失文件 → 卡片加载失败由 N5 剔除逻辑兜底。
4. **目录被外部删除**：watcher error → 停止监听 + 提示，不崩溃；列表条目仍可被操作失败剔除逻辑逐个处理。
5. **partial 移动**：不更新列表、不迁移路径数据，Toast 提供重试（重试走幂等 unlink 分支，不重复复制）。

## 六、验证

1. `npm run typecheck`（global.d.ts 改形状后必须零错误）+ `npm run build`。
2. `npm run electron:dev` 手动场景：
   - Finder 删除 1 个文件 → Toast「移除 1 项」，卡片塌陷；拷入 3 张 → 「新增 3 项」自动入列；
   - Finder 重命名 → 旧条目移除、新条目加入，收藏/标签不迁移且不报错；
   - 应用内删除/重命名/移动 → 无重复 Toast（回环）；操作进行中同时在 Finder 改动 → 操作完成后事件补应用、状态自洽；
   - Finder 删除被监听目录 → error Toast 不崩溃；
   - 断开外置盘后删除/重命名盘上照片 → ENOENT 提示 + 自动剔除 + 收藏标签保留；
   - `chmod 000` 子目录后扫描 → 「部分内容无法读取」+ 重试只补漏项；
   - 跨卷移动部分失败 → 重试不产生重复副本；
   - 拖入文件含 1 个被外部占用 → 明确提示跳过数量，无半状态。
3. 完成后回填 TODO.md：6.2/批次 A 中 K1、K2 标记已完成，N5 标记完成并更新里程碑表。
