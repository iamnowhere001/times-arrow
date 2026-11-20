/**
 * 文件落盘工具：不覆盖、原子占位、跨卷移动。
 *
 * 这些函数是本项目「不丢数据」承诺最底层的实现，因此集中在一处：
 * 重命名、移动、导出三条写盘链路必须用**同一套**同名探测与占位语义，
 * 各写一份迟早会在某条链路上退化成「先 exists 再写」的 TOCTOU。
 *
 * 全部只依赖 `fs` / `path` 与日志器，不感知 IPC —— 调用方负责授权与返回协议。
 */
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger.cjs');

/** 同名文件的重试上限：超过这个数量说明不是正常场景（多半是逻辑出错），直接报错而不是空转 */
const UNIQUE_NAME_MAX_ATTEMPTS = 100;

/**
 * 生成候选文件名序列：原名 → base-1.ext → base-2.ext …
 * 预览（probe）与落盘（reserve）必须用同一序列，否则「预览名 ≠ 落盘名」。
 */
function uniqueNameCandidates(fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  return Array.from({ length: UNIQUE_NAME_MAX_ATTEMPTS }, (_, attempt) =>
    attempt === 0 ? fileName : `${base}-${attempt}${ext}`
  );
}

/**
 * 原子地占用一个不冲突的目标路径，同名时依次追加 -1、-2 …
 * 用于「重命名」「移动」与「导出写盘」，绝不静默覆盖用户已有文件。
 *
 * 为什么不能用「existsSync 探测 + 再写」：那是典型的 TOCTOU ——
 * 探测与真正落盘之间存在窗口，并发的两次导出（或另一个进程）可能探测到同一个空闲名字，
 * 后落盘的一方就静默覆盖了先落盘的一方。照片导出最不能接受的就是静默丢数据。
 *
 * 这里改用 `open(candidate, 'wx')`：'wx' 的语义是「独占创建，已存在则失败」，
 * 由内核保证原子性。成功即代表这个名字归本次调用所有；EEXIST 说明被别人抢先，
 * 递增序号重试即可。其余错误（EACCES / ENOENT / EROFS）重试没有意义，直接抛出。
 *
 * 返回占用成功的完整路径。占位用的文件句柄在这里立即关闭 —— 名字一旦被内核判给
 * 本次调用，就不会再被别的进程抢走，后续用普通写入打开它是安全的。
 * 调用方**必须**负责：若最终决定不使用这个路径，调用 `discardReservedPath()` 清掉占位
 * 文件，否则会在用户目录里留下一个空文件。
 */
async function reserveUniquePath(dir, fileName) {
  for (const candidateName of uniqueNameCandidates(fileName)) {
    const candidate = path.join(dir, candidateName);
    let handle;
    try {
      // eslint-disable-next-line no-await-in-loop
      handle = await fs.promises.open(candidate, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    // eslint-disable-next-line no-await-in-loop
    await handle.close();
    return candidate;
  }
  throw new Error(`同名文件过多，无法生成不冲突的文件名（已尝试 ${UNIQUE_NAME_MAX_ATTEMPTS} 次）`);
}

/** 丢弃一个已占位但最终没有使用的路径。best-effort：清理失败只记日志，不掩盖主流程的错误 */
async function discardReservedPath(reservedPath) {
  try {
    await fs.promises.unlink(reservedPath);
  } catch (error) {
    logger.warn(`Failed to clean up reserved placeholder ${reservedPath}:`, error.message);
  }
}

/**
 * 两个路径是否指向同一个文件（比较 inode）。
 * 用于区分「仅修改大小写」的重命名与真正的同名冲突
 * （macOS 默认大小写不敏感，仅比较字符串会误判为冲突）。
 */
function isSameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * 两个路径是否指向同一个目录（比较 inode）。
 * 用于「移动到文件夹」时识别源文件已在目标目录中（stat 跟随符号链接，
 * /var 与 /private/var 这类差异也能正确判同）。
 */
function isSameDirectory(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.isDirectory() && sb.isDirectory() && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * 跨磁盘 / 跨卷移动：rename 抛 EXDEV 时退化为「复制成功后再删源文件」。
 *
 * 目标路径已由 reserveUniquePath 原子占位，因此这里用**普通** copyFile 覆写自己的
 * 占位文件即可 —— 不需要 COPYFILE_EXCL（那会因为占位文件已存在而必然失败），
 * 也不会与并发的另一次移动互相覆盖（名字已被我们独占）。
 *
 * K2：源文件删除失败（如只读卷）不再整体抛错——副本已落盘，返回 partial 中间态，
 * 由渲染层提示并可通过 priorTargets 幂等重试，绝不重复复制。
 */
async function moveAcrossDevices(srcPath, destPath) {
  await fs.promises.copyFile(srcPath, destPath);
  try {
    await fs.promises.unlink(srcPath);
  } catch (error) {
    return { to: destPath, partial: true, error: error.message };
  }
  return { to: destPath, partial: false };
}

/**
 * K2：补删跨卷移动残留的源文件（重试入口）。
 * 副本存在且与源体积一致才删源；任一 stat 失败或体积不一致返回 null（无法安全续删，
 * 走正常移动流程）；源已不存在视为移动已完成。
 */
async function resumePartialMove(srcPath, copiedPath) {
  let srcStat;
  let copiedStat;
  try {
    [srcStat, copiedStat] = await Promise.all([
      fs.promises.stat(srcPath),
      fs.promises.stat(copiedPath),
    ]);
  } catch {
    return null;
  }
  if (srcStat.size !== copiedStat.size) return null;
  try {
    await fs.promises.unlink(srcPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  UNIQUE_NAME_MAX_ATTEMPTS,
  uniqueNameCandidates,
  reserveUniquePath,
  discardReservedPath,
  isSameFile,
  isSameDirectory,
  moveAcrossDevices,
  resumePartialMove,
};
