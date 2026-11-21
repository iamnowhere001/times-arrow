/**
 * v0.6.6：本地人像识别的纯算法部分。
 *
 * 这里不加载 onnxruntime、不启动 Electron —— SCRFD 解码 / NMS、5 点相似变换、
 * 112×112 对齐、余弦聚类都是纯函数，用合成张量与合成位图就能验证方向与数值。
 * 真实模型推理在开发期用 Electron 脚本跑过（检测 1 张脸 / 同人余弦 ≈0.35–0.38）。
 *
 * 运行：npm run test:main -- face
 */
const path = require('path');
const scrfd = require('../../electron/main/face/scrfd.cjs');
const arcface = require('../../electron/main/face/arcface.cjs');
const cluster = require('../../electron/main/face/cluster.cjs');
const { __test } = require('../../electron/main/face/service.cjs');
const { createChecker } = require('./harness.cjs');

const { check, section, summary } = createChecker();
const PLANE = scrfd.INPUT_SIZE * scrfd.INPUT_SIZE;

/** 造一个 stride 的 score/bbox/kps 输出；只填第一行，其余为 0 */
function strideOutputs(stride, row) {
  const feature = scrfd.INPUT_SIZE / stride;
  const rows = feature * feature * 2;
  const score = new Float32Array(rows);
  const bbox = new Float32Array(rows * 4);
  const kps = new Float32Array(rows * 10);
  score[0] = 0.9;
  for (let i = 0; i < 4; i += 1) bbox[i] = row.bbox[i];
  for (let i = 0; i < 10; i += 1) kps[i] = row.kps[i];
  return { stride, score, bbox, kps, rows };
}

function tensor(data, rows, cols) {
  return { dims: [rows, cols], data };
}

section('SCRFD 预处理');
{
  const bitmap = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
  const data = scrfd.buildDetectorTensor(bitmap, 2, 1);
  check('张量长度为 3×640×640', data.length === PLANE * 3);
  check(
    'BGRA 映射到 B/G/R 三个平面',
    Math.abs(data[0] - (10 - 127.5) / 128) < 1e-6 &&
      Math.abs(data[PLANE] - (20 - 127.5) / 128) < 1e-6 &&
      Math.abs(data[PLANE * 2] - (30 - 127.5) / 128) < 1e-6
  );
  check('补黑区域取 0 归一化值', Math.abs(data[2] - scrfd.PAD_VALUE) < 1e-6);
}

section('SCRFD 后处理');
{
  const outputs = {};
  for (const stride of scrfd.STRIDES) {
    const out = strideOutputs(stride, {
      bbox: [1, 1, 2, 2],
      kps: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    outputs[`s${stride}`] = tensor(out.score, out.rows, 1);
    outputs[`b${stride}`] = tensor(out.bbox, out.rows, 4);
    outputs[`k${stride}`] = tensor(out.kps, out.rows, 10);
  }
  const dets = scrfd.decodeDetections(outputs);
  check('按 shape 找到三个 stride 的输出', dets.length === 3);
  check(
    '第一个 anchor 的框以 (0,0) 为中心解码',
    dets[0].box[0] === -8 && dets[0].box[1] === -8 && dets[0].box[2] === 16
  );

  const a = { score: 0.9, box: [0, 0, 100, 100], kps: [] };
  const b = { score: 0.8, box: [10, 10, 100, 100], kps: [] };
  const kept = scrfd.nms([b, a]);
  check('NMS 保留高分且抑制重叠框', kept.length === 1 && kept[0].score === 0.9);

  const scaled = scrfd.scaleDetections([a], 0.5);
  check('坐标按缩放比例还原', scaled[0].box[2] === 200);
}

section('ArcFace 对齐');
{
  const template = arcface.ARCFACE_TEMPLATE;
  const shifted = template.map(([x, y]) => [x + 10, y - 5]);
  const t = arcface.solveSimilarityTransform(shifted, template);
  check(
    '纯平移的相似变换：a=1,b=0',
    Math.abs(t.a - 1) < 1e-6 && Math.abs(t.b) < 1e-6 && Math.abs(t.tx + 10) < 1e-6
  );

  const doubled = template.map(([x, y]) => [x * 2, y * 2]);
  const t2 = arcface.solveSimilarityTransform(doubled, template);
  check('纯缩放的相似变换：a=0.5', Math.abs(t2.a - 0.5) < 1e-6 && Math.abs(t2.b) < 1e-6);

  // 112×112 纯色位图：BGRA = (100,150,200,255)
  const bitmap = Buffer.alloc(112 * 112 * 4);
  for (let i = 0; i < 112 * 112; i += 1) {
    bitmap[i * 4] = 100;
    bitmap[i * 4 + 1] = 150;
    bitmap[i * 4 + 2] = 200;
    bitmap[i * 4 + 3] = 255;
  }
  const aligned = arcface.extractAlignedTensor(bitmap, 112, 112, template);
  const plane = 112 * 112;
  check(
    'RGB 通道顺序与 (x-127.5)/127.5 归一化',
    Math.abs(aligned[0] - (200 - 127.5) / 127.5) < 1e-5 &&
      Math.abs(aligned[plane] - (150 - 127.5) / 127.5) < 1e-5 &&
      Math.abs(aligned[plane * 2] - (100 - 127.5) / 127.5) < 1e-5
  );

  const encoded = arcface.encodeEmbedding(Float32Array.from([1, 2, 3]));
  const decoded = arcface.decodeEmbedding(encoded);
  check('embedding base64 往返一致', decoded.length === 3 && decoded[2] === 3);

  const normalized = arcface.normalizeEmbedding(Float32Array.from([3, 4]));
  check('L2 归一化', Math.abs(normalized[0] - 0.6) < 1e-6);
}

section('聚类');
{
  const a = cluster.normalize(Float32Array.from([1, 0]));
  const b = cluster.normalize(Float32Array.from([0.95, 0.1]));
  const c = cluster.normalize(Float32Array.from([0, 1]));
  const centroids = [a];
  check('相似向量归入既有质心', cluster.findClosest(centroids, b).index === 0);
  check('不相似向量返回 -1', cluster.findClosest(centroids, c).index === -1);
  const centroid = cluster.centroidOf([a, b]);
  check('质心已归一化', Math.abs(cluster.dot(centroid, centroid) - 1) < 1e-6);
}

section('索引键');
{
  check(
    'faceKey 与 parseFaceKey 往返',
    (() => {
      const key = __test.faceKey('abc123', 2);
      const parsed = __test.parseFaceKey(key);
      return key === 'abc123#2' && parsed.fileId === 'abc123' && parsed.index === 2;
    })()
  );
  check('非法键返回 null', __test.parseFaceKey('nohash') === null);
}

section('缩略图引用');
{
  const thumbDir = '/tmp/pm-thumbs';
  check(
    'pm:// 缩略图 URL 还原为磁盘路径',
    __test.resolveThumbRef('pm://local/thumb/abc.jpg', thumbDir) ===
      path.join(thumbDir, 'abc.jpg')
  );
  check(
    '已是磁盘路径时原样返回',
    __test.resolveThumbRef('/tmp/a.jpg', thumbDir) === '/tmp/a.jpg'
  );
  check(
    '空引用直接报错，避免把 undefined 传给解码器',
    (() => {
      try {
        __test.resolveThumbRef(null, thumbDir);
        return false;
      } catch {
        return true;
      }
    })()
  );
}

process.exit(summary());
