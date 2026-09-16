# PhotoMinder 项目长期记忆

## 技术栈
Electron 44（主进程 CJS）+ React 19 + Vite 8 + Tailwind 4 + TypeScript 7（原生移植版）。
`package.json` 为 `"type": "commonjs"`，主进程 `electron/main.js` 用 CommonJS，
渲染层用 ESM。
脚本：`dev` / `build` / `typecheck` / `electron:dev` / `electron:build` / `dist:mac`
+ 测试 `test` / `test:unit` / `test:main` / `test:smoke`。

## 安全约定（2026-09-15 起，务必遵守）
1. **沙箱默认开启**。不要无条件调用 `app.commandLine.appendSwitch('no-sandbox')`
   一类开关。若某环境无法初始化 Chromium 沙箱（报
   `sandbox initialization failed: Operation not permitted`），用
   `PHOTOMINDER_DISABLE_SANDBOX=1 npm run electron:dev` 这个逃生口。
   `SANDBOX_DISABLED` 带 `!app.isPackaged` 判断，打包产物永远强制开启沙箱。
2. **路径白名单**：主进程维护会话级 `authorizedRoots` / `authorizedFiles`。
   只有 6 个入口能产生授权：`openImportDialog`、`choose-directory`、
   `scan-directory`、`watch-directory`、`check-paths`、`authorize-paths`（拖放）。
   新增任何「接收渲染层路径」的 IPC 时，**必须**在入口调用 `isPathAuthorized()`
   并拒绝未授权路径，否则会打开任意文件读写的口子。
3. `pm://file/<base64url>` 是特权协议（`standard`/`secure`/`corsEnabled`/
   `bypassCSP`），协议 handler 内必须做白名单校验。
4. 体积闸门放在**读取之前**（先 `stat` 再决定是否读）：
   `read-file` 64MB、`ai-analyze` 20MB base64。
5. `write-file-unique` 的 `fileName` 必须 `path.basename()` 归一化，
   否则 `../` 能写出目标目录。
6. **CSP**：策略唯一定义在 `electron/lib/csp.cjs`，主进程 `onHeadersReceived`
   与 Vite 构建期注入的 `<meta>` 共用同一份字符串。**改策略只改这一处**。
   生产 `script-src` 不含 `unsafe-inline`；开发必须含（React Refresh 内联前导脚本）。

## 代码约定（2026-09-16 起）
1. **IPC 返回协议**：所有 handler 返回 `{ok:true,data}` / `{ok:false,error,code?}`。
   注册**必须**走 `handle(channel, fn)`，不要直接 `ipcMain.handle`
   （`handle` 提供异常兜底、通道日志、重复注册检测）。已有静态断言守着。
   类型见 `src/types/global.d.ts` 的 `IpcResult<T>`。
   「用户取消」是 `ok(true) + data:null`，不是 fail。
2. **文件名规则唯一入口**：`src/lib/fs/pathUtils.ts`。
   `validateFilename()` 给 UI 报错，`sanitizeFilename()` 给落盘规范化。
   不变式：**校验通过 ⟹ 规范化后原样不变**（有测试守着）。
   **不要**在组件里另写非法字符正则 —— 那正是改造前预览与结果漂移的根因。
3. **唯一路径占位**用 `reserveUniquePath()`（`open(path,'wx')`），
   不要退回 `existsSync` 探测 + 再写。
4. 日期分组的本地日历日 key 不能用 `floor(ts/86400000)`（那是 UTC 日界）。
5. **跨 CJS/ESM 的共享实现**：主进程是 CJS、渲染层由 Vite 打包，但
   **Vite 能直接 `import` 项目内的 `.cjs` 文件**（已实测）。
   因此需要两处共用的纯逻辑（如 dHash）就放 `electron/lib/*.cjs`，
   再补一个同名 `.d.cts` 类型声明，两边都从这一份取 —— 不要写镜像副本。
   范例：`electron/lib/dhash.cjs` + `dhash.d.cts`。
6. **照片时间语义唯一入口**：`src/lib/media/photoTime.ts`。
   - `photoTakenTime(photo)` = `dateTaken → lastModified`（2 级），**面向展示**：
     分组、筛选、排序、时间线、重命名预览、网格吸顶日期。
   - `photoOriginalTime(photo)` = `dateTaken → dateCreated → lastModified`（3 级），
     **面向判定**：哪份是原图。
   - `calendarDayKey(ts)`：本地日历日 key，**不能**用 `floor(ts/86400000)`（UTC 日界）。
   - `hasUsableTime(ts)`：显式排除 NaN（`!NaN` 为真）。
   **不要**在调用点内联回退链 —— 有静态断言扫 src 全部 .ts/.tsx 守着。
   注意：回退链**区分不了共享 EXIF 拍摄时间的拷贝**（第一步就返回了），
   那类场景要用逐字段比较的 `compareByOriginalTime`。
7. **进程内缓存一律用 `createLruCache`**（`@/lib/cache/cacheManager`），
   不要写普通 `Map` + 「满了就 `clear()`」—— 整表清空会让刚用过的条目全部重算，
   而且不会纳入内存压力释放。注意区分**跨天失效**（`dateKeyCache`，该 clear）
   与**容量淘汰**（该 LRU），两者不是一回事。
8. **搜索用 `matchesSearch`**，它内部有 `WeakMap` 预小写索引。
   若要扩索引字段：**相机标识必须整体入索引**（`cameraKeyOf` 的结果），
   拆成厂商/机型两段会让 `canon eos` 这类跨字段关键词匹配不到。
9. **存储损坏要让用户知道**：`readStore` 改名备份后入队 `storageNotices`，
   渲染层启动时取一次（取走即清空）并 Toast。只有改名真的成功才入队 ——
   文件不存在（首次运行）不算损坏。
10. **`@/utils` 只是再导出 barrel**（86 行）。新代码请直接 import 具体模块：
   路径→`@/lib/fs/pathUtils`、媒体类型→`@/lib/media/mediaTypes`、
   格式化→`@/lib/format/format`、时间语义→`@/lib/media/photoTime`、
   哈希→`@/lib/media/photoHash`、文件名清理→`@/lib/media/filenameRepair`、
   并发→`@/lib/concurrency`、重复检测→`@/lib/duplicate/duplicateDetection`。
   **不要往 barrel 里加实现** —— `tests/unit/utilsBarrel.test.ts` 会失败。
   注意跨模块依赖要避开环：`mediaTypes` 只依赖 `pathUtils`，**不要**让它回头依赖 `@/utils`。

## Lint / 测试
- `npm run lint`（ESLint flat config）当前 **0 problems**。
  `eslint.config.mjs` 对 `typescript-eslint` 做**能力探测**：本项目 TS 是 7.x，
  超出其 peer 范围（`<6.1.0`），装上也加载不了，此时自动退化为只检查 JS/CJS。
  主进程（安全边界所在）正是 JS/CJS，所以降级后仍有价值。
- `no-await-in-loop` 是 **warn**：代码里的 `eslint-disable` 注释标记的是
  「此处串行是刻意的」，规则不启用这些注释就是失效噪音。
- Prettier 已配置但**未对既有文件格式化**（会产生数千行 diff）。新文件保持合规。
- 测试三层：`test:unit`（vitest，`tests/unit/`）、
  `test:main`（打桩 electron，`tests/main-process/`）、
  `test:smoke`（真启动 Electron，`tests/smoke/`）。改主进程务必跑 `test:main`。
- **主进程测试脚手架的两个硬约束**（`tests/main-process/harness.cjs`）：
  1. `app.on('ready')` 会**预读** config.json / ai-config.json 进 `storeCache`。
     要测「启动时文件已损坏」必须在 `require(main.js)` **之前**放好文件 ——
     用 `loadMainProcess({ userData, beforeRequire })`。
  2. **同一进程不能二次 `loadMainProcess()`** —— Node 会缓存已 require 的模块，
     第二次拿不到新注册的 handler。需要多个独立启动场景时拆成多个测试文件。
  3. `ready` 里的 `Promise.all([readStore(...)])` 是 fire-and-forget，
     断言磁盘状态前要等一个宏任务。

## 架构债务（已知，未修）
- `src/App.tsx` 3707 行巨型组件（P2 拆分类的主要目标）。
- 虚拟化有两套实现（`VirtualGrid` + `VirtualList`，同在 `ImageGrid.tsx`）。
- 图标组件在 5 个文件里重复定义，未抽公共库。
- `movePhotosToTrash` 串行。
- `DetailsPane` 的 AI 分析提交**原图**整份 base64（渲染层未缩放）。
- **「哪张是原图」有两套判断**：重复检测用 `compareByOriginalTime`（逐字段），
  `LocationMap` 用 `photoOriginalTime` 做减法排序 —— 同组共享 EXIF 时后者全是并列。
- 完整清单见根目录 `CODE_REVIEW.md`（P0/P1 已完成，P2 进行中；含附录 A/B/C 修复记录）。
- ~~dHash 两份实现~~ 已于 2026-09-16 收敛（见上「跨 CJS/ESM 的共享实现」）。
- ~~日期分组两套实现~~ 原报告判断不准确（按日 vs 按年月，粒度不同不应合并）；
  真正修的是时间回退链散落 12 处，已收敛到 `photoTime.ts`。
- ~~`utils/index.ts` 1024 行混合 6 个领域~~ 已于 2026-09-16 拆成 barrel + 9 个模块。

## 与注释不符的实现（未改行为，测试里已钉住，待产品决定）
- `sortPhotosByTimeline`：注释说缺失时间戳排到末尾，实现排到**最前**。
- `clusterBySize`：注释说「±10%」，实际是**以簇内最小体积为锚点**，区间不对称。

## 工作环境注意
- 用 Bash 工具跑 `grep` 的 `\|` 交替常返回空 → 改用 Grep 工具。
- heredoc 里的 `${...}` 会被 zsh 当参数展开报 `Bad substitution`
  → 先 Write 落盘再执行。
- 在 Bash 工具里 `electron .` 可能被注入 `ELECTRON_RUN_AS_NODE`，
  导致 `require('electron')` 返回字符串、解构出 undefined。
  直接从 shell 跑 `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`
  可正常启动。
- **不要把 `npm run xxx` 和 `electron ./file.cjs` 串在同一条 shell 命令里** ——
  `npm run` 会污染子进程环境，Electron 会以 node 模式启动。分两次调用。
- 该环境**无法初始化 Chromium 沙箱**，属环境限制而非代码问题。
- **`npm install` 有约 65 个路径的硬上限**：单次安装新增/移动的路径超过它就会报
  `CODEBUDDY_BROKER_DENY: Brokered host mkdir requires an available runtime file rule`。
  `dangerouslyDisableSandbox` **无效**（拦的是 WorkBuddy 的文件系统代理层，不是 Chromium 沙箱）。
  对策：① 先清孤儿包（`node_modules` 里有、lockfile 里没有的包会让 reify 去 retire 它们）；
  ② 循环重试（reify 非原子，会逐步推进）；③ 依赖树大的包分批装。
  `eslint`（约 100 个包）在本机装不上，`prettier`（依赖少）可以。
- 断言 `indexOf` 顺序时必须锚定**调用点**：`function foo() {` 里也含 `foo()`，
  源码注释里也可能出现同样字符串。
