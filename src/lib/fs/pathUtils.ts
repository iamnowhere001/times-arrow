/**
 * 文件路径与文件名的基础工具（从 App 抽出的纯函数）。
 *
 * 与 `utils.ts` 中的 `folderOfPath` 互补：这里负责「拼接」与「清洗」，
 * 供单张重命名与批量重命名共用。
 */

/**
 * 安全地拼接目录与文件名，兼容 Unix / Windows 两种分隔符。
 * 会先去掉目录结尾多余的分隔符，避免出现 `//` 或 `\\`。
 */
export const joinPath = (dirPath: string, filename: string): string => {
  // Check if path uses backslashes (Windows)
  if (dirPath.includes('\\')) {
    // Remove any trailing backslashes
    dirPath = dirPath.replace(/\\+$/, '');
    return `${dirPath}\\${filename}`;
  } else {
    // Remove any trailing slashes
    dirPath = dirPath.replace(/\/+$/, '');
    return `${dirPath}/${filename}`;
  }
};

/**
 * 清洗文件名，去掉非法字符。
 * Windows 非法字符：< > : " | ? *；Unix 非法字符：/（统一替换为 -）。
 */
export const sanitizeFilename = (filename: string): string => {
  // Remove or replace invalid characters for filenames
  // Invalid characters on Windows: < > : " / \ | ? *
  // Invalid characters on Unix: /
  return filename
    .replace(/[<>:"|?*]/g, '') // Remove invalid Windows characters
    .replace(/\//g, '-'); // Replace slashes with dashes
};
