/**
 * 「关于与更新」页的静态内容（v0.6.5）。
 *
 * 为什么不运行时读 `CHANGELOG.md` / `ROADMAP.md`：package.json 的 build.files
 * 已排除全部 md 文件，装进 DMG 后渲染层读不到。
 * 因此这里维护一份摘要，并由 tests/unit/aboutContent.test.ts 断言
 * 「更新记录第一条 = package.json 版本」，避免发版后忘记补记录。
 */

export type RoadmapStatus = '已完成' | '进行中' | '计划中';

export interface AboutEntry {
  title: string;
  description: string;
}

export interface RoadmapItem {
  version: string;
  theme: string;
  summary: string;
  status: RoadmapStatus;
}

export interface ReleaseNote {
  version: string;
  /** ISO 日期，等宽数字展示 */
  date: string;
  highlights: string[];
}

export interface AboutContent {
  appName: string;
  subtitle: string;
  tagline: string;
  promises: AboutEntry[];
  features: AboutEntry[];
  highlights: AboutEntry[];
  tips: AboutEntry[];
  roadmap: RoadmapItem[];
  releases: ReleaseNote[];
}

export const ABOUT_CONTENT: AboutContent = {
  appName: '时光画框',
  subtitle: '本地照片整理工作台',
  tagline:
    '把散落在硬盘各处的照片收进一处：认得出、找得到、放心删。文件操作直接作用于磁盘，除可选的 AI 分析外全程不联网。',
  promises: [
    {
      title: '纯本地',
      description: '不上报、不云同步；只有你主动触发的 AI 分析与可关闭的更新检查会联网。',
    },
    { title: '不覆盖', description: '写盘前先原子占位，同名文件自动追加序号，绝不覆盖已有照片。' },
    {
      title: '可恢复',
      description: '删除进系统回收站；重命名、移动到导出都有操作日志，能撤销就撤销。',
    },
  ],
  features: [
    {
      title: '导入与扫描',
      description:
        '支持图片、视频与整个文件夹；识别 HEIC 与实况照片，读取 EXIF 拍摄时间与相机信息，重复导入按内容指纹自动去重。',
    },
    {
      title: '搜索与筛选',
      description:
        '按文件名、相机、格式搜索；日期、相机、格式、大小、时长、标签可任意组合，条件条随时可见、可一键清空。',
    },
    {
      title: '标签与相簿',
      description:
        '收藏、隐藏与标签都按内容指纹记录，改名或移动后依然跟着照片；还可以把筛选条件存成智能相簿。',
    },
    {
      title: '时光画廊',
      description: '按拍摄时间线沉浸式回顾，年份跳转与密度切换随手可用；视频直接内嵌播放。',
    },
    {
      title: '按地点浏览',
      description:
        '把带 GPS 的照片落到地图上，按拍摄地点聚合成条；旅行与出差拍的照片可以按地点集中回看。',
    },
    {
      title: '相似照片',
      description:
        '基于 dHash 感知哈希分组比对，附相似度与可释放空间；支持忽略整组、只检测选中项，清理前后都有报告。',
    },
    {
      title: '批量整理',
      description:
        '批量重命名、移动、导出与删除；删除走系统回收站并按文件名、体积、修改时间三重校验取回。',
    },
    {
      title: 'AI 分析（可选）',
      description:
        '自行配置 DeepSeek 后可为照片生成描述与标签；没有配置就完全不联网，也不会偷偷降级成别的服务。',
    },
  ],
  highlights: [
    {
      title: '本地优先',
      description: '照片、配置、缓存都在本机；网络只在 AI 分析与更新检查两处出现，且都能关。',
    },
    {
      title: '内容指纹身份',
      description: '照片身份由内容指纹决定，不认路径。整理时的标注不会因为改名或换个文件夹就丢掉。',
    },
    {
      title: '失败可解释',
      description:
        '每个失败路径都给出原因与下一步：Toast、行内错误或「在数据资产中查看」，不静默吞错。',
    },
    {
      title: '为长列表设计',
      description: '虚拟滚动、按需缩略图、原图流式读取；几万张照片也不会把内存吃满。',
    },
  ],
  tips: [
    {
      title: '直接拖进来',
      description: '把文件或文件夹拖到窗口任意位置即可导入，不需要先点导入按钮。',
    },
    { title: '⌘F 找照片', description: '聚焦搜索框，文件名、相机、格式一起匹配。' },
    { title: '空格快速预览', description: '选中后按空格打开预览，方向键翻页，可以边看边收藏。' },
    {
      title: '⌘⌫ 移入回收站',
      description: '删除先进系统回收站，操作完成后的提示条上可以直接撤销。',
    },
    {
      title: '右键做批量操作',
      description: '选中多张后右键，重命名、移动、导出、加标签都在同一处。',
    },
    { title: '⇧/ 查看全部快捷键', description: '不确定按键时按 ⇧ 加斜杠，随时唤出快捷键总览。' },
  ],
  roadmap: [
    {
      version: 'v0.7.0',
      theme: '整理版',
      summary: '从「找到照片」到「批量决定」；批量标签第一批已交付，手动相簿与收件箱仍在路上。',
      status: '进行中',
    },
    {
      version: 'v0.8.0',
      theme: '回顾版',
      summary: '让暗房、点阵与时间的身份穿在主界面上；相关能力已提前交付，待整体验收。',
      status: '计划中',
    },
    {
      version: 'v1.0.0',
      theme: '可托付版',
      summary: '发布可复现、数据可恢复、主进程不静默退出；崩溃记录与数据健康检查已提前交付。',
      status: '计划中',
    },
  ],
  releases: [
    {
      version: '0.6.5',
      date: '2026-11-20',
      highlights: [
        '新增「关于与更新」页：功能、特色、技巧、迭代计划、更新记录与版本检查集中在一处。',
      ],
    },
    {
      version: '0.6.4',
      date: '2026-11-20',
      highlights: ['修复从浏览器下载的安装包被 macOS 判为「已损坏」：瘦身后重新做 ad-hoc 签名。'],
    },
    {
      version: '0.6.3',
      date: '2026-11-20',
      highlights: [
        '应用内检查更新：发现新版本、下载 DMG 并引导安装。',
        '启动后静默检查一次，可在面板里关闭自动检查。',
      ],
    },
    {
      version: '0.6.2',
      date: '2026-11-11',
      highlights: [
        '删除、重命名与重复清理支持现场撤销，失败时给出明确原因与出口。',
        '重复检测支持忽略整组、只检测选中项与清理报告。',
      ],
    },
    {
      version: '0.6.1',
      date: '2026-11-06',
      highlights: ['数据资产面板：配置导出导入、路径重连、操作日志与撤销、按原目录增量备份。'],
    },
  ],
};

/** 最近一条更新记录：AboutView 在主进程版本尚未回传时用它兜底 */
export const LATEST_RELEASE: ReleaseNote = ABOUT_CONTENT.releases[0];
