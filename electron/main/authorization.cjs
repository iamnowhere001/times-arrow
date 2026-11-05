'use strict';

const fs = require('fs');
const path = require('path');

function createAuthorization() {
  // ---------------------------------------------------------------------------
  // 会话级路径授权（安全边界）
  // ---------------------------------------------------------------------------
  // 渲染进程能访问的磁盘路径必须来自「用户主动选择」：系统对话框里选中的文件 / 文件夹、
  // 拖放进窗口的文件，或应用自己持久化后在启动时恢复的来源。其余一律拒绝。
  //
  // 为什么需要这一层：
  //   1. pm:// 注册为 standard + secure + corsEnabled + bypassCSP 的特权协议，
  //      原图 / 原视频都经由 pm://file/<base64url> 流式返回。若不设白名单，
  //      任意一段 base64 就是「读取本机任意文件」的完整原语 ——
  //      一旦渲染层出现内容级注入（被当作图片加载的 SVG、将来引入的远程内容等），
  //      <img src="pm://local/file/…"> 就能把文件读进页面。
  //   2. 文件类 IPC（read / write / delete / rename / move / open）同理：
  //      它们直接作用于磁盘，不应接受渲染层任意指定的路径。
  //
  // 边界说明：这层防的是「内容级攻击」（无法调用 IPC 的注入内容），
  // 而不是「渲染进程被完全攻破」——后者天然拥有全部 IPC 能力，无法在 IPC 层拦住。
  const authorizedRoots = new Set();
  const authorizedFiles = new Set();

  /**
   * 取规范路径：优先解析符号链接（realpath）。
   *
   * 为什么不能「realpath 失败就简单退回 path.resolve」：
   * 目标可能**尚不存在** —— 「重命名到新名字」「导出为新文件」的目标路径本来就不在磁盘上，
   * realpath 必然抛 ENOENT。此时若退化成 path.resolve，拿到的是**未解析符号链接**的形式，
   * 而授权根目录里存的是解析后的形式，两者一比就永远不相等。
   * 在 macOS 上这不是边缘情况：/var 与 /tmp 都是指向 /private/var、/private/tmp 的符号链接，
   * 于是「临时目录下的合法目标」会被整体判为未授权，重命名与导出直接失败。
   *
   * 正确做法：向上找到**最深的已存在祖先**做 realpath，再把剩余的不存在部分原样拼回去。
   * 这样 `…/lib/new-name.jpg` 与授权根 `…/lib` 落在同一套规范形式上，比较才有意义。
   */
  function canonicalize(target) {
    if (typeof target !== 'string' || !target) return '';
    let resolved;
    try {
      resolved = path.resolve(target);
    } catch {
      return '';
    }

    try {
      return fs.realpathSync.native(resolved);
    } catch {
      // 目标不存在：继续向上找已存在的祖先
    }

    const tail = [path.basename(resolved)];
    let ancestor = path.dirname(resolved);
    // 到根目录为止（path.dirname('/') === '/'）
    while (ancestor !== path.dirname(ancestor)) {
      try {
        return path.join(fs.realpathSync.native(ancestor), ...tail);
      } catch {
        tail.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    // 连根都解析不了（极罕见）：退回 resolve 的结果，至少保持绝对路径语义
    return resolved;
  }

  /** 比较用路径：Windows 文件系统大小写不敏感，统一小写 */
  function comparable(target) {
    const canonical = canonicalize(target);
    if (!canonical) return '';
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }

  function authorizeRoot(dirPath) {
    const key = comparable(dirPath);
    if (key) authorizedRoots.add(key);
  }

  function authorizeFile(filePath) {
    const key = comparable(filePath);
    if (key) authorizedFiles.add(key);
  }

  /**
   * 批量授权：目录进 roots（其下所有内容随之可访问），文件进 files。
   * 路径当前不存在时按「有无扩展名」猜测形态 —— 恢复来源时目标目录可能临时不可用
   * （外接卷未挂载），此时仍要授权，否则卷挂载后整库都读不到。
   */
  function authorizePaths(paths) {
    if (!Array.isArray(paths)) return;
    for (const target of paths) {
      if (typeof target !== 'string' || !target) continue;
      let isDir;
      try {
        isDir = fs.statSync(target).isDirectory();
      } catch {
        isDir = !path.extname(target);
      }
      if (isDir) authorizeRoot(target);
      else authorizeFile(target);
    }
  }

  /** 目标路径是否落在某个已授权根目录之下（或本身就是已授权的单个文件） */
  function isPathAuthorized(targetPath) {
    const target = comparable(targetPath);
    if (!target) return false;
    if (authorizedFiles.has(target)) return true;
    for (const root of authorizedRoots) {
      if (target === root) return true;
      const rel = path.relative(root, target);
      // rel 为空 = 同一路径（上面已判）；以 .. 开头或为绝对路径 = 在根目录之外。
      // 用 path.relative 而非字符串前缀比较，避免 /a/bc 被误判为在 /a/b 之下。
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
    return false;
  }

  /** 统一的拒绝文案：不区分「不存在」与「未授权」，避免变成路径探测接口 */
  const UNAUTHORIZED_ERROR = '未授权的路径（该路径不在本次会话已打开的图库范围内）';

  return {
    UNAUTHORIZED_ERROR,
    authorizeRoot,
    authorizeFile,
    authorizePaths,
    isPathAuthorized,
  };
}

module.exports = { createAuthorization };
