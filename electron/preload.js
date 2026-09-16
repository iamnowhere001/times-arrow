const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 向渲染进程暴露安全的API
//
// 返回协议：所有 invoke 类接口都返回 IpcResult<T>（见 src/types/global.d.ts）：
//   成功 → { ok: true,  data: T }
//   失败 → { ok: false, error: string, code?: string }
// 主进程侧由 wrapHandler 统一兜底（异常也会被转成 ok:false），因此这里不需要 try/catch，
// 也不需要为每个接口单独约定返回形状。
//
// 事件订阅类接口（onXxx）返回取消订阅函数，不属于 invoke 协议。
contextBridge.exposeInMainWorld('electronAPI', {
  // 统一导入：同一对话框可多选图片 / 视频文件与文件夹（可混合）
  selectPaths: () => ipcRenderer.invoke('select-paths'),
  /** 导出等场景：选择单个目标目录；allowCreate 时面板内可新建文件夹 */
  chooseDirectory: (options) => ipcRenderer.invoke('choose-directory', options),

  // 文件系统操作
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  /** 批量移动文件到目标文件夹（重名自动加序号、同目录跳过、跨盘复制兜底） */
  moveFiles: (filePaths, targetDir) => ipcRenderer.invoke('move-files', filePaths, targetDir),
  /** 读取文件为 base64（HEIC 自动转为 JPEG） */
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  /** 在访达 / 资源管理器中定位文件 */
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  /** 复制图片到系统剪贴板 */
  copyImage: (filePath) => ipcRenderer.invoke('copy-image', filePath),
  /** 复制纯文本（如文件路径）到系统剪贴板 */
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  /** 用系统默认应用 / 外部编辑器打开文件 */
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  /** 写入 base64 二进制文件，同名冲突自动追加序号，返回最终路径 */
  writeFileUnique: (targetDir, fileName, base64) =>
    ipcRenderer.invoke('write-file-unique', targetDir, fileName, base64),

  // 高性能图片管线：缩略图走磁盘缓存 + pm:// 协议，元数据一次读取
  scanDirectory: (dirPath, scanId) => ipcRenderer.invoke('scan-directory', dirPath, scanId),
  /** 取消进行中的目录扫描 */
  cancelScan: (scanId) => ipcRenderer.invoke('cancel-scan', scanId),
  getThumbnail: (filePath, maxSize) => ipcRenderer.invoke('get-thumbnail', filePath, maxSize),
  /** 回写渲染进程抓取的视频首帧，返回 pm:// 地址 */
  cacheThumbnail: (filePath, maxSize, base64) =>
    ipcRenderer.invoke('cache-thumbnail', filePath, maxSize, base64),
  getMetadata: (filePath) => ipcRenderer.invoke('get-metadata', filePath),
  /** 批量计算感知哈希，避免渲染进程用 canvas 解码阻塞 UI */
  getImageHashes: (filePaths) => ipcRenderer.invoke('get-image-hashes', filePaths),
  statFiles: (filePaths) => ipcRenderer.invoke('stat-files', filePaths),
  /** 批量检查路径是否存在（启动时标注「不可用来源」） */
  checkPaths: (paths) => ipcRenderer.invoke('check-paths', paths),
  /**
   * 登记「拖放进窗口」的路径为本次会话可访问。
   * 拖放不经过系统对话框，是除对话框之外的另一个用户主动选择入口；
   * 未登记的路径会被主进程的文件类 IPC 与 pm:// 协议拒绝。
   */
  authorizePaths: (paths) => ipcRenderer.invoke('authorize-paths', paths),

  // 目录监听（N5）：感知当前目录的外部增删，主进程聚合后回推事件
  /** 监听目录（递归）；切换目录时自动替换旧 watcher */
  watchDirectory: (dirPath) => ipcRenderer.invoke('watch-directory', dirPath),
  /** 停止监听并清空聚合状态 */
  unwatchDirectory: () => ipcRenderer.invoke('unwatch-directory'),
  /** 外部变动事件（已按扩展名过滤 + 防抖聚合）；返回取消订阅函数 */
  onDirectoryChanged: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('directory-changed', listener);
    return () => ipcRenderer.removeListener('directory-changed', listener);
  },
  /** watcher 异常（目录被外部删除 / 卷被卸载）；返回取消订阅函数 */
  onDirectoryWatchError: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('directory-watch-error', listener);
    return () => ipcRenderer.removeListener('directory-watch-error', listener);
  },

  // 用户配置（收藏 / 隐藏 / 标签 / 拍摄时间修正 / 智能相簿）
  loadConfig: () => ipcRenderer.invoke('load-config'),
  /** 合并写入配置片段 */
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  /** AI 分析结果缓存（单独文件，便于限量与清理） */
  loadAiCache: () => ipcRenderer.invoke('load-ai-cache'),
  saveAiCache: (entries) => ipcRenderer.invoke('save-ai-cache', entries),
  /**
   * 取走「存储损坏并已备份」的通知（取走即清空）。
   * 启动加载完配置后调用一次；非空时应当提示用户，否则他会以为数据凭空消失。
   */
  storageNotices: () => ipcRenderer.invoke('storage-notices'),

  /** AI 图片分析：主进程代理 DeepSeek，密钥不出主进程 */
  analyzeImage: (payload) => ipcRenderer.invoke('ai-analyze', payload),
  /** AI 配置（API Key / Base URL / 模型）：应用内「AI 设置」读写 */
  getAiConfig: () => ipcRenderer.invoke('ai-config-get'),
  setAiConfig: (patch) => ipcRenderer.invoke('ai-config-set', patch),
  /** 用草稿值测试连接（未保存也能先验证） */
  testAiConfig: (draft) => ipcRenderer.invoke('ai-config-test', draft),
  /** 应用菜单「AI 分析设置…」（⌘,）；返回取消订阅函数 */
  onOpenAiSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('ai-open-settings', listener);
    return () => ipcRenderer.removeListener('ai-open-settings', listener);
  },

  // 从拖放的 File 对象解析真实磁盘路径
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // 拿不到路径（非 Electron 的 File 对象等）时返回空串，
      // 由调用方走「无磁盘路径」的降级分支，不在这里抛错打断拖放
      return '';
    }
  },

  // 事件监听
  /** ⌘O 应用菜单「导入」：主进程完成选择后回传分类好的路径 */
  onImportPaths: (callback) => {
    const listener = (event, picked) => callback(picked);
    ipcRenderer.on('import-paths', listener);
    return () => ipcRenderer.removeListener('import-paths', listener);
  },
  /** 主进程内存吃紧时广播：'soft' = 常规回收，'hard' = 清空易失缓存；返回取消订阅 */
  onMemoryPressure: (callback) => {
    const listener = (event, level) => callback(level === 'hard' ? 'hard' : 'soft');
    ipcRenderer.on('memory-pressure', listener);
    return () => ipcRenderer.removeListener('memory-pressure', listener);
  },
});

// TypeScript类型定义应该放在单独的.d.ts文件中
