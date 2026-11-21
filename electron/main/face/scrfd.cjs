'use strict';

/**
 * SCRFD（buffalo_sc / det_500m.onnx）的预处理与后处理。
 *
 * InsightFace 的检测器是 Python 库，Node 里不能直接 require；这里按官方
 * `insightface/model_zoo/scrfd.py` 的推理流程用 JS 重新实现：
 *   1. 等比缩放到 640×640 左上角、其余补黑（不是拉伸）；
 *   2. 归一化 `(bgr - 127.5) / 128`（模型训练在 BGR 上，nativeImage 的 BGRA
 *      位图前三个通道正好是 B、G、R，顺序不能换）；
 *   3. 三个 stride（8/16/32）各 2 个 anchor 输出 score / bbox / kps；
 *   4. 按 stride 反解矩形与 5 个关键点，再做一次 NMS。
 *
 * 纯函数（不打日志、不碰 Electron），便于在 `tests/main-process` 里单独验证。
 */

const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32];
const NUM_ANCHORS = 2;
const DET_THRESHOLD = 0.5;
const NMS_THRESHOLD = 0.4;

/** 补黑区域的取值：与 Python 里 uint8 0 归一化后的结果一致 */
const PAD_VALUE = (0 - 127.5) / 128;

/**
 * 把一张 BGRA 位图写进 640×640 的 NCHW 张量。
 *
 * @param {Buffer|Uint8Array} bitmap nativeImage.toBitmap() 的结果（BGRA）
 * @param {number} width 缩放后的宽度（<= 640）
 * @param {number} height 缩放后的高度（<= 640）
 * @returns {Float32Array} 长度 3*640*640
 */
function buildDetectorTensor(bitmap, width, height) {
  const plane = INPUT_SIZE * INPUT_SIZE;
  const data = new Float32Array(plane * 3);
  data.fill(PAD_VALUE);

  const limitH = Math.min(height, INPUT_SIZE);
  const limitW = Math.min(width, INPUT_SIZE);
  for (let y = 0; y < limitH; y += 1) {
    const srcRow = y * width * 4;
    const dstRow = y * INPUT_SIZE;
    for (let x = 0; x < limitW; x += 1) {
      const src = srcRow + x * 4;
      const dst = dstRow + x;
      data[dst] = (bitmap[src] - 127.5) / 128;
      data[dst + plane] = (bitmap[src + 1] - 127.5) / 128;
      data[dst + 2 * plane] = (bitmap[src + 2] - 127.5) / 128;
    }
  }
  return data;
}

/** 在 onnxruntime 的输出里按「行数 + 每行宽度」定位某个 stride 的某一类输出 */
function findOutput(outputs, rows, cols) {
  for (const name of Object.keys(outputs)) {
    const tensor = outputs[name];
    if (tensor && tensor.dims && tensor.dims.length === 2) {
      if (tensor.dims[0] === rows && tensor.dims[1] === cols) return tensor.data;
    }
  }
  return null;
}

/**
 * 解码三个 stride 的输出。
 *
 * @param {Record<string, {dims: number[], data: Float32Array}>} outputs
 * @param {number} threshold
 * @returns {{score:number, box:number[], kps:number[][]}[]} 坐标位于 640×640 空间
 */
function decodeDetections(outputs, threshold = DET_THRESHOLD) {
  const detections = [];

  for (const stride of STRIDES) {
    const feature = INPUT_SIZE / stride;
    const rows = feature * feature * NUM_ANCHORS;
    const scores = findOutput(outputs, rows, 1);
    const bbox = findOutput(outputs, rows, 4);
    const kps = findOutput(outputs, rows, 10);
    if (!scores || !bbox || !kps) continue;

    for (let i = 0; i < rows; i += 1) {
      const score = scores[i];
      if (score < threshold) continue;

      const location = Math.floor(i / NUM_ANCHORS);
      const cx = (location % feature) * stride;
      const cy = Math.floor(location / feature) * stride;

      const b = i * 4;
      const k = i * 10;
      const points = [];
      for (let p = 0; p < 5; p += 1) {
        points.push([cx + kps[k + p * 2] * stride, cy + kps[k + p * 2 + 1] * stride]);
      }

      detections.push({
        score,
        box: [
          cx - bbox[b] * stride,
          cy - bbox[b + 1] * stride,
          cx + bbox[b + 2] * stride,
          cy + bbox[b + 3] * stride,
        ],
        kps: points,
      });
    }
  }

  return detections;
}

function area(box) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function intersectionOverUnion(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (area(a) + area(b) - inter);
}

/** 标准 NMS：按得分从高到低保留，IoU 超阈值的低分框丢弃 */
function nms(detections, threshold = NMS_THRESHOLD) {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const candidate of sorted) {
    let suppressed = false;
    for (const accepted of kept) {
      if (intersectionOverUnion(candidate.box, accepted.box) > threshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(candidate);
  }
  return kept;
}

/**
 * 把 640×640 空间的检测结果换算回原图坐标，并裁掉越界点。
 * @param {{score:number, box:number[], kps:number[][]}[]} detections
 * @param {number} scale 缩放比例（缩放后尺寸 / 原图尺寸）
 */
function scaleDetections(detections, scale) {
  if (!scale || scale <= 0) return detections;
  return detections.map((det) => ({
    score: det.score,
    box: det.box.map((value) => value / scale),
    kps: det.kps.map((point) => [point[0] / scale, point[1] / scale]),
  }));
}

module.exports = {
  INPUT_SIZE,
  STRIDES,
  DET_THRESHOLD,
  NMS_THRESHOLD,
  PAD_VALUE,
  buildDetectorTensor,
  decodeDetections,
  intersectionOverUnion,
  nms,
  scaleDetections,
};
