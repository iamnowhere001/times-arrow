'use strict';

/**
 * ArcFace（buffalo_sc / w600k_mbf.onnx）的人脸对齐与预处理。
 *
 * InsightFace 的做法是：用 5 个关键点估计一个「相似变换」，把脸摆正成
 * 112×112（ArcFace 训练时的标准模板），再按 `(rgb - 127.5) / 127.5` 归一化。
 * Node 里没有 skimage / cv2，这里自己解最小二乘估计相似变换，并用双线性
 * 采样完成 warpAffine。方向是「模板 → 原图」的逆映射，因此不产生空洞。
 *
 * 模型期望 RGB 通道顺序：官方代码里 `img` 是 BGR，`blobFromImages(..., swapRB=True)`
 * 会交换 R/B 再送入网络；本项目 nativeImage 位图是 BGRA，所以这里直接取 R、G、B。
 */

const ALIGN_SIZE = 112;
const INPUT_MEAN = 127.5;
const INPUT_STD = 127.5;

/** ArcFace 112×112 的 5 点模板（左眼、右眼、鼻尖、左嘴角、右嘴角） */
const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * 解线性方程组（高斯消元 + 部分主元）。
 * @param {number[][]} matrix
 * @param {number[]} vector
 * @returns {number[]}
 */
function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) {
      throw new Error('人脸关键点共线，无法估计对齐变换');
    }
    if (pivot !== col) {
      const tmp = a[pivot];
      a[pivot] = a[col];
      a[col] = tmp;
    }

    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }

  return a.map((row) => row[n]);
}

/**
 * 估计把 src 点映射到 dst 点的相似变换：
 *   dstX = a*srcX - b*srcY + tx
 *   dstY = b*srcX + a*srcY + ty
 *
 * @param {number[][]} src
 * @param {number[][]} dst
 * @returns {{a:number, b:number, tx:number, ty:number}}
 */
function solveSimilarityTransform(src, dst) {
  if (src.length !== dst.length || src.length < 2) {
    throw new Error('相似变换至少需要两个点');
  }

  // 每个点贡献两行方程，未知量为 [a, b, tx, ty]
  const ata = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const atb = [0, 0, 0, 0];

  for (let i = 0; i < src.length; i += 1) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    const rows = [
      { coefficients: [sx, -sy, 1, 0], value: dx },
      { coefficients: [sy, sx, 0, 1], value: dy },
    ];
    for (const { coefficients, value } of rows) {
      for (let r = 0; r < 4; r += 1) {
        atb[r] += coefficients[r] * value;
        for (let c = 0; c < 4; c += 1) ata[r][c] += coefficients[r] * coefficients[c];
      }
    }
  }

  const [a, b, tx, ty] = solveLinearSystem(ata, atb);
  return { a, b, tx, ty };
}

/** 双线性采样一个通道；越界返回 0（与 cv2.warpAffine 的 borderValue=0 一致） */
function sampleBilinear(bitmap, width, height, x, y, channel) {
  if (x < -1 || y < -1 || x > width || y > height) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const read = (px, py) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return 0;
    return bitmap[(py * width + px) * 4 + channel];
  };

  const top = read(x0, y0) * (1 - fx) + read(x0 + 1, y0) * fx;
  const bottom = read(x0, y0 + 1) * (1 - fx) + read(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * 按 5 点关键点把人脸摆正成 112×112 的 NCHW RGB 张量。
 *
 * @param {Buffer|Uint8Array} bitmap BGRA 位图
 * @param {number} width
 * @param {number} height
 * @param {number[][]} kps 5 个关键点（与该位图同一坐标系）
 * @param {number} [size]
 * @returns {Float32Array} 长度 3*size*size
 */
function extractAlignedTensor(bitmap, width, height, kps, size = ALIGN_SIZE) {
  const template = ARCFACE_TEMPLATE.map(([x, y]) => [
    x * (size / ALIGN_SIZE),
    y * (size / ALIGN_SIZE),
  ]);
  const { a, b, tx, ty } = solveSimilarityTransform(kps, template);

  // 逆矩阵：模板像素 → 原图像素
  const det = a * a + b * b;
  if (det < 1e-9) throw new Error('对齐变换退化');

  const plane = size * size;
  const data = new Float32Array(plane * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - tx;
      const dy = y - ty;
      const sx = (a * dx + b * dy) / det;
      const sy = (-b * dx + a * dy) / det;

      const offset = y * size + x;
      // nativeImage 的位图是 BGRA：channel 2/1/0 即 R/G/B
      data[offset] = (sampleBilinear(bitmap, width, height, sx, sy, 2) - INPUT_MEAN) / INPUT_STD;
      data[offset + plane] =
        (sampleBilinear(bitmap, width, height, sx, sy, 1) - INPUT_MEAN) / INPUT_STD;
      data[offset + 2 * plane] =
        (sampleBilinear(bitmap, width, height, sx, sy, 0) - INPUT_MEAN) / INPUT_STD;
    }
  }
  return data;
}

/** 原地 L2 归一化：后续余弦相似度退化为点积 */
function normalizeEmbedding(embedding) {
  let norm = 0;
  for (let i = 0; i < embedding.length; i += 1) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return embedding;
  for (let i = 0; i < embedding.length; i += 1) embedding[i] /= norm;
  return embedding;
}

/** Float32 数组与 base64 的互转（JSON 持久化用，比 number[] 省一半以上体积） */
function encodeEmbedding(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength).toString(
    'base64'
  );
}

function decodeEmbedding(encoded) {
  const buffer = Buffer.from(encoded, 'base64');
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

module.exports = {
  ALIGN_SIZE,
  ARCFACE_TEMPLATE,
  solveSimilarityTransform,
  extractAlignedTensor,
  normalizeEmbedding,
  encodeEmbedding,
  decodeEmbedding,
};
