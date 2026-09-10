const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 向渲染进程暴露安全的API
contextBridge.exposeInMainWorld('electronAPI', {
  // 目录选择
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  // 文件选择
  selectFiles: () => ipcRenderer.invoke('select-files'),

  // 文件系统操作
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
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

  // 用户配置（收藏 / 隐藏 / 标签 / 拍摄时间修正 / 智能相簿）
  loadConfig: () => ipcRenderer.invoke('load-config'),
  /** 合并写入配置片段 */
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  /** AI 分析结果缓存（单独文件，便于限量与清理） */
  loadAiCache: () => ipcRenderer.invoke('load-ai-cache'),
  saveAiCache: (entries) => ipcRenderer.invoke('save-ai-cache', entries),

  // 从拖放的 File 对象解析真实磁盘路径
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (error) {
      return '';
    }
  },

  // 事件监听
  onDirectorySelected: (callback) => {
    const listener = (event, dirPath) => callback(dirPath);
    ipcRenderer.on('directory-selected', listener);
    return () => ipcRenderer.removeListener('directory-selected', listener);
  },
  /** 主进程内存吃紧时广播：'soft' = 常规回收，'hard' = 清空易失缓存；返回取消订阅 */
  onMemoryPressure: (callback) => {
    const listener = (event, level) => callback(level === 'hard' ? 'hard' : 'soft');
    ipcRenderer.on('memory-pressure', listener);
    return () => ipcRenderer.removeListener('memory-pressure', listener);
  },
});

// TypeScript类型定义应该放在单独的.d.ts文件中
