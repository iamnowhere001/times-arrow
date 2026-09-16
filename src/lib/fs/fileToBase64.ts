/**
 * 浏览器 `File` 对象 → base64（不含 data URL 前缀）。
 *
 * 只在**拖放降级路径**上用得到：拖放进来的文件若拿不到磁盘路径
 * （非 Electron 环境、受限来源），就只能以内存里的 File 对象继续处理。
 * 有磁盘路径时一律走主进程 `read-file`，那条路能复用 HEIC 转码缓存与体积闸门。
 */

/**
 * 读取为 base64 字符串（**不含** `data:image/jpeg;base64,` 前缀）。
 *
 * 走 `FileReader.readAsDataURL` 再切掉前缀，而不是 `readAsArrayBuffer` + 手工编码 ——
 * 前者由浏览器在原生侧完成编码，大文件时明显更快。
 */
export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data url prefix (e.g. "data:image/jpeg;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = error => reject(error);
  });
};
