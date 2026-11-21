/**
 * `pm://` 自定义协议：向渲染进程以「流」的方式提供原图与磁盘缩略图。
 *
 * ## 为什么需要它
 *
 * 把整张图片以 base64 塞给渲染进程，是这类照片应用最经典的 OOM 根因：
 * 一张 50MB 的 HEIC 转成 base64 后约 66MB，再乘以几十张预览就是几个 GB 的常驻内存。
 * 自定义协议让渲染进程只持有「地址」，由主进程按需读盘、按 Range 返回字节。
 *
 * ## 两条硬约束
 *
 * 1. `pm://file/<base64url>` 每次请求都做会话白名单校验（`isPathAuthorized`），
 *    未授权返回 403。这是本协议最关键的一道闸门 —— 没有它，任意 base64
 *    都能读到本机任意文件。图库里一张精心构造的 SVG 就有能力构造这种请求。
 * 2. 视频必须实现 HTTP Range（206 Partial Content），否则 `<video>` 无法
 *    seek、无法边下边播；整段读进内存会撑爆主进程。
 *
 * 协议本身不联网、不缓存到磁盘（缩略图缓存由 media-pipeline 负责）。
 */
const { protocol } = require('electron');
const fs = require('fs');
const { Readable } = require('stream');
const { promisify } = require('util');
const path = require('path');

const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

/** 必须在 app ready 之前调用一次：注册协议的特权标记（standard / secure / stream） */
function registerPmScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'pm',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
        stream: true,
      },
    },
  ]);
}

/**
 * @param {object} deps
 * @param {object} deps.logger
 * @param {() => string} deps.getThumbDir 缩略图缓存目录
 * @param {() => string} deps.getFaceDir 人像封面目录
 * @param {(p: string) => boolean} deps.isPathAuthorized
 * @param {(p: string) => boolean} deps.isHeicFile
 * @param {(p: string) => Promise<Buffer>} deps.readHeicAsJpeg
 * @param {(p: string) => string} deps.mimeTypeFor
 */
function createPmProtocol({
  logger,
  getThumbDir,
  getFaceDir,
  isPathAuthorized,
  isHeicFile,
  readHeicAsJpeg,
  mimeTypeFor,
}) {
  /**
   * 以「流」的方式返回磁盘文件，并实现 HTTP Range 语义。
   * <video> 依赖 206 Partial Content 才能拖动进度条 / 边下边播，
   * 直接把整个视频读进内存既无法 seek，也会让大文件撑爆主进程。
   */
  async function streamFileResponse(request, filePath) {
    const stats = await stat(filePath);
    const total = stats.size;
    const baseHeaders = {
      'Content-Type': mimeTypeFor(filePath),
      'Cache-Control': 'max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Accept-Ranges': 'bytes',
    };

    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
      if (match) {
        let start = match[1] === '' ? null : Number(match[1]);
        let end = match[2] === '' ? null : Number(match[2]);

        if (start === null && end === null) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` },
          });
        }

        if (start === null) {
          // 后缀区间：最后 N 字节
          const suffix = Math.min(end, total);
          start = total - suffix;
          end = total - 1;
        } else if (end === null || end >= total) {
          end = total - 1;
        }

        if (start > end || start >= total || start < 0) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` },
          });
        }

        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }
    }

    const stream = fs.createReadStream(filePath);
    return new Response(Readable.toWeb(stream), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) },
    });
  }

  /** 在 app ready 之后注册 handler。缩略图按文件名取（basename 归一化，避免路径穿越） */
  function register() {
    protocol.handle('pm', async (request) => {
      try {
        const url = new URL(request.url);
        const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const [kind, payload] = segments;

        if (kind === 'thumb' && payload) {
          const filePath = path.join(getThumbDir(), path.basename(payload));
          const data = await readFile(filePath);
          return new Response(data, {
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'max-age=31536000, immutable',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

        // 人像封面是主进程裁好的小方图，内容由本机生成，不含用户路径
        if (kind === 'face' && payload) {
          const filePath = path.join(getFaceDir(), path.basename(payload));
          const data = await readFile(filePath);
          return new Response(data, {
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'max-age=31536000, immutable',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

        if (kind === 'file' && payload) {
          const filePath = Buffer.from(payload, 'base64url').toString('utf8');

          // 白名单：只允许本次会话中用户主动打开过的图库范围内文件。
          // 这是本协议最关键的一道闸门 —— 没有它，任意 base64 都能读到本机任意文件。
          if (!isPathAuthorized(filePath)) {
            logger.warn('[pm] blocked unauthorized file request');
            return new Response('Forbidden', { status: 403 });
          }

          // HEIC 走转换缓存，避免每次打开大图都重新解码
          if (isHeicFile(filePath)) {
            const jpeg = await readHeicAsJpeg(filePath);
            return new Response(jpeg, {
              headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'max-age=3600',
                'Access-Control-Allow-Origin': '*',
              },
            });
          }

          return await streamFileResponse(request, filePath);
        }

        return new Response('Not Found', { status: 404 });
      } catch (error) {
        return new Response(String(error && error.message ? error.message : error), {
          status: 500,
        });
      }
    });
  }

  return { register, streamFileResponse };
}

module.exports = { registerPmScheme, createPmProtocol };
