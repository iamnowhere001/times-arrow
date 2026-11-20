/**
 * v0.6.3：更新检查与更新包下载。
 *
 * 这里的重点是「不联网也要能验证」：所有请求都由注入的 fetchImpl 打桩，
 * 但仍走真实的 updater 代码路径（版本比较 / 资产筛选 / 写盘 / 取消 / 校验）。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const {
  createUpdater,
  compareVersions,
  sanitizeAssetName,
} = require('../../electron/main/updater.cjs');
const { createChecker, tempDir } = require('./harness.cjs');

const { check, section, summary } = createChecker();

const RELEASE_URL = 'https://github.com/iamnowhere001/times-arrow/releases/tag/v0.6.3';
const ASSET_URL =
  'https://github.com/iamnowhere001/times-arrow/releases/download/v0.6.3/PhotoMinder-0.6.3-arm64.dmg';
const ASSET_BYTES = Buffer.from('dmg-bytes');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRelease(overrides = {}) {
  return {
    tag_name: 'v0.6.3',
    name: 'v0.6.3',
    body: '更新说明：修复了一些问题。',
    html_url: RELEASE_URL,
    published_at: '2026-11-20T00:00:00Z',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'PhotoMinder-0.6.3-arm64.dmg',
        size: ASSET_BYTES.length,
        browser_download_url: ASSET_URL,
      },
    ],
    ...overrides,
  };
}

function makeHarness({ fetchImpl, version = '0.6.2' }) {
  const downloads = tempDir('pm-updates-');
  const events = [];
  const opened = [];
  const updater = createUpdater({
    app: {
      getVersion: () => version,
      getPath: () => downloads,
    },
    shell: {
      openPath: async (p) => {
        opened.push(p);
        return '';
      },
      showItemInFolder: (p) => {
        opened.push(p);
      },
      openExternal: async (url) => {
        opened.push(url);
      },
    },
    logger: { info() {}, warn() {} },
    send: (channel, payload) => events.push({ channel, payload }),
    fetchImpl,
  });
  return { updater, downloads, events, opened };
}

async function main() {
  section('1. 版本比较');
  check('v 前缀与补零', compareVersions('v0.6.3', '0.6.3') === 0);
  check('更高版本返回 1', compareVersions('v0.6.3', '0.6.2') === 1);
  check('更低版本返回 -1', compareVersions('0.6.2', 'v0.6.3') === -1);
  check('位数不同按数字比较', compareVersions('0.10.0', '0.9.9') === 1);
  check('非法版本返回 null', compareVersions('latest', '0.6.2') === null);

  section('2. 发现新版本并筛选 arm64 DMG');
  {
    const { updater } = makeHarness({
      fetchImpl: async () => jsonResponse(makeRelease()),
    });
    const result = await updater.checkForUpdates();
    check('状态为 available', result.status === 'available', JSON.stringify(result));
    check('当前版本来自 app.getVersion', result.currentVersion === '0.6.2');
    check('最新版本为 tag', result.latestVersion === 'v0.6.3');
    check('选中 arm64 资产', result.asset?.name === 'PhotoMinder-0.6.3-arm64.dmg');
    check('更新说明被回传', result.releaseNotes.includes('修复'));
    check('发布页 URL 已校验', result.releaseUrl === RELEASE_URL);
  }

  section('3. 已是最新 / 仓库无 Release');
  {
    const { updater } = makeHarness({
      fetchImpl: async () => jsonResponse(makeRelease({ tag_name: 'v0.6.2' })),
    });
    const result = await updater.checkForUpdates();
    check('同版本为 up-to-date', result.status === 'up-to-date', JSON.stringify(result));
  }
  {
    const { updater } = makeHarness({
      fetchImpl: async () => jsonResponse({ message: 'Not Found' }, 404),
    });
    const result = await updater.checkForUpdates();
    check('404 视为 no-release', result.status === 'no-release', JSON.stringify(result));
  }

  section('4. 资产地址白名单');
  {
    const { updater } = makeHarness({
      fetchImpl: async () =>
        jsonResponse(
          makeRelease({
            assets: [
              {
                name: 'PhotoMinder-0.6.3-arm64.dmg',
                size: 9,
                browser_download_url: 'http://evil.example.com/x.dmg',
              },
            ],
          })
        ),
    });
    const result = await updater.checkForUpdates();
    check('非 https / 非白名单资产被忽略', result.asset === null, JSON.stringify(result.asset));
  }
  check(
    '文件名拒绝路径分隔符',
    (() => {
      try {
        sanitizeAssetName('../evil.dmg');
        return false;
      } catch {
        return true;
      }
    })()
  );
  check(
    '正常文件名可通过',
    sanitizeAssetName('PhotoMinder-0.6.3-arm64.dmg') === 'PhotoMinder-0.6.3-arm64.dmg'
  );
  check(
    '文件名拒绝反斜杠',
    (() => {
      try {
        sanitizeAssetName('evil\\name.dmg');
        return false;
      } catch {
        return true;
      }
    })()
  );

  section('5. 下载 / 进度 / 复用');
  {
    let assetFetches = 0;
    let latestTag = 'v0.6.3';
    const { updater, downloads, events, opened } = makeHarness({
      fetchImpl: async (url) => {
        if (url === ASSET_URL) {
          assetFetches += 1;
          return new Response(ASSET_BYTES, {
            status: 200,
            headers: { 'content-length': String(ASSET_BYTES.length) },
          });
        }
        return jsonResponse(makeRelease({ tag_name: latestTag }));
      },
    });

    await updater.checkForUpdates();
    updater.startDownload();
    await updater.waitForDownload();

    const filePath = path.join(downloads, 'PhotoMinder-0.6.3-arm64.dmg');
    check('文件已落盘', fs.existsSync(filePath));
    check('内容正确', fs.readFileSync(filePath).equals(ASSET_BYTES));
    check('没有残留 .download', !fs.existsSync(`${filePath}.download`));
    check(
      '收到 done 进度',
      events.some((e) => e.payload.phase === 'done' && e.payload.percent === 100),
      JSON.stringify(events.map((e) => e.payload.phase))
    );
    check('状态变为 done', updater.getDownloadState().state === 'done');

    await updater.openDownloaded();
    check('打开的是内部记录的路径', opened[0] === filePath);

    updater.startDownload();
    await updater.waitForDownload();
    check('同大小已存在时复用，不重复下载', assetFetches === 1, String(assetFetches));

    latestTag = 'v0.6.4';
    await updater.checkForUpdates();
    check('出现更新版本时清空旧下载状态', updater.getDownloadState().state === 'idle');
  }

  section('6. 取消下载会清理半截文件');
  {
    const controllerRef = { signal: null };
    const { updater, downloads, events } = makeHarness({
      fetchImpl: async (url, options) => {
        if (url === ASSET_URL) {
          controllerRef.signal = options.signal;
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                controller.error(error);
              });
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-length': '100' },
          });
        }
        return jsonResponse(makeRelease());
      },
    });

    await updater.checkForUpdates();
    updater.startDownload();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await updater.cancelDownload();
    await updater.waitForDownload();

    const filePath = path.join(downloads, 'PhotoMinder-0.6.3-arm64.dmg');
    check('取消返回 true', cancelled.cancelled === true, JSON.stringify(cancelled));
    check('取消信号已发出', controllerRef.signal?.aborted === true);
    check('没有最终文件', !fs.existsSync(filePath));
    check('没有临时文件', !fs.existsSync(`${filePath}.download`));
    check(
      '收到 cancelled 事件',
      events.some((e) => e.payload.phase === 'cancelled'),
      JSON.stringify(events.map((e) => e.payload.phase))
    );
  }

  section('7. 大小校验与打开守卫');
  {
    const { updater, downloads, events } = makeHarness({
      fetchImpl: async (url) => {
        if (url === ASSET_URL) {
          return new Response(Buffer.from('abc'), {
            status: 200,
            headers: { 'content-length': '100' },
          });
        }
        return jsonResponse(makeRelease());
      },
    });
    await updater.checkForUpdates();
    updater.startDownload();
    await updater.waitForDownload();

    const filePath = path.join(downloads, 'PhotoMinder-0.6.3-arm64.dmg');
    check('大小不符不落盘', !fs.existsSync(filePath));
    check('临时文件已删除', !fs.existsSync(`${filePath}.download`));
    check(
      '收到 error 事件',
      events.some((e) => e.payload.phase === 'error' && e.payload.message.includes('不完整')),
      JSON.stringify(events.map((e) => e.payload.phase))
    );
  }
  {
    const { updater } = makeHarness({
      fetchImpl: async () => jsonResponse(makeRelease()),
    });
    let rejected = false;
    try {
      await updater.openDownloaded();
    } catch {
      rejected = true;
    }
    check('未下载时打开会被拒绝', rejected);
  }

  section('8. 打开发布页只允许 GitHub');
  {
    const { updater, opened } = makeHarness({
      fetchImpl: async () => jsonResponse(makeRelease()),
    });
    await updater.checkForUpdates();
    await updater.openReleasePage();
    check('打开的是 release 页面', opened.includes(RELEASE_URL), JSON.stringify(opened));
  }

  process.exitCode = summary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
