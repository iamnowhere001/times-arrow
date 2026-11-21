/**
 * v0.6.6：人脸模型的下载策略与错误文案（不联网）。
 *
 * 真实下载在开发期用 Electron 脚本跑过；这里只守两件容易回归的事：
 *   1. 下载线路必须是「镜像 → 官方」，否则国内网络下首次下载会直接失败；
 *   2. 底层网络错误必须被翻译成用户能理解的中文，不能把 ECONNREFUSED 原样抛到界面。
 *
 * 运行：npm run test:main -- face-model
 */
const fs = require('fs');
const path = require('path');
const storeModule = require('../../electron/main/face/model-store.cjs');
const { createChecker, tempDir } = require('./harness.cjs');

const { check, section, summary } = createChecker();
const { describeDownloadError } = storeModule.__test;

section('下载线路');
{
  check('第一条线路是加速镜像', storeModule.DOWNLOAD_URLS[0].startsWith('https://ghproxy.net/'));
  check('官方地址在回落列表里', storeModule.DOWNLOAD_URLS.includes(storeModule.MODEL_URL));
  check(
    '镜像只是给官方地址加前缀',
    storeModule.MIRROR_PREFIXES.every((prefix) =>
      storeModule.DOWNLOAD_URLS.includes(prefix + storeModule.MODEL_URL)
    )
  );
  check(
    '线路数 = 镜像数 + 1',
    storeModule.DOWNLOAD_URLS.length === storeModule.MIRROR_PREFIXES.length + 1
  );
}

section('错误文案');
{
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
    code: 'ECONNREFUSED',
  });
  check(
    'ECONNREFUSED 翻译为可行动的中文',
    describeDownloadError(refused) === '模型下载失败：无法连接下载服务器，请检查网络后重试'
  );
  check(
    '超时同样翻译',
    describeDownloadError(new Error('模型下载超时，请检查网络后重试')).includes('无法连接')
  );
  check(
    '已带前缀不重复拼接',
    describeDownloadError(new Error('模型下载失败：模型包校验失败')) ===
      '模型下载失败：模型包校验失败'
  );
  check(
    '其它错误保留细节',
    describeDownloadError(new Error('模型下载失败（HTTP 404）')).includes('HTTP 404')
  );
}

section('目录布局');
{
  const dir = tempDir('pm-face-store-');
  const store = storeModule.createFaceModelStore({ userDataDir: dir });
  check('模型目录在 userData/models 下', store.modelDir === path.join(dir, 'models', 'buffalo_sc'));
  check(
    '封面目录在 userData/faces/covers 下',
    store.coverDir === path.join(dir, 'faces', 'covers')
  );
  check('模型文件路径按文件名拼接', store.modelPath('det_500m.onnx').endsWith('det_500m.onnx'));

  store
    .ensureReady()
    .then((ready) => {
      check('缺文件时 ensureReady 为 false', ready === false);
      return store.refreshStatus();
    })
    .then((status) => {
      check('缺文件时状态为 missing', status.state === 'missing');
      check('缺文件时不带错误信息', status.error === null);
    })
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      process.exit(summary());
    });
}
