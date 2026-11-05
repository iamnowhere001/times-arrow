'use strict';

/**
 * 「数据资产」专项的主进程 IPC 集合。
 *
 * 这一组能力的共同点：都围绕「用户的标注与文件不该因为路径变化而丢失」。
 * 保持在一个模块里，是为了让新增的「接收渲染层路径」入口集中接受路径白名单校验 ——
 * 这是本项目的安全约定，散到多个文件里最容易漏。
 */

const { computeFileFingerprints } = require('../lib/fingerprint.cjs');

function createDataAssets({ handle, ok, fail, isPathAuthorized }) {
  /**
   * 批量算内容指纹。导入 / 恢复 / 拖放 / 目录监听补进来的文件都走这里，
   * 渲染层拿到的 Photo 以 fileId 作为跨重启的身份。
   * 未授权路径直接跳过（不整批失败），与其余文件类 IPC 的授权语义一致。
   */
  handle('compute-file-ids', async (event, paths) => {
    if (!Array.isArray(paths)) return fail('无效的路径列表');
    const allowed = paths.filter(
      (p) => typeof p === 'string' && p && isPathAuthorized(p)
    );
    if (allowed.length === 0) return ok({});
    return ok(await computeFileFingerprints(allowed, 8));
  });
}

module.exports = { createDataAssets };
