# PhotoMinder

> 基于本地的 macOS 风格照片 / 视频管理桌面应用。纯本地处理，所有文件操作（重命名、删除、导出）均直接作用于磁盘，不上传任何文件。

PhotoMinder 让你像管理本地文件夹一样整理照片与视频：递归导入、批量重命名（含乱码修复）、重复照片检测与清理、EXIF 详情查看、格式转换导出，并用 DeepSeek AI 为照片生成描述与标签。整个过程全部在本地完成，没有云端同步、没有隐私泄漏风险。

## 核心特性

**导入与浏览**

- 打开文件夹：主进程一次性递归扫描（限制深度、跳过 `.` 开头的隐藏文件与符号链接），支持扩展名白名单
  - 图片：`jpg/jpeg/png/gif/webp/svg/heic/heif/avif/bmp/tif/tiff`
  - 视频：`mp4/m4v/mov/webm/ogv/ogg/mkv/avi/wmv/flv/3gp/3g2/mpeg/mpg/m2ts/mts/ts/asf/rm/rmvb/vob/f4v/divx/dv/mxf`
- 添加文件：文件选择器多选导入（图片与视频）
- 拖放导入：拖入图片 / 视频或**整个文件夹**（文件夹走递归扫描、可取消）即导入；Electron 下通过 `webUtils.getPathForFile` 解析真实路径以便后续管理，受限来源则降级为「仅预览」（不可重命名 / 删除 / AI 分析），不支持的文件会明确提示忽略数量
- 导入可取消：大批量导入时显示进度浮层，可随时「取消添加」，已处理部分保留、不残留半状态
- 虚拟滚动网格 + 列表双视图，万级项目保持流畅
- 按名称 / 大小 / 内容创建时间 / 修改时间 / 拍摄时间排序；按日期自动分组（今天 / 昨天 / 具体日期），网格滚动时顶部吸附日期胶囊
- 收藏标记、多选（⌘/Ctrl 多选、Shift 区间连选、方向键导航）、一键重置列表
- 侧栏导航：图库（所有照片 / 图片 / 收藏夹 / 已隐藏）+ 媒体类型（视频 / 自拍 / 实况照片 / 截屏）+ 智能相簿 + 文件夹（含「最近打开」一键重开），各带实时计数
- QuickLook 大图预览：缩放（双击在 1x / 2x 间切换）、旋转、拖拽平移、上一张/下一张、页码、收藏、**幻灯片自动播放**；视频直接内嵌播放
- 按需缩略图：卡片进入视口才请求对应尺寸的缩略图（分辨率档位量化 + 并发闸门 + 同 key 去重），不必在导入时逐张预生成
- 视频首帧缩略图：主进程无法解码视频，改由渲染进程用 `<video>` 抓首帧后回写主进程落盘缓存，二次访问直接命中
- 视频信息补全：播放器读到元数据后上报时长 / 分辨率并落盘缓存，网格卡片显示**时长角标**，详情面板展示时长 / 分辨率 / 容器格式
- 视频无法预览时给出明确占位与提示，并提供「在访达中显示」的外部播放器兜底

**搜索与筛选**

- 关键词搜索：文件名、扩展名 / MIME、相机机型，以及 **AI 生成的标签与描述**
- 可组合筛选（工具栏漏斗按钮）：
  - 范围：仅收藏、媒体类型（全部 / 图片 / 视频）
  - 日期范围：今天 / 最近 7 天 / 最近 30 天 / 今年 预设，或自定义起止日期（按拍摄时间，缺失时用修改时间）
  - 相机 / 机型（EXIF 厂商 + 机型）与格式（库中出现过的扩展名），均为多选
  - 文件大小分档（< 500 KB … > 10 MB）
  - 视频时长分档（< 10 秒 … > 5 分钟），仅在库含视频时出现
- 多条件取交集、即时生效；侧栏分类与筛选面板共用同一份状态，始终一致
- 「已启用条件条」显式列出每条条件与命中数量（`N / M 项`），可逐条 ✕ 或一键「清除全部」；筛选导致结果为空时给出专门的空状态与「清除筛选」入口
- 筛选变化后自动收敛多选，不会误删被条件隐藏的条目；其中媒体类型筛选随视图偏好跨重启保留，日期 / 标签等高级条件不保留

**媒体类型（仿 macOS「照片」）**

- 侧栏「媒体类型」自动归类：视频 / 自拍 / 实况照片 / 截屏，与「图库」共用同一份筛选状态，可与其他筛选条件叠加
- 识别规则（全部本地启发式，见 `mediaTypes.ts`）：
  - **截屏**：文件名关键词；或「PNG + 无相机 EXIF + 精确命中常见屏幕分辨率」组合判定
  - **自拍**：文件名关键词；或 EXIF 镜头型号为前置摄像头（iPhone 等会写明 `front camera`）
  - **实况照片**：同目录存在主干名相同的图片 + 视频配对（如 `IMG_1234.HEIC` + `IMG_1234.MOV`）
- 筛选面板中的「媒体类型」同步提供这六个选项，可与日期 / 相机 / 格式 / 大小 / 时长自由组合

**整理与查看（借鉴 macOS「照片」）**

- **隐藏**：右键或批量隐藏，隐藏项默认不出现在任何视图，集中收在侧栏「已隐藏」中，可随时取消隐藏
- **智能相簿**：把当前筛选条件存为命名相簿（侧栏「+」或条件条「存为相簿」），内容随图库自动更新，可一键应用 / 删除
- **用户标签**：详情面板为照片 / 视频添加、移除标签（与 AI 标签分开维护），标签参与搜索，也可作为筛选条件
- **调整日期与时间**：批量平移（天 / 时 / 分）或设为指定时间（可保持原有相对间隔）；仅修改应用内记录，不改动原文件，详情面板会标注「已修正」
- **状态持久化**：收藏、隐藏、标签、时间修正、智能相簿、视频元数据、封面、最近打开的目录写入 `userData/config.json`；AI 分析结果单独存 `userData/ai-cache.json`（上限 2000 条，超出淘汰最早）；AI 服务配置（API Key / 接口地址 / 模型）存 `userData/ai-config.json`；主题、排序、网格缩放、媒体筛选、侧栏 / 详情面板开合、重复检测参数一并记忆；窗口尺寸与位置由主进程记录（含多屏保护）。均采用「临时文件 + rename」原子替换写入

**文件管理**

- 单张重命名（详情面板就地编辑）与批量重命名四种模式
  - 格式化名称：自定义前缀 + 起始编号 + 编号位数（补零）
  - 按拍摄时间命名：支持 `yyyy/MM/dd/HH/mm/ss` 自定义格式与前缀
  - 替换文本：支持正则表达式（含 `$1` 捕获组），实时预览结果
  - 乱码修复：修复被错误解码的中文文件名（UTF-8/GBK 被当作 Latin-1），去掉 `IMG_2639`、`mmexport…` 等无意义前缀与「(1)」「副本」等重复标记，清理后仍无意义时回退为按拍摄时间命名
- 重命名不覆盖：目标同名（且不是自身）时主进程自动追加序号（`-1`、`-2` …），并把最终文件名回传前端同步，绝不静默覆盖；批量改名在批内也会预留重名序号
- 删除：批量移入系统回收站（跨平台 `shell.trashItem`），逐张返回失败原因；失败项可在 Toast 上一键重试
- 批量导出（ExportModal）：原格式（直接复制，HEIC 亦可）/ JPEG / PNG / WebP，质量可调、可选目标目录、显示进度、可中途取消、同名自动追加序号
- 复制图片到系统剪贴板、复制文件路径、在访达 / 资源管理器中定位文件
- 用系统默认应用 / 外部编辑器打开
- 设为封面：全库标记一张封面照片，网格卡片显示「封面」角标（路径已持久化；消费场景见计划 N7）
- 重命名与删除均同步更新磁盘上的真实文件

**重复照片检测**（整页视图）

- 主进程计算 dHash 感知哈希（并发受控 + 内存缓存），不阻塞渲染线程
- 三级解码降级：渲染进程 `createImageBitmap`（解码期直接缩放到 9x8，最快）→ 主进程 `nativeImage`（可复用已落盘缩略图）→ `<img>` + canvas 兜底（SVG 等）
- 体积预筛：与前后邻座体积差均超过 10% 的图片不可能成组，直接跳过哈希计算，大库常可省掉一大半解码
- 精确相同（哈希完全一致）优先成组；近似相似用汉明距离在「体积相近」的候选簇内聚类（并查集归组）
- 可配置：相似度阈值滑杆（80%–100%，默认 ≥ 90%；内部换算为 dHash 汉明距离）+ 比对范围「全库跨目录 / 仅同目录」，调整后自动重新分组（复用指纹缓存，无需重算）
- 相似度可见：每张拷贝显示与保留项的相似度百分比（100% 显示为「完全相同」），组头显示平均相似度
- 自动推荐每组保留的照片（拍摄时间最早 → 文件创建时间最早 → 修改时间最早 → 体积最大）
- 检测进度：阶段提示、已处理 / 总数、已用时、预计剩余、跳过与缓存复用数量，可随时取消
- 结果以可展开分组呈现，支持「每张标记」「整组操作」「只留每组原图」批量标记，实时统计待删除张数与可释放体积，一键移入回收站

**详情面板**

- EXIF 信息：相机厂商、型号、快门、光圈、ISO、焦距、镜头型号、方向、色彩空间、GPS 坐标（只读）
- 图片尺寸、文件大小、内容创建时间 / 修改时间 / 创建时间
- 就地重命名（Enter 提交 / Esc 取消）
- 导出转换：JPEG / PNG / WebP，可调节质量，实时预览与体积估算；单张保存到「下载」
- 视频：内嵌播放器预览，展示时长 / 分辨率 / 容器格式；无法在应用内解码时给出明确说明与「在访达中显示」兜底；图片专属的导出 / AI 区块自动隐藏
- DeepSeek AI 分析：生成图片描述与标签。API Key / 接口地址 / 模型可在应用内「AI 设置」（详情面板 AI 区块的齿轮按钮，或菜单「设置 → AI 分析设置…」/ `⌘,`）中配置，也可继续用 `DEEPSEEK_API_KEY` 等环境变量；主进程读盘并代理请求，渲染进程既不持有 `File` 对象也不接触密钥。未配置密钥时点击「分析图片」会直接引导到设置面板

**界面与体验**

- 深色 / 浅色主题切换：界面色值统一走 CSS 变量（`--bg-*` / `--text-*`），遮罩、模态、工具栏、骨架屏等均随主题自适应
- 侧边栏（图库导航 + 文件夹来源 + 主题切换）与详情面板可折叠，抽屉式收展
- 磁盘缩略图缓存（写入 `userData/thumbnails`，重启后复用、超限自动清理）+ 加载失败重试
- 统一缓存治理（`cacheManager.ts`）：所有进程内缓存登记为真 LRU（volatile / sticky 两级），可统一裁剪或释放
- 内存压力自适应：主进程看门狗（RSS 超阈值广播）+ 渲染进程堆占用巡检，自动裁剪缓存而不整屏重置
- 右键上下文菜单（图库级与单张级，按图片 / 视频动态裁剪条目，含打开 / 收藏 / 复制图片 / 复制路径 / 在访达显示 / 外部应用打开 / 设为封面 / 导出 / 重命名 / 删除）
- Toast 通知队列：多条堆叠、手动关闭、错误级常驻；**支持操作按钮**，删除 / 导出 / 导入失败可一键重试；位于底部，不遮挡工具栏
- 错误边界：顶层 + 图库 / 详情面板 / 重复检测局部兜底，单点异常不再导致整屏白屏
- 空状态文案区分「完全为空 / 收藏夹为空 / 搜索无结果 / 筛选后为空」，并给出对应的一键操作

## 技术架构

| 分类 | 选型 |
| --- | --- |
| 桌面壳 | Electron 44（主进程 `electron/main.js` + 预加载 `electron/preload.js`） |
| 前端 | React 19、TypeScript 7 |
| 构建 | Vite 8（`@vitejs/plugin-react`） |
| 样式 | Tailwind CSS 4（CSS-first `@theme`）+ 自定义 CSS 变量 `src/styles/styles.css` |
| 元数据 | exifreader（主进程解析） |
| 图片格式 | heic-convert（HEIC/HEIF → JPEG，带磁盘缓存） |
| AI | DeepSeek（`deepseek-flash` 视觉模型，主进程代理，无第三方 SDK 依赖） |

**关键设计**

- **自定义 `pm://` 协议**：原图、原视频与磁盘缩略图通过流方式从主进程提供，渲染进程只持有 `pm://...` 地址，避免把整张图片以 base64 常驻内存（OOM 根因）；视频请求实现 HTTP Range 语义（`206 Partial Content`），支持边下边播与拖动进度条。
- **主进程承担重活**：目录扫描（含取消）、文件头解析图片尺寸、EXIF/GPS 解析（`get-metadata` 一次读取，只读文件头前 512KB）、感知哈希计算（`get-image-hashes`）、HEIC 转换与缩略图生成，全部在主进程并发限流完成，渲染线程保持响应。
- **磁盘缩略图缓存**：`ensureThumbnail` 生成一次即落盘（`userData/thumbnails`），命中即返回；每写入一批触发检查、`pruneThumbCache` 在超出上限后清理最久未访问项；视频首帧由渲染进程抓取后经 `cache-thumbnail` 回写，key 与图片缩略图一致。
- **按需缩略图解析层**：`src/lib/cache/thumbCache.ts`（框架无关）+ `src/components/grid/ThumbnailImage.tsx`（React 绑定）。卡片进入视口时才请求，配合并发上限 12、同 key 去重、`pm://` 地址与 `data:` 首帧分桶限量，并「先预加载解码再替换」避免闪烁。
- **滚动虚拟化**：网格 `VirtualGrid` 与列表行均只渲染视口内（含 overscan）元素，rAF 节流滚动事件。
- **统一内存治理**：`src/lib/cache/cacheManager.ts` 提供真 LRU（命中刷新 + 逐项淘汰）、`volatile` / `sticky` 分级、`releaseMemory('soft' | 'hard')` 统一释放；主进程看门狗按 RSS 广播内存压力，渲染进程另有堆占用巡检兜底。
- **统一日志器**：渲染进程 `src/lib/logger.ts`、主进程 `electron/lib/logger.cjs`，调试日志仅在开发构建输出，打包后静默，避免磁盘完整路径进入发布产物。

## 目录结构

```
.
├── electron/                       # 主进程（Node / CommonJS）
│   ├── main.js                     #   窗口、菜单、文件系统/IPC、pm:// 协议、扫描/哈希/缩略图/EXIF
│   ├── preload.js                  #   contextBridge 暴露 window.electronAPI
│   └── lib/logger.cjs              #   主进程轻量日志器（开发输出 / 打包静默）
├── src/                            # 渲染进程（React / Vite）
│   ├── main.tsx                    #   挂载入口（createRoot + ErrorBoundary）
│   ├── App.tsx                     #   应用主组件与状态编排（大拆分见计划 X7，明确延后）
│   ├── components/                 #   UI 组件（按功能域分组）
│   │   ├── layout/                 #     Sidebar / Toolbar / ActiveFiltersBar
│   │   ├── grid/                   #     ImageGrid / ThumbnailImage
│   │   ├── timeline/               #     TimelineGallery
│   │   ├── detail/                 #     DetailsPane / QuickLook
│   │   ├── duplicate/              #     DuplicateDetector
│   │   ├── filter/                 #     FilterPanel
│   │   ├── modal/                  #     Rename / Export / AdjustDate / SaveAlbum / DeleteConfirm / AiSettings
│   │   └── common/                 #     Toast / ErrorBoundary / LoadingOverlay / ContextMenu / DragOverlay / ShortcutsOverlay
│   ├── hooks/                      #   useThemeMode / useToasts / useDuplicateDetection
│   ├── services/                   #   aiService（DeepSeek 图片分析，经 IPC 走主进程代理）
│   ├── lib/                        #   领域与基础设施逻辑
│   │   ├── cache/                  #     cacheManager / thumbCache / dragThumbnail
│   │   ├── media/                  #     mediaTypes / videoMeta / photoGrouping
│   │   ├── filter/                 #     filters / libraryViewState
│   │   ├── persistence/            #     persistence / aiCache
│   │   ├── fs/                     #     fileOperations / pathUtils
│   │   ├── contextMenuActions.ts   #     右键菜单项构造
│   │   └── logger.ts               #     渲染进程轻量日志器
│   ├── types/                      #   index.ts（领域类型）+ global.d.ts（window.electronAPI）
│   ├── utils/index.ts              #   格式化 / dHash / 重复检测 / 乱码修复等通用工具
│   └── styles/styles.css           #   主题变量与基础样式（Tailwind v4 CSS-first）
├── build/                          # electron-builder 资源（图标 / afterPack 钩子）
├── index.html                      # Vite 入口 HTML
├── vite.config.mts                 # Vite 配置（React + Tailwind 插件、@ 别名）
├── tsconfig.json                   # 解决方案配置（references）
├── tsconfig.app.json               # 渲染进程 TS 配置（DOM 环境）
├── tsconfig.node.json              # 主进程 TS 配置（Node 环境）
├── .env.example                    # 环境变量示例
└── package.json
```

## 快速开始

**环境要求**：Node.js 20.19+ 或 22.12+（Vite 8 / Electron 44 要求）、npm

```bash
# 1. 安装依赖
npm install

# 2.（可选）配置 DeepSeek API Key，用于 AI 图片分析
#    方式一：启动后在应用内「设置 → AI 分析设置…」（⌘,）填写，无需重启
#    方式二：cp .env.example .env.local 后填入 DEEPSEEK_API_KEY（详见 .env.example）
cp .env.example .env.local

# 3. 启动
npm run dev              # 仅 Web（Vite 开发服务器，默认 http://localhost:3000）
npm run electron:dev     # Electron 桌面应用
```

> `electron:dev` 通过 `ELECTRON_START_URL` 指定渲染进程地址（`http://localhost:3000`），与 `vite.config.mts` 的 `server.port`（3000）保持一致。
> 若自行修改端口，请同步更新两处，否则 Electron 窗口会白屏。

**打包**

```bash
npm run build           # 构建前端产物到 dist/
npm run electron:build  # 构建并使用 electron-builder 打包（当前仅 macOS arm64）
npm run dist:mac        # 同上，显式指定 macOS arm64
```

**产物体积**

macOS arm64 的 DMG 约 80MB（解压安装后约 227MB），其中 Electron Framework 主体二进制就占 190MB，这部分无法再压缩。已做的瘦身：

- `build/afterPack.js`：移除 Electron 自带的 200+ 套无用语言包（仅留 `en` / `zh_CN`）与 SwiftShader。
- `build/files` 排除规则：只保留 `libheif-js` 真正被 `heic-decode` 加载的那一个 wasm 打包文件（`libheif-wasm/libheif-bundle.js`，wasm 已内嵌），并去掉 `exifreader` 的 `src/` 与 `bin/`。
- `build/recompressDmg.js`：`electron-builder` 的 `dmg.format` 不支持 lzma，因此在它产出 UDZO 之后用 `hdiutil convert -format ULMO` 重压。对同一个 Electron 二进制采样，压缩率 zlib 49.8% / lzfse 48.9% / bzip2 45.1% / **lzma 31.8%**，这一步能把 DMG 再降约 24%。非 macOS 或无收益时自动跳过。

## 快捷键

主视图（输入框 / 弹层打开时让行）：

| 按键 | 功能 |
| --- | --- |
| `⌘A` / `Ctrl+A` | 全选当前视图（收藏夹内只选收藏） |
| `⌘F` / `Ctrl+F` | 聚焦搜索框（搜索框内按 `Esc` 清空） |
| `⌘⇧F` | 批量收藏 / 取消收藏选中项 |
| `⌘O` / `Ctrl+O` | 打开目录（应用菜单） |
| `⌘,` / `Ctrl+,` | 打开 AI 分析设置（配置 DeepSeek API Key / 接口地址 / 模型） |
| `空格` / `Enter` | 打开 QuickLook 预览 |
| `←` `→` `↑` `↓` | 单张选择移动（上下按网格列数跳步） |
| `Delete` / `⌫` | 删除确认 |
| `Esc` | 关闭右键菜单，其次清除选择 |

重复照片检测页：

| 按键 | 功能 |
| --- | --- |
| `Esc` | 返回图库（QuickLook 打开时先关闭预览） |

QuickLook 预览打开时生效：

| 按键 | 功能 |
| --- | --- |
| `→` / `l` / `PageDown` | 下一张 |
| `←` / `h` / `PageUp` | 上一张 |
| `+` / `-` | 缩放 |
| `0` | 重置缩放与旋转 |
| `r` | 顺时针旋转 90°（`Shift` + `r` 逆时针） |
| `f` | 收藏 / 取消收藏当前项 |
| `空格` | 图片：切换幻灯片自动播放；视频：播放 / 暂停 |
| `Esc` / `q` | 关闭预览 |

> 鼠标：双击在 1x / 2x 之间切换，放大后可拖拽平移。

## 环境变量

| 变量 | 说明 | 安全提示 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek API Key，用于详情面板的 AI 图片描述与标签。可直接在应用内「AI 设置」填写（写入 `userData/ai-config.json`），或写入 `.env.local`（示例见 `.env.example`）。**仅由 Electron 主进程读取** | 密钥不会进入前端产物；应用内设置优先级高于环境变量 |
| `DEEPSEEK_BASE_URL` | 可选，默认 `https://api.deepseek.com`；也可在应用内覆盖 | — |
| `DEEPSEEK_MODEL` | 可选，默认 `deepseek-flash`（支持图像输入）；也可在应用内覆盖 | — |

> 优先级：应用内「AI 设置」保存的值 > 环境变量（`.env.local` / `.env` / 系统环境变量 / `userData/ai.env`）> 内置默认值。任一字段在应用内留空即自动回退到环境变量。

## 已知限制

- **视频能否播放取决于内置编解码器**：`mp4/m4v/mov(H.264)/webm` 通常可直接播放；`mkv/avi/wmv/rmvb` 等容器仍可导入与整理（重命名 / 删除 / 在访达显示），但可能无法在应用内播放——此时会给出明确提示与「在访达中显示」，不会只留一块空白。
- **视频时长 / 分辨率依赖播放器上报**：主进程无法解码视频，这些信息只能由渲染进程加载视频后读取。从未在网格中出现过、也未被打开过的视频可能暂显示「读取中…」，打开一次后即写入 `userData/config.json`，之后长期可用。
- **视频不参与重复检测与 AI 分析**：逐帧比对与整段 base64 编码代价过高，仅图片支持。
- **媒体类型为本地启发式**：截屏 / 自拍依赖文件名与 EXIF，无法保证 100% 准确；实况照片需配对视频也已导入才能识别，且配对视频仍会作为普通视频单独出现（不会合并成一条）。
- **拖放降级照片不可管理**：拿不到磁盘路径的拖放图片仅可预览，无法重命名 / 删除 / AI 分析。
- **重命名遇同名会加序号**：不再覆盖，但也不会做「交换」类批量改名（如 a↔b 会得到 `a` 与 `b-1`），避免任何丢文件风险。
- **相似检测近似匹配仍有边界**：阈值可在检测面板内调整（80%–100%，默认 ≥ 90%），但相似匹配仅在「体积 ±10%」的簇内进行，且单簇超过 150 张时只保留精确匹配（防止 O(n²) 退化）。
- **API Key 明文存储**：应用内「AI 设置」保存的密钥以明文写入 `userData/ai-config.json`（仅本机、仅主进程读取，不进前端产物）。个人本地单机使用可接受（计划 X1，明确延后）。
- **安全配置偏松**：启动时带 `no-sandbox`、窗口 `sandbox: false`、`pm://` 协议 `bypassCSP`，且无 CSP 与 IPC 路径校验（计划 X2，明确延后）。
- **照片列表不自动恢复**：应用以「打开文件夹」为入口、不维护常驻图库，因此重启后不会自动重新扫描上次的目录（可在侧栏「最近打开」一键重开）。收藏 / 标签 / AI 结果等均按**文件路径**记录，文件被重命名或移动后会失去关联。
- **配置记录不自动清理**：已不存在的文件对应的收藏 / 标签 / AI 结果会保留在配置里（只是不再被应用），不会自动删除，以免误删仍可能在其它目录导入的记录。
- **时间修正不写回原文件**：调整日期只改应用内记录（用于排序 / 分组 / 筛选），原文件的 EXIF 未被改动；真实写回见计划 F4。
- **智能相簿是条件相簿**：只能保存筛选条件，不能手动拖入指定照片（手动相簿见计划 F1）。
- **封面仅角标**：设为封面后只在网格卡片显示角标，暂无「以封面代表相册」的消费场景（计划 N7）。
- **QuickLook 保持深色底**：大图预览刻意使用深色背景（与系统「预览 / 照片」一致），不随浅色主题变化。
- **跨平台**：删除已用 `shell.trashItem` 支持三端，但打包（electron-builder）目前仅 macOS（计划 X5，明确延后）。
- **尚无**：撤销/重做（F2）、时间线视图（F3）、元数据写入（F4）、基础图片编辑（X3）、地图视图（X4）、测试与 CI（X8）。

> 完整的开发计划与待完善清单见 [`TODO.md`](./TODO.md)（个人使用版，编号 N / F / X）。

## 许可证

MIT License，见 [`LICENSE`](./LICENSE)。
