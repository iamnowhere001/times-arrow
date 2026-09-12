declare global {
  /** 扫描 / stat 返回的单个文件信息 */
  interface FileInfo {
    name: string;
    path: string;
    size: number;
    mtime: number;
    created?: number;
  }

  /** 目录扫描结果：区分「为空 / 根目录不可访问 / 部分内容失败」（K1） */
  interface ScanDirectoryResult {
    files: FileInfo[];
    /** 无法读取的子目录数（无权限 / 已消失） */
    failedDirs?: number;
    /** 无法 stat 的文件数 */
    failedFiles?: number;
    /** 扫描被用户取消 */
    cancelled?: boolean;
    /** 根目录级错误（不存在 / 无权限 / 不是文件夹） */
    error?: string;
    errorCode?: string;
  }

  /** 批量 stat 结果：失败路径显式返回，不再静默过滤（K1） */
  interface StatFilesResult {
    infos: FileInfo[];
    failedPaths: string[];
    error?: string;
  }

  /** 目录监听的外部变动事件（主进程已按扩展名过滤并防抖聚合） */
  interface DirectoryChangeEvent {
    /** 产生事件的监听目录 */
    dir: string;
    /** 新增的媒体文件绝对路径 */
    added: string[];
    /** 新出现的子目录（拖入监听范围的文件夹，由渲染层走扫描管线） */
    addedDirs: string[];
    /** 已消失的路径（可能是文件或目录，渲染层按前缀匹配剔除） */
    removed: string[];
  }

  /** 目录监听异常事件（目录被外部删除 / 卷被卸载） */
  interface DirectoryWatchErrorEvent {
    dir: string;
    code?: string;
  }

  /** 单个文件的移动结果（与 move-files IPC 入参等长） */
  interface MoveFileResult {
    /** 源路径 */
    from: string;
    /** 移动后的最终路径（成功时） */
    to?: string;
    success?: boolean;
    /** 是否因目标重名被自动追加了序号 */
    conflicted?: boolean;
    /** 未执行移动（如源文件已在目标目录） */
    skipped?: boolean;
    reason?: 'same-directory';
    /** 跨卷移动：副本已落盘但源文件删除失败（K2 中间态） */
    partial?: boolean;
    /** 本次结果来自「补删源」的幂等重试 */
    resumed?: boolean;
    error?: string;
  }

  /** 批量移动的整体返回 */
  interface MoveFilesResult {
    success?: boolean;
    /** 目标文件夹无效等整体性错误 */
    error?: string;
    results: MoveFileResult[];
  }

  /** 统一导入对话框的选择结果：文件与文件夹可混合多选 */
  interface PickedPaths {
    /** 直接选中的媒体文件（图片 / 视频）路径 */
    files: string[];
    /** 选中的文件夹路径（交由扫描管线递归导入） */
    directories: string[];
    /** 被扩展名过滤掉的非媒体文件数量 */
    ignored: number;
  }

  interface Window {
    electronAPI: {
      selectPaths: () => Promise<PickedPaths | null>;
      /** 选择单个目标目录；allowCreate 时面板内可直接新建文件夹 */
      chooseDirectory: (options?: { allowCreate?: boolean }) => Promise<string | null>;
      /** 读取文件为 base64（HEIC 自动转为 JPEG） */
      readFile: (path: string) => Promise<{ data: string; error?: string }>;
      /** 重命名文件；目标已存在时自动追加序号（conflicted=true），返回最终路径 */
      renameFile: (oldPath: string, newPath: string) => Promise<{
        success: boolean;
        /** 实际写入的最终路径（可能与入参不同） */
        path?: string;
        /** 是否因重名被自动追加了序号 */
        conflicted?: boolean;
        error?: string;
      }>;
      deleteFile: (path: string) => Promise<{ success: boolean; error?: string }>;
      /** 批量移动文件到目标文件夹；逐项返回成功 / 跳过 / 失败结果；
       *  priorTargets（源路径 → 上次跨卷移动已落盘的副本路径）用于幂等重试补删源 */
      moveFiles: (
        filePaths: string[],
        targetDir: string,
        priorTargets?: Record<string, string>
      ) => Promise<MoveFilesResult>;
      /** 在访达 / 资源管理器中定位文件 */
      showInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      /** 复制图片到系统剪贴板 */
      copyImage: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      /** 复制纯文本（如文件路径）到系统剪贴板 */
      copyText: (text: string) => Promise<{ success: boolean; error?: string }>;
      /** 用系统默认应用 / 外部编辑器打开文件 */
      openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      /** 写入 base64 二进制文件，同名冲突自动追加序号 */
      writeFileUnique: (
        targetDir: string,
        fileName: string,
        base64: string
      ) => Promise<{ success: boolean; path?: string; error?: string }>;

      /** 递归扫描目录；返回结果区分「为空 / 根目录不可访问 / 部分内容失败」；scanId 用于取消 */
      scanDirectory: (dirPath: string, scanId?: string) => Promise<ScanDirectoryResult>;
      /** 取消进行中的目录扫描 */
      cancelScan: (scanId: string) => Promise<boolean>;
      /**
       * 生成或命中磁盘缩略图，返回 pm:// 地址。
       * 视频无法在主进程解码：`pending: true` 表示需要渲染进程抓取首帧后回写。
       */
      getThumbnail: (
        filePath: string,
        maxSize?: number
      ) => Promise<{ url?: string | null; pending?: boolean; error?: string }>;
      /** 回写渲染进程抓取的视频首帧，返回 pm:// 地址 */
      cacheThumbnail: (
        filePath: string,
        maxSize: number,
        base64: string
      ) => Promise<{ url?: string; error?: string }>;
      /** 一次读取返回尺寸 + EXIF + 拍摄时间 */
      getMetadata: (filePath: string) => Promise<{
        dimensions?: { width: number; height: number };
        dateTaken?: number;
        exif?: import('@/types').ExifData;
        error?: string;
      }>;
      /** 批量计算感知哈希（主进程执行，返回与入参等长的数组） */
      getImageHashes: (filePaths: string[]) => Promise<Array<string | null>>;
      /** 批量获取文件 size/mtime/created；失败路径显式返回 failedPaths */
      statFiles: (filePaths: string[]) => Promise<StatFilesResult>;
      /** 监听目录（递归，感知外部增删）；切换目录时主进程自动替换旧 watcher */
      watchDirectory: (dirPath: string) => Promise<{ success: boolean; already?: boolean; error?: string }>;
      /** 停止目录监听 */
      unwatchDirectory: () => Promise<boolean>;
      /** 订阅外部变动事件（已聚合）；返回取消订阅函数 */
      onDirectoryChanged: (callback: (event: DirectoryChangeEvent) => void) => () => void;
      /** 订阅 watcher 异常（目录被外部删除 / 卷被卸载）；返回取消订阅函数 */
      onDirectoryWatchError: (callback: (event: DirectoryWatchErrorEvent) => void) => () => void;
      /** 从拖放的 File 对象解析磁盘路径 */
      getFilePath: (file: File) => string;

      /** 读取用户配置（收藏 / 隐藏 / 标签 / 拍摄时间修正 / 智能相簿） */
      loadConfig: () => Promise<import('@/types').PersistedConfig>;
      /** 合并写入配置片段 */
      saveConfig: (patch: Partial<import('@/types').PersistedConfig>) => Promise<boolean>;
      /** 读取 AI 分析结果缓存 */
      loadAiCache: () => Promise<import('@/types').PersistedAiCache>;
      /** 整体写入 AI 分析结果缓存（由渲染进程维护条数上限） */
      saveAiCache: (
        entries: Record<string, import('@/types').AiCacheEntry>
      ) => Promise<boolean>;
      /** AI 图片分析（主进程代理 DeepSeek，API Key 不出主进程） */
      analyzeImage: (payload: { base64: string; mimeType: string }) => Promise<{
        result?: { description?: string; tags?: string[] } | null;
        error?: string;
      }>;
      /** 读取当前生效的 AI 配置（供「AI 设置」弹窗回显） */
      getAiConfig: () => Promise<import('@/types').AiConfigSnapshot>;
      /** 保存 AI 配置；空字符串表示清除该覆盖项、回退到环境变量 / 默认值 */
      setAiConfig: (
        patch: import('@/types').AiConfigPatch
      ) => Promise<{ success: boolean; keySource?: import('@/types').AiKeySource; error?: string }>;
      /** 用草稿值测试连接（未保存也能先验证密钥 / 地址 / 模型） */
      testAiConfig: (
        draft?: import('@/types').AiConfigPatch
      ) => Promise<{ ok: boolean; model?: string; error?: string }>;
      /** 应用菜单「AI 分析设置…」（⌘,）；返回取消订阅函数 */
      onOpenAiSettings: (callback: () => void) => () => void;

      /** 注册 ⌘O 菜单导入事件；返回取消订阅函数 */
      onImportPaths: (callback: (picked: PickedPaths) => void) => () => void;
      /** 注册内存压力广播（主进程看门狗发出）；返回取消订阅函数 */
      onMemoryPressure: (callback: (level: 'soft' | 'hard') => void) => () => void;
    };
  }
}

export {};
