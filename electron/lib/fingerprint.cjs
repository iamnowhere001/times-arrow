'use strict';

/**
 * 内容指纹：给「哪张照片是同一份文件」一个与路径无关的答案。
 *
 * 取舍：不读整份文件（大视频读全量会把导入拖垮），取 size + 头尾各 64KB
 * 做 sha256，再截 128 bit。小文件（≤128KB）等价于全量哈希。
 * 这不是加密哈希用途，也不需要抗碰撞攻击 —— 它只用于本机图库去重身份，
 * 128 bit 对十万级文件足够。同一张图存成 JPEG / PNG 会拿到**不同** id，
 * 这是刻意的：感知相似由 dHash 负责，身份判定要精确。
 */

const fs = require('fs');
const { createHash } = require('crypto');

const SAMPLE_BYTES = 64 * 1024;
const ID_LENGTH = 32;

/** 单个文件的内容指纹；文件不存在 / 读失败返回 null（调用方决定如何降级） */
async function computeFileFingerprint(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const size = stat.size;
  const hash = createHash('sha256');
  hash.update(`size:${size}\0`);

  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    if (size <= SAMPLE_BYTES * 2) {
      const buf = Buffer.allocUnsafe(Math.max(size, 0));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      hash.update(buf.subarray(0, bytesRead));
    } else {
      const head = Buffer.allocUnsafe(SAMPLE_BYTES);
      const headRead = await handle.read(head, 0, SAMPLE_BYTES, 0);
      hash.update(head.subarray(0, headRead.bytesRead));

      const tail = Buffer.allocUnsafe(SAMPLE_BYTES);
      const tailRead = await handle.read(tail, 0, SAMPLE_BYTES, size - SAMPLE_BYTES);
      hash.update(tail.subarray(0, tailRead.bytesRead));
    }
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* 已关闭，无需处理 */
      }
    }
  }

  return hash.digest('hex').slice(0, ID_LENGTH);
}

/** 批量计算，带受控并发；返回 path → id，算不出的路径不出现在结果里 */
async function computeFileFingerprints(paths, concurrency = 8) {
  const queue = [...new Set((paths ?? []).filter((p) => typeof p === 'string' && p))];
  const result = {};
  if (queue.length === 0) return result;

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const filePath = queue[index];
      const id = await computeFileFingerprint(filePath);
      if (id) result[filePath] = id;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker)
  );
  return result;
}

module.exports = { computeFileFingerprint, computeFileFingerprints };
