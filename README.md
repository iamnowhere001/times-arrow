# PhotoMinder

> macOS 风格的本地照片 / 视频管理桌面应用。纯本地运行，重命名、删除、导出等文件操作直接作用于磁盘，不上传任何数据。

| 项目 | 说明 |
| --- | --- |
| 定位 | 个人自用的本地照片 / 视频整理工具，macOS 优先 |
| 隐私 | 全部本地处理；AI 分析是唯一可选的联网功能，密钥仅由主进程持有 |
| 技术栈 | Electron 44 · React 19 · TypeScript 7 · Vite 8 · Tailwind CSS 4 |
| 当前版本 | v0.6.0（开发中）· 待办与路线图见 [`TODO.md`](./TODO.md) |

---

## 快速开始

**环境要求**：Node.js 20.19+ 或 22.12+

```bash
git clone <仓库地址> photominder && cd photominder
npm install

npm run dev           # 仅 Web（http://localhost:3000）
npm run electron:dev  # Electron 桌面应用
```

> `electron:dev` 通过 `ELECTRON_START_URL` 指向渲染进程地址，需与 `vite.config.mts` 的 `server.port` 一致。改端口必须两处同步，否则 Electron 窗口白屏。

**打包**

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 构建前端产物到 `dist/` |
| `npm run electron:build` | 打包 macOS arm64 并重压 DMG |
| `npm run dist:mac` | 同上，显式指定 macOS arm64 |

DMG 约 80MB（安装后约 227MB），其中 Electron Framework 本体占 190MB。已做的瘦身：`build/afterPack.js` 剔除 200+ 套无用语言包与 SwiftShader；`build.files` 只保留实际加载的 libheif wasm 并去掉 `exifreader` 的源码与 bin；`build/recompressDmg.js` 把 UDZO 重压为 ULMO（同一样本压缩率 zlib 49.8% / **lzma 31.8%**，再降约 24%）。

---

## 功能一览

### 导入与浏览

- **三种导入方式**：菜单打开文件夹（递归扫描，限深、跳过隐藏文件与符号链接、扩展名白名单）、多选添加文件、拖放图片 / 视频 / **整个文件夹**
- **大批量可取消**：进度浮层显示阶段与数量，随时可取消，已处理部分保留、不留半状态
- **常驻来源与恢复**：打开 / 添加 / 拖入的内容都记为来源（含导入时间），重启时询问「恢复上次的图库」，确认后按来源后台重扫；来源被移动或卷未挂载时标注「不可用」，可一键移除
- **双视图**：虚拟滚动网格 + 列表，万级项目保持流畅
- **排序与分组**：按名称 / 大小 / 拍摄时间 / 创建时间 / 修改时间排序；按日期自动分组，网格顶部吸附日期胶囊，点击只看当天
- **时光画廊**：整页年 / 月时间线回顾，年份轨跳转、月份密度网格跳月，`↑/↓` 与 `j/k` 移动锚点
- **按地点浏览**：整页离线地图，EXIF GPS 落成光点并按地点聚合；底图由内嵌数据绘制（陆地轮廓 + 城市标注），纯本地不联网
- **离线地名**：坐标自动翻成「这是哪儿」——25km 内直接报地名，150km 内算「附近」，更远给「距 敦煌 192 公里」；数据来自内嵌的约 1700 条城市库，不做在线逆地理编码
- **QuickLook**：图片支持以光标为中心缩放、旋转、带边界平移；视频使用自定义播放器（缓冲区间、±10 秒、倍速 0.5×–2×、画质、音量、循环、画中画、全屏）；图片与视频共用翻页、收藏与**幻灯片**（2 / 3 / 5 / 8 / 12 秒可选，交叉淡入）
- **缩略图按需生成**：卡片进入视口才请求，不在导入时逐张预生成；视频首帧由渲染进程抓取后落盘缓存；视频时长 / 分辨率由播放器上报回填，网格显示时长角标
- **多选与侧栏**：⌘/Ctrl 多选、Shift 区间连选、方向键导航、Home / End 跳首尾；侧栏含图库分类、媒体类型、智能相簿、文件夹来源，以及三个整页视图入口

### 搜索与筛选

- **关键词搜索**：文件名、扩展名 / MIME、相机机型，以及 AI 生成的标签与描述
- **可组合条件**：仅收藏、媒体类型、日期范围（预设 + 自定义起止）、相机 / 机型、格式、体积分档、视频时长分档
- **条件条**：逐条展示命中数（`N / M 项`），可单条 ✕ 或一键清除；结果为空时给专门空状态与「清除筛选」
- 条件取交集、即时生效，侧栏与筛选面板共用同一份状态；筛选变化后自动收敛多选，不会误删被隐藏的条目

### 整理与标注

- **隐藏**：隐藏项不出现在任何视图，集中收在侧栏「已隐藏」，可随时取消
- **智能相簿**：把当前筛选条件存为命名相簿，内容随图库自动更新
- **用户标签**：与 AI 标签分开维护，参与搜索与筛选
- **调整日期与时间**：批量平移（天 / 时 / 分）或设为指定时间，仅改应用内记录，详情面板标注「已修正」
- **媒体类型自动归类**：视频 / 自拍 / 实况照片 / 截屏（本地启发式规则，见 `src/lib/media/mediaTypes.ts`）

### 文件管理

- **重命名**：单张在详情面板就地编辑；批量四种模式 —— 格式化名称、按拍摄时间、替换文本（支持正则与 `$1` 捕获组）、中文乱码修复
- **不覆盖**：目标同名且非自身时自动追加序号（`-1`、`-2`…）并回传最终文件名，绝不静默覆盖
- **删除**：批量移入系统回收站，逐项返回失败原因，失败项可一键重试
- **导出**：原格式（HEIC 亦可）/ JPEG / PNG / WebP，质量可调、可选目标目录、显示进度、可取消、同名自动加序号
- **其他**：复制图片到剪贴板、复制文件路径、在访达 / 资源管理器中定位、用外部应用打开
- 所有操作直接作用于磁盘真实文件；批量执行时显示进度、按钮置灰并拦截重复点击

### 重复照片检测（整页视图）

- 主进程并发计算 dHash 感知哈希，不阻塞渲染；三级解码降级：`createImageBitmap` → `nativeImage` → canvas 兜底
- 体积预筛跳过不可能成组的图片；精确相同优先成组，近似相似在体积相近簇内按汉明距离聚类
- 可调相似度阈值（80%–100%，默认 90%）与比对范围（全库跨目录 / 仅同目录），调参复用指纹缓存、保留结果列表
- 每张显示与保留项的相似度（100% 显示「完全相同」）；自动推荐保留项（拍摄时间最早 → 创建最早 → 修改最早 → 体积最大）
- 结果按组展开，支持逐张 / 整组 / 只留每组原图标记，实时统计待删张数与可释放体积，一键移入回收站

### 详情面板与 AI

- **EXIF**：厂商、型号、快门、光圈、ISO、焦距、镜头、方向、色彩空间、GPS（只读）
- **文件信息**：尺寸、体积、内容创建 / 修改 / 创建时间；就地重命名（Enter 提交 / Esc 取消）
- **单张导出**：转 JPEG / PNG / WebP，可调质量，实时预览与体积估算
- **视频**：内嵌播放器预览，展示时长 / 分辨率 / 容器格式；无法解码时说明原因并提供「在访达中显示」
- **DeepSeek AI 分析**：生成图片描述与标签，结果参与搜索与筛选并持久化缓存。在「设置 → AI 分析设置…」（`⌘,`）配置 Key / 接口 / 模型，主进程读盘并代理请求，渲染进程不接触密钥

### 界面与体验

- 深色 / 浅色主题（色值统一走 CSS 变量）；侧栏与详情面板可折叠
- 磁盘缩略图缓存 + 统一 LRU 缓存治理 + 内存压力自适应裁剪
- 右键菜单按图片 / 视频动态裁剪条目；Toast 队列可带操作按钮（重试）
- 顶层与局部错误边界；空状态区分「完全为空 / 收藏夹为空 / 搜索无结果 / 筛选后为空」

---

## 使用流程

| 步骤 | 怎么做 | 快捷键 |
| --- | --- | --- |
| 导入 | 菜单「文件 → 导入图片或文件夹…」选择文件夹或多选文件；或直接拖入窗口 | `⌘O` |
| 查找 | 工具栏搜索框按文件名 / 格式 / 机型 / AI 标签搜索；漏斗按钮组合筛选 | `⌘F` |
| 预览 | 选中后打开 QuickLook，`←/→` 翻页，滚轮缩放，双击 1x / 2x | `空格` / `Enter` |
| 整理 | 收藏 / 隐藏 / 加标签 / 存为智能相簿 / 批量重命名 / 删除 / 导出 | `⌘⇧F`、`⌘⌫` |
| 清理重复 | 侧栏进入「重复照片检测」，调阈值后检测，标记后一键移入回收站 | — |
| AI 分析 | `⌘,` 填入 DeepSeek Key，选中图片后在详情面板点「分析图片」 | `⌘,` |

---

## 快捷键

**主视图**（输入框 / 弹层打开时让行）

| 按键 | 功能 |
| --- | --- |
| `⌘A` / `Ctrl+A` | 全选当前视图（收藏夹内只选收藏） |
| `⌘F` / `Ctrl+F` | 聚焦搜索框（框内 `Esc` 清空） |
| `⌘⇧F` | 批量收藏 / 取消收藏 |
| `⌘O` / `Ctrl+O` | 打开目录 |
| `⌘,` / `Ctrl+,` | 打开 AI 分析设置 |
| `空格` / `Enter` | 打开 QuickLook 预览 |
| `←` `→` `↑` `↓` | 移动选择（上下键按所在行真实几何取落点） |
| `Home` / `End` | 跳到第一张 / 最后一张 |
| `⌘⌫` / `Delete` | 删除确认 |
| `Esc` | 关闭右键菜单，其次清除选择 |

**QuickLook 预览**

| 按键 | 功能 |
| --- | --- |
| `→` / `PageDown` | 下一张 |
| `←` / `h` / `PageUp` | 上一张 |
| `+` / `-` | 缩放（滚轮以光标为中心） |
| `0` | 重置缩放与旋转（视频：回到适应窗口） |
| `r` | 顺时针旋转 90°（`Shift` + `r` 逆时针，仅图片） |
| `f` | 收藏 / 取消收藏 |
| `空格` | 图片：切换幻灯片；视频：播放 / 暂停 |
| `Esc` / `q` | 关闭预览 |

**视频播放**（QuickLook 内）

| 按键 | 功能 |
| --- | --- |
| `空格` / `k` | 播放 / 暂停 |
| `j` / `l` | 快退 / 快进 10 秒 |
| `↑` / `↓` | 音量增减 |
| `m` | 静音切换 |
| 双击画面 | 全屏 / 退出全屏 |

**重复照片检测页**：`Esc` 返回图库（QuickLook 打开时先关闭预览）。

---

## 配置与数据

### AI 分析（可选）

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek Key。可在应用内「AI 设置」填写，或写入 `.env.local`（示例见 `.env.example`） |
| `DEEPSEEK_BASE_URL` | 可选，默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 可选，默认 `deepseek-flash` |

> 优先级：应用内设置 > 环境变量（`.env.local` / `.env` / 系统环境变量 / `userData/ai.env`）> 内置默认值；应用内留空的字段自动回退。密钥仅由主进程读取，不进入前端产物。未配置时除 AI 分析外所有功能照常可用。

### 数据存储位置

全部数据在本地用户目录（macOS：`~/Library/Application Support/PhotoMinder/`）。

| 文件 / 目录 | 内容 | 说明 |
| --- | --- | --- |
| `config.json` | 收藏、隐藏、标签、时间修正、智能相簿、视频元数据、常驻来源与视图偏好 | 临时文件 + rename 原子写入；解析失败自动备份为 `config.json.corrupt-<时间戳>` |
| `ai-cache.json` | AI 分析结果缓存 | 上限 2000 条，超出淘汰最早 |
| `ai-config.json` | AI 服务配置（Key / 接口 / 模型） | 明文存储，仅主进程读取 |
| `ai.env` | 可选的环境变量兜底文件 | 优先级低于 `.env.local` 与系统环境变量 |
| `thumbnails/` | 磁盘缩略图缓存 | 重启复用，超限自动清理最久未访问项 |

删除对应文件即可重置对应数据（如删掉 `thumbnails/` 释放缓存，应用会按需重建）。

---

## 技术架构

| 分类 | 选型 |
| --- | --- |
| 桌面壳 | Electron 44（主进程 `electron/main.js` + 预加载 `electron/preload.js`） |
| 前端 | React 19、TypeScript 7 |
| 构建 | Vite 8（`@vitejs/plugin-react`） |
| 样式 | Tailwind CSS 4（CSS-first `@theme`）+ `src/styles/styles.css` 的 CSS 变量 |
| 元数据 | exifreader（主进程解析） |
| 图片格式 | heic-convert（HEIC/HEIF → JPEG，带磁盘缓存） |
| AI | DeepSeek 视觉模型，主进程代理，无第三方 SDK |

**关键设计**

- **自定义 `pm://` 协议**：原图、原视频与缩略图以流方式从主进程提供，渲染进程只持有地址，避免整图 base64 常驻内存（OOM 根因）；视频请求实现 HTTP Range（`206 Partial Content`），支持边下边播与拖动进度条。
- **主进程承担重活**：目录扫描（含取消）、文件头解析尺寸、EXIF/GPS 解析（只读前 512KB）、感知哈希、HEIC 转换与缩略图生成，全部主进程并发限流完成。
- **按需缩略图层**：`src/lib/cache/thumbCache.ts`（框架无关）+ `src/components/grid/ThumbnailImage.tsx`（React 绑定），并发上限 12、同 key 去重、先预加载解码再替换避免闪烁。
- **滚动虚拟化**：网格 `VirtualGrid` 与列表行只渲染视口内元素（含 overscan），滚动事件 rAF 节流。
- **统一内存治理**：`src/lib/cache/cacheManager.ts` 提供真 LRU（命中刷新 + 逐项淘汰）与 `volatile` / `sticky` 分级；主进程按 RSS 广播内存压力，渲染进程另有堆占用巡检兜底。
- **统一日志器**：渲染进程 `src/lib/logger.ts`、主进程 `electron/lib/logger.cjs`，调试日志仅开发构建输出。

---

## 目录结构

```
.
├── electron/             # 主进程（Node / CommonJS）
│   ├── main.js           #   窗口、菜单、文件系统/IPC、pm:// 协议、扫描/哈希/缩略图/EXIF
│   ├── preload.js        #   contextBridge 暴露 window.electronAPI
│   └── lib/logger.cjs    #   轻量日志器（开发输出 / 打包静默）
├── src/                  # 渲染进程（React / Vite）
│   ├── main.tsx          #   挂载入口（createRoot + ErrorBoundary）
│   ├── App.tsx           #   应用主组件与状态编排
│   ├── components/       #   UI 组件（按功能域分组）
│   │   ├── layout/       #     Sidebar / Toolbar / ActiveFiltersBar
│   │   ├── grid/         #     ImageGrid / ThumbnailImage
│   │   ├── timeline/     #     TimelineGallery（时光画廊）
│   │   ├── map/          #     LocationMap（按地点浏览）
│   │   ├── detail/       #     DetailsPane / QuickLook / VideoPlayer
│   │   ├── duplicate/    #     DuplicateDetector
│   │   ├── filter/       #     FilterPanel
│   │   ├── modal/        #     Rename / Export / AdjustDate / SaveAlbum / AiSettings 等
│   │   └── common/       #     Toast / ErrorBoundary / LoadingOverlay / ContextMenu 等
│   ├── hooks/            #   useThemeMode / useToasts / useDuplicateDetection
│   ├── services/         #   aiService（经 IPC 走主进程代理）
│   ├── lib/              #   领域与基础设施逻辑
│   │   ├── cache/        #     cacheManager / thumbCache
│   │   ├── media/        #     mediaTypes / videoMeta / photoGrouping
│   │   ├── filter/       #     filters / libraryViewState
│   │   ├── persistence/  #     persistence / aiCache / sources
│   │   ├── geo/          #     mapMath / landMask / places / placeIndex
│   │   ├── fs/           #     fileOperations / pathUtils / ipcGuard
│   │   ├── contextMenuActions.ts
│   │   └── logger.ts
│   ├── types/            #   index.ts（领域类型）+ global.d.ts（window.electronAPI）
│   ├── utils/index.ts    #   格式化 / dHash / 重复检测 / 乱码修复
│   └── styles/styles.css #   主题变量与基础样式（Tailwind v4 CSS-first）
├── build/                # electron-builder 资源（图标 / afterPack / DMG 重压钩子）
├── index.html            # Vite 入口 HTML
├── vite.config.mts       # React + Tailwind 插件、@ 别名
├── tsconfig*.json        # 解决方案 / 渲染进程 / 主进程 三套 TS 配置
├── .env.example          # 环境变量示例
├── TODO.md               # 待办任务 / 功能改进 / 已知问题清单
└── package.json          # 含 electron-builder 打包配置（build 字段）
```

---

## 已知限制

- **视频能否播放取决于内置编解码器**：`mp4/m4v/mov(H.264)/webm` 通常可直接播放；`mkv/avi/wmv/rmvb` 等可导入整理但可能无法播放，此时给出明确提示与「在访达中显示」。
- **视频时长 / 分辨率依赖播放器上报**：从未在网格出现也未被打开过的视频可能暂显示「读取中…」，打开一次后即长期可用。
- **视频不参与重复检测与 AI 分析**，仅图片支持。
- **媒体类型是本地启发式**：截屏 / 自拍依赖文件名与 EXIF，不保证 100% 准确；实况照片需配对视频也已导入才能识别，且配对视频仍会单独出现。
- **拖放降级照片不可管理**：拿不到磁盘路径的拖放图片仅可预览。
- **重命名遇同名加序号**：不做「交换」类批量改名（如 a↔b 会得到 `a` 与 `b-1`），避免丢文件风险。
- **相似检测有边界**：近似匹配仅在体积 ±10% 的簇内进行，单簇超 150 张时只保留精确匹配（防 O(n²) 退化）。
- **图库需确认后恢复**：不自动扫描磁盘。收藏 / 标签 / 时间修正 / AI 结果均按**文件路径**记录，文件重命名或移动后会失联（重新定位见 TODO N10）。
- **无操作历史与撤销**：重命名 / 删除 / 移动直接作用于磁盘，只能事后手动改回或从回收站取回（改进见 TODO N9）。
- **配置记录不自动清理**：已不存在文件对应的收藏 / 标签 / AI 结果会保留在配置里，以免误删仍可能重新导入的记录。
- **时间修正不写回原文件**：只改应用内记录，EXIF 未被改动（真实写回见 TODO F4）。
- **智能相簿是条件相簿**：只能保存筛选条件，不能手动拖入照片（手动相簿见 TODO F1）。
- **QuickLook 保持深色底**：与系统「预览 / 照片」一致，不随浅色主题变化。
- **地图为离线轻量版**：底图与地名来自内嵌的 Natural Earth 数据（低精度陆地轮廓 + 约 1700 条城市），只到城市级、不联网。
- **打包目前仅 macOS**；删除已用 `shell.trashItem` 支持三端。
- **安全配置偏松**：启动时带 `no-sandbox`、窗口 `sandbox: false`、`pm://` 协议 `bypassCSP`，且无 CSP 与 IPC 路径校验（见 TODO X2）。
- **尚无**：撤销 / 重做、元数据写入、基础图片编辑、测试与 CI。

---

## 贡献规范

个人维护为主，欢迎 Issue 与 Pull Request。

1. 从 `main` 拉出 `feat/xxx` 或 `fix/xxx` 分支；提交前确保 `npm run typecheck` 与 `npm run build` 通过。
2. 提交信息遵循 Conventional Commits（`feat` / `fix` / `refactor` / `docs` / `chore` / `style` / `test`，可带 scope），一次提交只做一件事。
3. 代码沿用现有结构与命名：渲染进程 `src/`、主进程 `electron/`、领域与基础设施逻辑 `src/lib/`；界面文案用中文，注释与文档同语言。
4. 涉及文件操作 / 持久化的改动必须处理失败路径（写盘失败、文件被外部移动或删除），不得静默吞错。
5. 行为或功能变化时同步更新 `README.md` 与 `TODO.md`；不引入与「纯本地」定位冲突的依赖（云同步、遥测等）。

---

## 联系方式

- **维护者**：now&here · **邮箱**：nhxuyong@163.com
- **问题反馈**：优先走仓库 Issue，请附复现步骤、预期 / 实际行为与环境信息（macOS 版本、应用版本）
- **安全与数据风险**：发现可能导致文件丢失 / 覆盖的问题请直接邮件联系，勿先公开披露

## 许可证

MIT License，见 [`LICENSE`](./LICENSE)。
