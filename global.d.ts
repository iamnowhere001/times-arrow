declare global {
  interface Window {
    electronAPI: {
      selectDirectory: () => Promise<string[] | null>;
      selectFiles: () => Promise<string[] | null>;
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

      /** 递归扫描目录，返回图片文件清单（name/path/size/mtime/created）；scanId 用于取消 */
      scanDirectory: (dirPath: string, scanId?: string) => Promise<
        Array<{ name: string; path: string; size: number; mtime: number; created?: number }>
      >;
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
        exif?: import('./types').ExifData;
        error?: string;
      }>;
      /** 批量计算感知哈希（主进程执行，返回与入参等长的数组） */
      getImageHashes: (filePaths: string[]) => Promise<Array<string | null>>;
      /** 批量获取文件 size/mtime/created */
      statFiles: (filePaths: string[]) => Promise<
        Array<{ path: string; name: string; size: number; mtime: number; created?: number }>
      >;
      /** 从拖放的 File 对象解析磁盘路径 */
      getFilePath: (file: File) => string;

      /** 读取用户配置（收藏 / 隐藏 / 标签 / 拍摄时间修正 / 智能相簿） */
      loadConfig: () => Promise<import('./types').PersistedConfig>;
      /** 合并写入配置片段 */
      saveConfig: (patch: Partial<import('./types').PersistedConfig>) => Promise<boolean>;
      /** 读取 AI 分析结果缓存 */
      loadAiCache: () => Promise<import('./types').PersistedAiCache>;
      /** 整体写入 AI 分析结果缓存（由渲染进程维护条数上限） */
      saveAiCache: (
        entries: Record<string, import('./types').AiCacheEntry>
      ) => Promise<boolean>;

      /** 注册目录选择事件；返回取消订阅函数 */
      onDirectorySelected: (callback: (path: string) => void) => () => void;
      /** 注册内存压力广播（主进程看门狗发出）；返回取消订阅函数 */
      onMemoryPressure: (callback: (level: 'soft' | 'hard') => void) => () => void;
    };
  }
}

export {};
