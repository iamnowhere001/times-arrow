'use strict';

/**
 * 人脸模型的下载、校验与安装。
 *
 * 取舍（v0.6.6 拍板）：DMG 里只带 onnxruntime-node 运行时，模型不进安装包，
 * 由用户在「人像」页显式点击后从 InsightFace 官方 GitHub Release 下载
 * （buffalo_sc，约 15MB 压缩包 / 约 16MB 磁盘）。这样安装包保持干净，
 * 模型以后也能单独替换。
 *
 * 线路：优先走 GitHub 加速镜像，最后回落到官方地址。镜像只是**传输通道**，
 * 信任锚始终是写死的 SHA256 —— 镜像篡改或返回错误页面都会在校验阶段被拒绝。
 * 国内网络下 release-assets.githubusercontent.com 常被解析到不可用地址，
 * 没有这条回落，首次下载会直接失败。
 *
 * 校验：整个 zip 校验 SHA256，解压后对两个 onnx 文件再各校验一次，
 * 任何一步不通过都不落盘到正式目录，避免「半截模型」把推理结果带偏。
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const AdmZip = require('adm-zip');

const MODEL_ID = 'buffalo_sc';
const MODEL_URL =
  'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip';
const MIRROR_PREFIXES = ['https://ghproxy.net/', 'https://ghfast.top/'];
const DOWNLOAD_URLS = [...MIRROR_PREFIXES.map((prefix) => prefix + MODEL_URL), MODEL_URL];
const ARCHIVE_SHA256 = '57d31b56b6ffa911c8a73cfc1707c73cab76efe7f13b675a05223bf42de47c72';
const FILES = [
  {
    name: 'det_500m.onnx',
    size: 2524817,
    sha256: '5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a',
  },
  {
    name: 'w600k_mbf.onnx',
    size: 13616099,
    sha256: '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f',
  },
];
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const REDIRECT_LIMIT = 5;

// 校验与解压按文件串行执行：并行读 16MB 只会抢磁盘，收益为零。
/* eslint-disable no-await-in-loop */

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 把底层网络错误翻译成用户能理解、且知道下一步做什么的文案 */
function describeDownloadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('模型下载失败：')) return message;
  const code = error && error.code;
  const offline =
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    /timeout|超时/i.test(message);
  return offline
    ? '模型下载失败：无法连接下载服务器，请检查网络后重试'
    : `模型下载失败：${message}`;
}

/** 带重定向、体积上限与空闲超时的下载；写入 dest 并返回 sha256 */
function downloadFile(url, dest, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let received = 0;
    let total = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      fs.promises.rm(dest, { force: true }).finally(() => reject(error));
    };

    const request = (currentUrl) => {
      const req = https.get(
        currentUrl,
        {
          headers: {
            'User-Agent': 'PhotoMinder',
            Accept: 'application/octet-stream',
          },
        },
        (response) => {
          const status = response.statusCode || 0;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            redirects += 1;
            if (redirects > REDIRECT_LIMIT) {
              fail(new Error('模型下载重定向次数过多'));
              return;
            }
            request(new URL(response.headers.location, currentUrl).toString());
            return;
          }
          if (status !== 200) {
            response.resume();
            fail(new Error(`模型下载失败（HTTP ${status}）`));
            return;
          }

          total = Number(response.headers['content-length'] || 0);
          if (total > MAX_ARCHIVE_BYTES) {
            response.resume();
            fail(new Error('模型包体积异常，已中止下载'));
            return;
          }

          const file = fs.createWriteStream(dest);
          const hash = crypto.createHash('sha256');

          response.on('data', (chunk) => {
            received += chunk.length;
            if (received > MAX_ARCHIVE_BYTES) {
              response.destroy(new Error('模型包体积异常，已中止下载'));
              return;
            }
            hash.update(chunk);
            onProgress?.({ received, total });
          });
          response.on('error', (error) => {
            file.destroy();
            fail(error);
          });
          response.pipe(file);
          file.on('error', fail);
          file.on('finish', () => {
            if (settled) return;
            settled = true;
            file.close(() => resolve({ sha256: hash.digest('hex'), received }));
          });
        }
      );

      req.setTimeout(30000, () => {
        req.destroy(new Error('模型下载超时，请检查网络后重试'));
      });
      req.on('error', fail);
      signal?.addEventListener('abort', () => req.destroy(new Error('下载已取消')), {
        once: true,
      });
    };

    request(url);
  });
}

/**
 * @param {{ userDataDir: string, logger?: { warn: Function, error: Function } }} options
 */
function createFaceModelStore({ userDataDir, logger }) {
  const modelRoot = path.join(userDataDir, 'models');
  const modelDir = path.join(modelRoot, MODEL_ID);
  const coverDir = path.join(userDataDir, 'faces', 'covers');
  const archivePath = path.join(modelRoot, `.${MODEL_ID}.download`);

  let status = { state: 'unknown', percent: 0, received: 0, total: 0, error: null };
  let verifying = null;
  let verifiedReady = false;
  let abortController = null;

  const modelPath = (name) => path.join(modelDir, name);

  async function filesReady() {
    for (const file of FILES) {
      try {
        const stat = await fs.promises.stat(modelPath(file.name));
        if (!stat.isFile() || stat.size !== file.size) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async function verifyFiles() {
    for (const file of FILES) {
      const digest = await sha256File(modelPath(file.name));
      if (digest !== file.sha256) {
        logger?.warn?.(`人脸模型校验失败: ${file.name}`);
        return false;
      }
    }
    return true;
  }

  /** 首次调用做一次完整校验，之后走内存标记；模型被外部删掉时靠 sized 检查兜底 */
  async function ensureReady() {
    if (verifiedReady) return true;
    if (!(await filesReady())) {
      verifiedReady = false;
      return false;
    }
    if (!verifying) verifying = verifyFiles().finally(() => (verifying = null));
    verifiedReady = await verifying;
    return verifiedReady;
  }

  async function refreshStatus() {
    if (status.state === 'downloading') return status;
    const ready = await ensureReady();
    if (ready) {
      status = { state: 'ready', percent: 100, received: 0, total: 0, error: null };
    } else if (status.state !== 'error') {
      status = { state: 'missing', percent: 0, received: 0, total: 0, error: null };
    }
    return status;
  }

  function setStatus(patch) {
    status = { ...status, ...patch };
    return status;
  }

  async function extractInstalled(archive, sourceUrl) {
    const stagingDir = path.join(modelRoot, `.${MODEL_ID}.staging-${Date.now()}`);
    await fs.promises.mkdir(stagingDir, { recursive: true });
    try {
      const zip = new AdmZip(archive);
      for (const file of FILES) {
        const entry = zip.getEntry(file.name) || zip.getEntry(`${MODEL_ID}/${file.name}`);
        if (!entry) throw new Error(`模型包缺少 ${file.name}`);
        const buffer = entry.getData();
        if (buffer.length !== file.size) throw new Error(`模型文件体积异常: ${file.name}`);
        const digest = crypto.createHash('sha256').update(buffer).digest('hex');
        if (digest !== file.sha256) throw new Error(`模型文件校验失败: ${file.name}`);
        await fs.promises.writeFile(path.join(stagingDir, file.name), buffer);
      }
      await fs.promises.writeFile(
        path.join(stagingDir, 'manifest.json'),
        JSON.stringify(
          { id: MODEL_ID, source: sourceUrl, installedAt: new Date().toISOString() },
          null,
          2
        )
      );

      await fs.promises.rm(modelDir, { recursive: true, force: true });
      await fs.promises.rename(stagingDir, modelDir);
      verifiedReady = true;
    } finally {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 下载并安装模型。同一时间只允许一个下载任务。
   * @param {(progress: {percent:number, received:number, total:number}) => void} [onProgress]
   */
  async function download(onProgress) {
    if (status.state === 'downloading') {
      throw new Error('模型正在下载中');
    }
    if (await ensureReady()) {
      setStatus({ state: 'ready', percent: 100, error: null });
      return;
    }

    await fs.promises.mkdir(modelRoot, { recursive: true });
    await fs.promises.rm(archivePath, { force: true });
    abortController = new AbortController();
    setStatus({ state: 'downloading', percent: 0, received: 0, total: 0, error: null });

    let lastEmit = 0;
    let usedUrl = null;
    let usedBytes = 0;
    let lastError = null;
    try {
      for (const url of DOWNLOAD_URLS) {
        if (abortController.signal.aborted) throw new Error('下载已取消');
        try {
          const { sha256, received } = await downloadFile(url, archivePath, {
            signal: abortController.signal,
            onProgress: ({ received: done, total }) => {
              const percent = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
              setStatus({ percent, received: done, total });
              const now = Date.now();
              if (now - lastEmit > 200) {
                lastEmit = now;
                onProgress?.({ percent, received: done, total });
              }
            },
          });
          // 校验失败也换下一条线路：镜像可能返回错误页面 / 旧版本包
          if (sha256 !== ARCHIVE_SHA256) throw new Error('模型包校验失败');
          usedUrl = url;
          usedBytes = received;
          break;
        } catch (error) {
          lastError = error;
          if (abortController.signal.aborted) throw error;
          logger?.warn?.(`人脸模型下载线路失败（${url}）: ${error.message}`);
          await fs.promises.rm(archivePath, { force: true }).catch(() => {});
          setStatus({ percent: 0, received: 0, total: 0 });
        }
      }

      if (!usedUrl) throw new Error(describeDownloadError(lastError));
      setStatus({ state: 'installing', percent: 100, received: usedBytes, error: null });
      await extractInstalled(archivePath, usedUrl);
      setStatus({ state: 'ready', percent: 100, received: 0, total: 0, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`人脸模型下载失败: ${message}`);
      setStatus({ state: 'error', percent: 0, error: message });
      throw error;
    } finally {
      abortController = null;
      await fs.promises.rm(archivePath, { force: true }).catch(() => {});
      onProgress?.(status);
    }
  }

  function cancelDownload() {
    if (!abortController) return false;
    abortController.abort();
    return true;
  }

  async function ensureCoverDir() {
    await fs.promises.mkdir(coverDir, { recursive: true });
    return coverDir;
  }

  return {
    modelId: MODEL_ID,
    modelDir,
    coverDir,
    modelPath,
    getStatus: () => status,
    refreshStatus,
    ensureReady,
    download,
    cancelDownload,
    ensureCoverDir,
  };
}

module.exports = {
  MODEL_ID,
  MODEL_URL,
  MIRROR_PREFIXES,
  DOWNLOAD_URLS,
  ARCHIVE_SHA256,
  FILES,
  createFaceModelStore,
  __test: { downloadFile, describeDownloadError },
};
