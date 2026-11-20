'use strict';

/**
 * 更新检查与更新包下载（v0.6.3）。
 *
 * 为什么不用 electron-updater：macOS 上的 Squirrel.Mac 要求应用带有效代码签名，
 * 而本项目打包配置是 `identity: null`（个人自用、不签名 / 不公证）。
 * 强行接入会在安装阶段失败，且失败现场难以恢复。因此这里实现
 * 「检查 GitHub Release → 应用内下载 DMG → 打开磁盘映像引导安装」：
 * 更新过程可取消、可重来，最后一步仍由用户确认，不静默覆盖 /Applications。
 *
 * 网络只从这里发出（与 ai.cjs 并列），渲染层不直连：
 *  - GitHub API：GET /repos/{owner}/{repo}/releases/latest
 *  - 下载：只接受 API 返回且 host 在白名单内的 https 资产地址
 * 本模块的 IPC **不接收任何渲染层路径**，下载目录与文件名都由主进程决定，
 * 因此不需要 isPathAuthorized；后续不要为了「方便」加 path 参数。
 */

const fs = require('fs');
const path = require('path');

/** 更新来源：与仓库保持一致（仓库名是 times-arrow，产物名沿用 PhotoMinder） */
const GITHUB_REPO = 'iamnowhere001/times-arrow';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases`;

/** 检查接口超时：只是一个 JSON 请求，15s 已经足够宽松 */
const CHECK_TIMEOUT = 15_000;
/** release notes 只回传前 4000 字符：完整正文渲染层也用不到，白占内存 */
const MAX_NOTES_LENGTH = 4_000;

/** 允许下载更新包的 host（GitHub 会 302 到对象存储） */
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
/** 允许用系统浏览器打开的 host（发布页 / 更新说明） */
const ALLOWED_PAGE_HOSTS = new Set(['github.com']);

/** 解析 `v0.6.3` / `0.6.3` / `0.6`；非法版本返回 null（不抛错，便于比较前判空） */
function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(input.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * 比较两个版本号。
 * @returns {number|null} a 新于 b 返回 1，相等 0，旧于 -1；任一无法解析返回 null
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

/** 只接受 https + host 白名单，避免被 release 内容指向任意地址 */
function isAllowedUrl(raw, hosts) {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && hosts.has(url.hostname);
  } catch {
    return false;
  }
}

/** 从 release assets 里挑 mac arm64 的 DMG；优先精确命名，其次任意 arm64 */
function pickDmgAsset(assets, version) {
  if (!Array.isArray(assets)) return null;
  const candidates = assets.filter(
    (asset) =>
      asset &&
      typeof asset.name === 'string' &&
      /\.dmg$/i.test(asset.name) &&
      isAllowedUrl(asset.browser_download_url, ALLOWED_DOWNLOAD_HOSTS)
  );
  if (candidates.length === 0) return null;

  const expected = `PhotoMinder-${version}-arm64.dmg`.toLowerCase();
  const normalized = (version || '').replace(/^v/i, '');
  const expectedWithoutV = `PhotoMinder-${normalized}-arm64.dmg`.toLowerCase();
  const exact = candidates.find(
    (asset) =>
      asset.name.toLowerCase() === expected || asset.name.toLowerCase() === expectedWithoutV
  );
  const arm = candidates.find((asset) => /arm64|aarch64/i.test(asset.name));
  const picked = exact || arm || candidates[0];

  const size = Number.isFinite(Number(picked.size)) ? Number(picked.size) : 0;
  return {
    name: picked.name,
    size,
    url: picked.browser_download_url,
  };
}

/** 资产名只取 basename，并强制是 .dmg；带路径分隔符的名字一律拒绝 */
function sanitizeAssetName(name) {
  if (typeof name !== 'string' || !name) throw new Error('更新包文件名无效');
  const base = path.basename(name);
  if (!base || base !== name || /[\\/]/.test(name) || !/\.dmg$/i.test(base)) {
    throw new Error('更新包文件名无效');
  }
  return base;
}

function truncateNotes(body) {
  if (typeof body !== 'string') return '';
  const text = body.trim();
  return text.length > MAX_NOTES_LENGTH ? `${text.slice(0, MAX_NOTES_LENGTH)}…` : text;
}

function createUpdater({ app, shell, logger, send = () => {}, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境不支持 fetch，无法检查更新');
  }

  /** 最近一次检查结果：下载只允许针对它，避免渲染层伪造下载地址 */
  let lastCheck = null;
  /** 下载中的任务：{ version, filePath, tmpPath, controller, task } */
  let active = null;
  /** 已完成的下载：{ version, filePath } */
  let downloaded = null;
  /** 最近一次下载失败的原因（供面板重开时展示） */
  let lastError = null;
  /** 已写入字节数，用于 update-status 的快照 */
  let received = 0;
  let total = 0;

  function emit(payload) {
    try {
      send('update-download-progress', payload);
    } catch (error) {
      // 窗口已销毁时 send 会抛错；下载本身不该因此中断
      logger.warn('[updater] 进度广播失败:', error.message);
    }
  }

  async function fetchLatestRelease() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
    try {
      const response = await fetchImpl(LATEST_RELEASE_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'PhotoMinder-Updater',
        },
        signal: controller.signal,
      });

      // 仓库还没有任何 Release 是正常状态，不是错误
      if (response.status === 404) return null;
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const suffix = detail ? `：${detail.slice(0, 200)}` : '';
        throw new Error(`GitHub 返回 ${response.status}${suffix}`);
      }
      const payload = await response.json();
      if (!payload || typeof payload !== 'object') {
        throw new Error('GitHub 返回内容无法解析');
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError')
        throw new Error('检查更新超时，请稍后重试', { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 检查最新 Release。
   * @returns {Promise<object>} 三种状态：available / up-to-date / no-release
   */
  async function checkForUpdates() {
    const currentVersion = app.getVersion();
    const release = await fetchLatestRelease();

    if (!release) {
      lastCheck = { status: 'no-release', currentVersion };
      return lastCheck;
    }
    if (release.draft === true || release.prerelease === true) {
      // latest 接口通常不会返回这两类，但保留判断避免异常数据把预发布当正式版
      lastCheck = { status: 'up-to-date', currentVersion, latestVersion: release.tag_name };
      return lastCheck;
    }

    const tagName = typeof release.tag_name === 'string' ? release.tag_name : '';
    const comparison = compareVersions(tagName, currentVersion);
    if (comparison === null) {
      throw new Error(`无法识别最新版本号：${tagName || '（空）'}`);
    }

    const releaseUrl = isAllowedUrl(release.html_url, ALLOWED_PAGE_HOSTS)
      ? release.html_url
      : RELEASES_PAGE_URL;

    if (comparison <= 0) {
      lastCheck = {
        status: 'up-to-date',
        currentVersion,
        latestVersion: tagName,
        releaseUrl,
      };
      return lastCheck;
    }

    // 已经下过旧版本、随后又出现了更新版本：清掉旧状态，
    // 否则面板会一直停在「已下载」而看不到新版本的下载入口。
    if (downloaded && downloaded.version !== tagName) {
      downloaded = null;
      lastError = null;
    }

    lastCheck = {
      status: 'available',
      currentVersion,
      latestVersion: tagName,
      releaseName: typeof release.name === 'string' && release.name ? release.name : tagName,
      releaseNotes: truncateNotes(release.body),
      releaseUrl,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
      asset: pickDmgAsset(release.assets, tagName),
    };
    return lastCheck;
  }

  function getDownloadState() {
    const state = active ? 'downloading' : downloaded ? 'done' : lastError ? 'error' : 'idle';
    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    return {
      state,
      version: active?.version ?? downloaded?.version ?? lastCheck?.latestVersion ?? null,
      percent,
      received,
      total,
      filePath: downloaded?.filePath,
      error: lastError ?? undefined,
    };
  }

  function getStatus() {
    return {
      currentVersion: app.getVersion(),
      latest: lastCheck,
      download: getDownloadState(),
    };
  }

  async function writeStreamToFile(response, tmpPath, version, expectedSize) {
    const handle = await fs.promises.open(tmpPath, 'w');
    try {
      const body = response.body;
      if (!body) throw new Error('更新包下载失败：响应没有内容');

      const contentLength = Number(response.headers?.get?.('content-length'));
      total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : expectedSize;
      received = 0;
      emit({ phase: 'downloading', version, percent: 0, received: 0, total });
      // 有的 CDN 不返回 content-length：此时按 asset.size 展示，仍以写入字节数收尾校验
      total = total > 0 ? total : 0;

      const reader = body.getReader();
      try {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            // eslint-disable-next-line no-await-in-loop
            await handle.write(value);
            received += value.byteLength;
            const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0;
            emit({ phase: 'downloading', version, percent, received, total });
          }
        }
      } finally {
        reader.releaseLock?.();
      }

      if (total > 0 && received !== total) {
        throw new Error(`更新包不完整（已下载 ${received} 字节，应为 ${total} 字节）`);
      }
      return received;
    } finally {
      await handle.close();
    }
  }

  async function runDownload(entry, target) {
    const { version, filePath, tmpPath, controller } = entry;

    // 上次已经下过同版本、大小一致的包：直接复用，避免重复消耗流量
    if (target.size > 0) {
      try {
        const info = await fs.promises.stat(filePath);
        if (info.isFile() && info.size === target.size) {
          downloaded = { version, filePath };
          lastError = null;
          emit({
            phase: 'done',
            version,
            percent: 100,
            received: target.size,
            total: target.size,
            filePath,
          });
          if (active === entry) active = null;
          return { version, filePath, reused: true };
        }
      } catch {
        // 不存在就正常下载
      }
    }

    try {
      const response = await fetchImpl(target.url, {
        headers: { 'User-Agent': 'PhotoMinder-Updater' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new Error(`下载更新包失败（HTTP ${response.status}）`);
      }
      // 跟随 302 后要再校验最终地址，避免被重定向到白名单之外的站点
      if (response.url && !isAllowedUrl(response.url, ALLOWED_DOWNLOAD_HOSTS)) {
        throw new Error('更新包地址不在允许的下载来源内');
      }

      await writeStreamToFile(response, tmpPath, version, target.size);
      await fs.promises.rename(tmpPath, filePath);
      downloaded = { version, filePath };
      lastError = null;
      emit({ phase: 'done', version, percent: 100, received, total, filePath });
      logger.info(`[updater] 更新包已下载: ${filePath}`);
      return { version, filePath, reused: false };
    } catch (error) {
      // 取消与失败都不留下半截文件：否则下次会误以为「已经下过」
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // 文件没创建或已被清理
      }
      if (error.name === 'AbortError') {
        emit({ phase: 'cancelled', version, percent: 0, received, total });
        logger.info('[updater] 用户取消下载更新包');
        return null;
      }
      lastError = error.message || '下载更新包失败';
      emit({ phase: 'error', version, percent: 0, received, total, message: lastError });
      logger.warn('[updater] 下载更新包失败:', error.message);
      throw error;
    } finally {
      if (active === entry) active = null;
    }
  }

  /**
   * 开始下载。同步完成参数校验并立刻返回，真正的下载在后台进行，
   * 进度通过 update-download-progress 广播。
   */
  function startDownload() {
    if (active) throw new Error('更新包正在下载中');
    if (!lastCheck || lastCheck.status !== 'available') {
      throw new Error('没有可下载的更新，请先检查更新');
    }
    if (!lastCheck.asset) {
      throw new Error('该版本没有提供 DMG 安装包，请前往发布页下载');
    }

    lastError = null;
    received = 0;
    total = lastCheck.asset.size;
    const version = lastCheck.latestVersion;
    const fileName = sanitizeAssetName(lastCheck.asset.name);
    const filePath = path.join(app.getPath('downloads'), fileName);

    // 先登记 active 再启动任务：这样随后的取消 / 状态查询都能拿到同一个任务
    const entry = {
      version,
      filePath,
      tmpPath: `${filePath}.download`,
      controller: new AbortController(),
      task: null,
    };
    active = entry;
    entry.task = runDownload(entry, lastCheck.asset);
    // 后台任务的失败已经通过事件与日志表达，这里只需吞掉未处理的 rejection
    entry.task.catch(() => {});
    return { started: true };
  }

  /** 等待当前下载结束（测试与退出清理用）；没有下载任务时立即返回 */
  async function waitForDownload() {
    const task = active?.task;
    if (task) {
      try {
        await task;
      } catch {
        // 失败已记录，等待方只关心「结束了」
      }
    }
  }

  /** 取消下载：中止请求并等清理完成，返回是否真的取消了一个任务 */
  async function cancelDownload() {
    if (!active) return { cancelled: false };
    active.controller.abort();
    await waitForDownload();
    return { cancelled: true };
  }

  async function openDownloaded() {
    if (!downloaded) throw new Error('尚未下载更新包');
    await fs.promises.access(downloaded.filePath);
    // shell.openPath 返回空串表示成功，非空是系统给出的错误描述
    const message = await shell.openPath(downloaded.filePath);
    if (message) throw new Error(`无法打开更新包：${message}`);
    return { opened: true };
  }

  function revealDownloaded() {
    if (!downloaded) throw new Error('尚未下载更新包');
    shell.showItemInFolder(downloaded.filePath);
    return true;
  }

  async function openReleasePage() {
    const url =
      lastCheck && isAllowedUrl(lastCheck.releaseUrl, ALLOWED_PAGE_HOSTS)
        ? lastCheck.releaseUrl
        : RELEASES_PAGE_URL;
    await shell.openExternal(url);
    return true;
  }

  /** 应用退出前调用：中止未完成的下载，避免留下 .download 残留 */
  async function dispose() {
    if (active) {
      active.controller.abort();
      await waitForDownload();
    }
  }

  function registerUpdaterIpc({ handle, ok }) {
    handle('update-check', async () => ok(await checkForUpdates()));
    handle('update-status', async () => ok(getStatus()));
    handle('update-download', async () => ok(startDownload()));
    handle('update-cancel-download', async () => ok(await cancelDownload()));
    handle('update-open-download', async () => ok(await openDownloaded()));
    handle('update-reveal-download', async () => ok(revealDownloaded()));
    handle('update-open-release', async () => ok(await openReleasePage()));
  }

  return {
    registerUpdaterIpc,
    checkForUpdates,
    startDownload,
    cancelDownload,
    waitForDownload,
    getStatus,
    getDownloadState,
    openDownloaded,
    revealDownloaded,
    openReleasePage,
    dispose,
  };
}

module.exports = {
  createUpdater,
  compareVersions,
  parseVersion,
  pickDmgAsset,
  sanitizeAssetName,
};
