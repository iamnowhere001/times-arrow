# TODO 完成存档

> 本文件保存已交付事项的历史记录，**只追加、不回改**。
> 活跃任务与当前状态看 [`TODO.md`](../../TODO.md)；产品方向看 [`ROADMAP.md`](../../ROADMAP.md)；已交付事实看 [`CHANGELOG.md`](../../CHANGELOG.md)。
> 早期记录中的测试数量、文件行数是当时快照，不代表当前基线。

## 六、完成存档

功能现状基线以 [`README.md`](../../README.md)「功能一览」为准，本文件不再重复维护。

- **2026-09-10 · v0.4.0 发布**：N1 状态持久化、N2 重命名不覆盖、N3 搜索与筛选增强、N4 体验细节打磨、N6 视频体验完善，以及隐藏 / 智能相簿 / 用户标签 / 调整日期与时间。
- **2026-09-12 第一轮 · 全量逻辑审查**：修复 1 项 P0（重命名后按路径记录的收藏 / 标签 / 封面 / AI 缓存全部丢失）、10 项 P1（隐藏项泄漏、排序取值错误、写盘串行化与失败感知等）、6 项 P2（commit `982be77`）。
- **2026-09-12 第二轮 · 操作体验审查**：修复 1 项体验阻断（拖放导入无反馈、进度永远不确定态）、9 项体验受损、7 项体验瑕疵，并复核第一轮修复无副作用。
- **2026-09-12 · N5 稳定性加固**：目录监听（`fs.watch` 递归 + 防抖聚合 + 外部变动自动同步与汇总提示）、回环防护双保险（锁内暂存 + TTL 登记）、`ipcGuard` 统一 IPC 失败上报与「文件消失」自动剔除、导入失败可重试不留半状态、移动补齐提交锁；同源 K1 / K2 一并修复。
- **2026-09-12 · N7 封面（方案二：移除）**：移除「设为封面」入口、卡片角标、数据模型与按路径迁移逻辑，无残留 UI；旧配置的 `cover` 字段不再读取。
- **2026-09-12 · K 批次 C（10 / 13）**：K14 上下键按真实行几何取落点、K15 返回图库保留滚动位置、K17 缩放滑块放宽断点、K21 删除改 `⌘⌫`、K23 入场标记到点即清、K25 时光画廊按渲染序判定月份；K18 元数据回填锚点回正、K19 批量操作补齐进度与按钮置灰、K22 调参改为轻量重分组、K24 虚拟列表窗口起点夹取。
- **2026-09-12 · F3 浏览形态补充（v0.6.0）**：新增「按地点浏览」（内嵌 0.5° 陆地掩码底图、城市标注、GPS 光点屏幕聚合、离线地名索引、悬停预览与地点照片条、QuickLook 地点内翻页）；QuickLook 幻灯片支持 2–12 秒间隔（跨会话记忆）与交叉淡入。产物增加约 44KB（gzip 约 20KB），运行时零网络请求。
- **2026-09-13 · N8 库来源持久化与恢复**：新增常驻来源（`config.json` 的 `sources`，上限 200 条，旧「最近打开」自动升级）；启动时弹「恢复上次的图库」确认框并按来源重扫（复用导入进度浮层与取消链路）；侧栏「文件夹」支持重扫 / 补回与移除，新增 `check-paths` 探测可用性并橙色标注不可用来源；移除来源只摘记录，收藏 / 标签 / 时间修正 / AI 结果按路径保留。
- **2026-09-15 · 安全边界收口（CODE_REVIEW P0，5/5）**：沙箱改为默认开启（仅未打包且显式 `PHOTOMINDER_DISABLE_SANDBOX=1` 才关，打包产物永远强制开启）；`pm://` 协议与 14 个文件类 IPC 全部接入会话级路径白名单 `isPathAuthorized()`；`read-file` 64MB / `ai-analyze` 20MB 体积闸门前置到读取之前；顺带修掉 `write-file-unique` 用 `../` 越权写盘的真实漏洞；`default.profraw` 退出 git 跟踪并加 `.gitignore`。
- **2026-09-16 · 工程化与契约收口（CODE_REVIEW P1，10/10）**：CSP 唯一定义在 `electron/lib/csp.cjs`（响应头与构建期 meta 共用同一份），`vite` host 改 `127.0.0.1`；`buildUniquePath` → `reserveUniquePath`（`open(...,'wx')` 原子占位，消除 TOCTOU）；30 个 IPC handler 统一为 `IpcResult<T>` 并强制走 `handle()` 注册；`sanitizeFilename` / `validateFilename` 成为文件名唯一入口（不变式由测试守住）；`joinPath` 对齐 `node:path.join`；ESLint + Prettier 落地（TS 侧降级，0 problems）；建立三层测试（单测 / 主进程集成 / Electron 冒烟）。
- **2026-09-16 · 架构重构（CODE_REVIEW P2，9/20）**：`App.tsx` 3707 → 1279 行，拆出 `useAppConfig`、`usePersistedLibraryData`、`useLibraryDerived`、`useLibraryImport`、`useLibrarySources`、`useIngestPipeline`、`useWatcherSync`、`useSelection`、`useFileOperations`、`useFileOpFeedback`、`useDragAndDrop`、`useKeyboardShortcuts`、`useQuickLook`、`useSmartAlbums`、`useCollapseAnimation` 共 15 个 hook；`utils/index.ts` 1024 → 86 行 barrel，实现拆到 `lib/` 下 9 个模块；dHash 收敛为 `electron/lib/dhash.cjs` 单一实现；照片时间语义收敛到 `src/lib/media/photoTime.ts`（12 处内联回退链清空，附静态断言）；搜索索引改 `WeakMap` 预小写缓存；`placeIndex` / `dateKeyCache` 改用真 LRU；存储损坏由静默备份改为 Toast 告知；地名表外置 `places.data.json` + 动态 `import()`（独立 chunk 58.8KB，主 bundle 不再承担）；四个整页视图各挂 `ErrorBoundary` + 共用 `ViewErrorFallback`。详见 `CODE_REVIEW.md` 附录 C / D。

- **2026-09-16 · 冗余清理批次（CODE_REVIEW P2-21 部分 / P2-32）**：抽公共图标库 `src/components/icons/`，收敛 5 组重复定义（返回箭头 3 份 → 1 份、刷新/重置、漏斗、加号各 2 份 → 1 份），尺寸与线宽差异在调用点参数化还原，**行为零变化**；清理 `RenameModal` 的失效 `eslint-disable`；修掉 `useFileOperations` 重命名 replace 分支里模板字符串吞掉 `\.` 的真实瑕疵（改用 `lastIndexOf + slice`）；全量「未使用 import」扫描为 0。详见 `CODE_REVIEW.md` 附录 E。

- **2026-11-05 · 主进程模块化与 AI 密钥边界（CODE_REVIEW 附录 F）**：确认产品定位为**个人自用**，据此不引入 `safeStorage`、签名公证与自动更新等分发向成本。① `electron/main.js` 2,746 → 1,292 行，拆出 `electron/main/` 4 个 .cjs（ai / authorization / media-pipeline / store），31 个 IPC channel（该批次当时口径；现为 40 个 invoke + `pm` 协议）与 preload 双向差集为空、行为零变化，补齐了此前文档滞后 7 周且未提交的重构；② `ai-config-get` 从回传明文 `apiKey` 改为 `hasApiKey` + 尾号掩码，设置弹窗改为「留空 = 保持现有值、清除需显式勾选」，`DetailsPane` 的未配置判断同步改字段；新增 `ai-config-privacy.test.cjs` 16 项钉住读取不泄露、轮换与清除后的状态。三层验证：typecheck / lint / 主进程 104 项（当时口径；现以 `npm run test:main` 实测为准） / 单测 266 项 / build 全过。三份文档快照与措辞同步至当前代码。

- **2026-11-05 · P1 数据资产专项（CODE_REVIEW 附录 G）**：标注资产的键从**磁盘路径**换成**内容指纹**，`Photo.fileId` 承载身份、`Photo.id` 保持会话内唯一；删除 `rekeyPathData` / `dropPathData` / `persistPathData` 整条补丁链，改名 / 移动 / 删后重导入自动续上标注。启动迁移器把 v1 路径键换算成指纹，不可达记录进 `orphans` 供重连续接；写盘前轮转 `config.json.bak` / `.bak.1`。新增「数据资产」面板（⌘⇧D）：配置导出导入（不含 AI 密钥）、路径重连、操作日志与撤销、按原目录增量备份（F10）。主进程 4 个写操作 handler 埋点；删除撤销在 macOS 上按文件名 + 体积 + mtime 从 `~/.Trash` 三重校验取回，失败明确报错。主进程测试 151 项（新增 data-assets 47 项），单测 266 项，typecheck / lint / build 全过。

- **2026-11-06 · v0.6.1 发布收尾**：版本号提升至 `0.6.1`、CHANGELOG 定稿、补首个 git tag `v0.6.1`、重新打包 DMG；
  `package.json` / `package-lock.json` 升到 `0.6.1`，补上仓库首个 tag `v0.6.1`，`CHANGELOG` 定稿为 `[0.6.1] — 2026-11-06`；DMG `PhotoMinder-0.6.1-arm64.dmg` 81.4MB（ULMO 重压，与 0.6.0 的 80.0MB 相当）。质量护栏 typecheck / lint 0 problems / format:check / build / 单测 266 项 / 主进程 196 项 / Electron 冒烟（CSP 违规 0、控制台错误 0）全绿；三项恢复演练 33 项全绿。
  收尾期间修复「config 已 v2 而 ai-cache 缺失导致标注被清空」的阻断缺陷并补 30 项回归测试（CODE_REVIEW 附录 H）；
  文档导航补齐 AGENTS / CHANGELOG / ROADMAP。

- **2026-11-11 · v0.7.0 第一批（批量标签）**：新增 `lib/tags/tagOperations.ts`（变更规划 / 频次统计 / 输入建议纯逻辑）、`hooks/useBatchTags.ts`（分片进度、取消、一次写盘、before 快照撤销）、`components/detail/BatchTagsPanel.tsx`；多选详情面板从只读改为可批量加 / 移除标签，侧栏新增按频次排序的标签分组（点击即筛）。新增 9 项单测（单测 379 项）。typecheck / lint / format / build / 冒烟全绿。**未发版，版本号仍 0.6.2**。

- **2026-11-11 · v0.6.2 发布（回补 + 发版）**：维护者拍板 Q11 ①。补齐 K11（重命名预览只读预演，新增受限 IPC + 20 项主进程测试 / 10 项单测）、K20（跳转规则统一 + 条件条，11 项单测）、批次 4（10px 清零 / 信息性 11px 升 12px、ErrorBoundary 可操作信息）、批次 5（`@theme` 单一来源 + `useModalA11y` 统一 9 个弹层，6 项静态断言）。版本号 `0.6.2`、tag `v0.6.2`、DMG 重打包、冒烟与发布恢复演练 6 项全绿。单测 370 项 / 主进程 251 项。唯一偏差：五个真人可用性脚本未执行。

- **2026-11-11 · v0.6.2 批次 3（重复检测收口）**：新增 `src/lib/duplicate/ignoredGroups.ts`（组稳定身份 / 忽略集 / 报告纯逻辑）与 `src/components/duplicate/DuplicateReportPanel.tsx`（报告 + 已忽略管理）；`useDuplicateDetection` 接入忽略集读写、只检测选中项、删除统计；`DuplicateScope` 扩为三档；`config.json` 顶层新增 `ignoredDuplicateGroups`。新增 15 项单测（单测 343 项 / 主进程 231 项），typecheck / lint / format:check / build / Electron 冒烟全绿。顺带修掉 11-11 提交遗留的 4 个 Prettier 文件与 README 的过时护栏数字。

- **2026-11-09 · v0.8.0 身份层提前落地**：K28 沉浸态接线（时光画廊 / 按地点 / QuickLook 共用暗房色板）、K29 统计排版（`Stat` / `StatPill`，重复检测「可释放」为唯一 hero）、K30 点阵语言（侧栏 `DotPinIcon`、加载 / 空态 `DotGrid`），以及「这一天 / 这一年」入口；地图离开后恢复视野，视频时长未知时补说明。**版本号未提升，未发版**；CHANGELOG 于 2026-11-11 对账时补记。

- **2026-11-11 · 崩溃记录与数据健康检查提前落地（v1.0 范围）**：新增 `electron/main/crash-report.cjs` / `health.cjs`，主进程异常落盘 + 下次启动提示 + 打开日志出口；数据资产面板新增健康分页（配置备份 / orphans / 缩略图缓存 / 崩溃与迁移记录）。新增 2 个主进程测试文件并纳入 `test:main`。**版本号未提升，未发版**；本次对账补齐 CHANGELOG 与 ROADMAP 口径。

- **2026-11-06 · v0.6.2 批次 1**：K13 右键菜单作用域、K16 选中态保留浏览控件、K26 相簿重名与重命名、窗口 960×640 下限、`<main>` landmark 全部落地；新增 16 项单测（单测 282 项），三层护栏全绿。期间修掉静态断言在 12 worker 并行下的 5s 超时误报（见 CODE_REVIEW 附录 I.2）。

- **2026-11-06 · P0-4 品牌统一与退出标准确认**：维护者拍板显示名「时光画框」、副标题「本地照片整理工作台」；`index.html` / 侧栏 / 配置导入导出对话框 / README / AGENTS / ROADMAP §1.4 与 Q2 全部同步。`productName` / `appId` / `payload.app` 刻意保留英文并由新增静态断言守卫。两处退出标准偏差（⌘Z 归原生、批量撤销降级）确认接受，已写进 ROADMAP 退出标准。

- **2026-11-06 · v0.6.2 批次 2（撤销前置）**：成功 Toast 接「撤销」、编辑菜单「撤销上次文件操作」（⌥⌘Z）、失败原因与「在数据资产中查看」出口、重复清理删除后带撤销全部落地；`src/lib/fs/lastOperation.ts` 收口纯逻辑，新增 17 项单测 + 1 项 IPC 事件契约断言。单测 304 项 / 主进程 197 项，全套护栏与冒烟全绿。技术结论见 CODE_REVIEW 附录 J。

- **2026-11-06 · 代码复审与工程组织优化（CODE_REVIEW §4）**：修掉 5 处真实缺陷 —— ① `moveFiles` 的 `priorTargets` 在 preload 漏传，跨卷移动重试会静默产生重复副本（**高**）；② 删除失败分流先转译再匹配 `ENOENT`，失效条目被当成可重试；③ 地图浮层点击冒泡会关掉照片条 / 误选地点；④ 取消重复检测被显示成「未检测到相似图片」；⑤ 视频循环偏好未应用到 `<video>`。组织上：空状态文案抽 `deriveEmptyStateCopy`（+7 项单测）、单条目动作抽 `usePhotoActions`，`App.tsx` 1426 → 1322 行。单测 326 项 / 主进程 197 项 / typecheck / lint / format 全绿。CODE_REVIEW 同步从 1426 行精简到 385 行（保留状态索引与各批次摘要）。

- **2026-11-20 · v0.6.3 发布**：tag `v0.6.3`（指向 `7580c58`），GitHub Release「时光画框 v0.6.3 · 更新版」含 `PhotoMinder-0.6.3-arm64.dmg` 81.4MB（ULMO 重压 107.5MB → 81.4MB，-24.3%），SHA256 与 Release 记录一致，`/releases/latest` 已能返回该版本。构建机 DNS 把 `release-assets.githubusercontent.com` 解析为 `127.0.0.1`，改用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 完成打包。

- **2026-11-20 · v0.6.4 安装修复**：用户实测从浏览器下载 v0.6.3 的 DMG 后安装，macOS 报「PhotoMinder 已损坏」。定位为 `afterPack` 瘦身删掉框架内语言包 / SwiftShader 导致 ad-hoc 签名失效，叠加隔离属性后 Gatekeeper 按「签名无效」处理。修复：瘦身后执行 `codesign --force --deep --sign - <app>`；`codesign --verify --deep --strict` 由失败转为通过，DMG 80.3MB。已装的 0.6.3 机器用 `xattr -cr /Applications/PhotoMinder.app` 可立即恢复。README 已知限制补充浏览器下载的放行说明。

- **2026-11-20 · v0.6.5 关于与更新**：左栏新增独立「应用」分区与整页视图 `AboutView`，一页呈现定位与承诺、8 项功能、4 项特色、6 条技巧、3 条迭代计划、最近 5 个版本的更新记录，并把「检查更新 / 打开发布页 / 自动检查开关」接到现有 `useUpdateChecker`。内容以 `src/lib/about/aboutContent.ts` 静态打包（md 不在打包白名单），新增单测锁定「更新记录首条 = package.json 版本」。Esc 在更新面板打开时让位，面板关闭后才返回图库。

- **2026-11-05 · v0.6.1 N9 操作日志与单次撤销**：重命名 / 删除 / 移动 / 导出逐条追加到 `operation-log.jsonl`（有上限、临时文件 + rename 原子写）；「最近操作」面板可筛选翻页；仅支持撤销最近一次删除（回收站取回）与最近一次重命名，不做多级栈。验收：回收站已清空时明确失败、同名沿用追加序号、撤销失败逐条 Toast。
- **2026-11-05 · v0.6.1 N10 配置备份与路径重连**：写盘前轮转 `config.json.bak` / `.bak.1`；提供配置导出 / 导入；来源被整体搬走后按前缀批量重算指纹续接。验收：删掉 `config.json` 可从 `.bak` 恢复、导出再导入逐项一致、重定位一次全续上、冲突保留现值并计数。

### 已核对无需复查的范围（两轮审查结论）

> 2026-09-16 复核：以下结论**仍然成立**。其中「IPC 契约」一条已由本次 P1 的
> `IpcResult<T>` 重构进一步加固 —— 30 个 handler 的返回形态现在由类型系统与
> 主进程集成测试共同守着，不再是靠人工比对。

- **IPC 契约**：27 个 `invoke` + 3 个事件的 channel 名、参数顺序、返回结构与 `global.d.ts` 完全一致（N8 新增 `check-paths`）
- **主进程文件操作**：重命名同名序号回退、删除走 `shell.trashItem`（确为回收站）、导出 `buildUniquePath` 永不覆盖、导入 / 导出取消能真正中断且无残留
- **AI 代理链路**：Key 只走主进程、`AbortController` 超时、`response.ok` 与空 content 检查、JSON 围栏容错、设置弹窗防竞态
- **缓存与内存治理**：LRU 命中刷新与逐项淘汰、volatile / sticky 分级、缩略图并发闸门与同 key 去重、generation 防旧回写、看门狗与堆巡检带冷却
- **筛选求值**：日期闭区间、大小 1024 进制、时长单位秒、无 EXIF 文件正确排除；搜索全程 `includes`，无正则注入
- **状态一致性**：侧栏与筛选面板共用状态、筛选变化后选择自动收敛、多选时用户标签有守卫、相簿条件序列化可逆
- **导入取消链路**：三处配合正确，取消后不会回写
- **QuickLook**：翻页边界、幻灯片定时器清理、切图重置、视频元素无泄漏
- **体验面向**：多选语义、删除二次确认、虚拟滚动机制、缩略图按需层（含 onerror 回退）、六种空状态、Toast 行为、右键菜单定位、导出进度、按钮文案、时光画廊导航、详情面板多选只读展示
