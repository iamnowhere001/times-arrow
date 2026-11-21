'use strict';

/**
 * 人脸索引服务：扫描、聚类、持久化、封面裁剪与 IPC。
 *
 * 数据流：
 *   渲染层给出图库照片的 { path, fileId } → 主进程用缩略图管线拿到「已按 EXIF 摆正」
 *   的 640 / 1120 两张小图 → SCRFD 检测 → ArcFace 提取 512 维特征 → 最近质心聚类
 *   → 写入 faces.json（按 fileId 记录，遵循项目「不做路径键」的不变式）。
 *
 * 为什么复用 ensureThumbnail 而不是自己解码原图：
 *   nativeImage 不会套用 EXIF 方向（竖拍会被当成横图，检测直接失效），而缩略图管线
 *   已经把方向烙进像素、带磁盘缓存、且限制了内存峰值。代价只是多一次 JPEG 编解码。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scrfd = require('./scrfd.cjs');
const arcface = require('./arcface.cjs');
const cluster = require('./cluster.cjs');
const { createFaceModelStore } = require('./model-store.cjs');

// 扫描、下载、写封面都是刻意串行的 IO / 推理：并发只会抢 CPU、放大内存峰值，
// 因此本文件统一关闭 no-await-in-loop。
/* eslint-disable no-await-in-loop */

const INDEX_FILE = 'faces.json';
const INDEX_VERSION = 1;
const DETECT_IMAGE_SIZE = 640;
const ALIGN_IMAGE_SIZE = 1120;
const COVER_SIZE = 160;
const MIN_FACE_SIZE = 24;
const MAX_FACES_PER_PHOTO = 16;
const MAX_NAME_LENGTH = 40;

const MODEL_MISSING_MESSAGE = '人脸模型尚未下载';
const IMAGE_EXTENSION = /\.(jpe?g|png|heic|heif|webp|tiff?|bmp)$/i;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function emptyIndex() {
  return {
    version: INDEX_VERSION,
    modelId: 'buffalo_sc',
    updatedAt: null,
    entries: {},
    people: [],
    assignments: {},
  };
}

function faceKey(fileId, index) {
  return `${fileId}#${index}`;
}

function parseFaceKey(key) {
  const at = key.lastIndexOf('#');
  if (at <= 0) return null;
  return { fileId: key.slice(0, at), index: Number(key.slice(at + 1)) };
}

/**
 * `ensureThumbnail` 返回的是 `pm://local/thumb/<key>.jpg`（给渲染进程用），
 * 不是文件系统路径；`nativeImage.createFromPath` 只认后者。
 * 这里把 URL 还原成磁盘路径 —— 直接拿 URL 去解码会让每张照片都报「图片无法解码」。
 */
function resolveThumbRef(ref, thumbDir) {
  if (typeof ref !== 'string' || !ref) throw new Error('缩略图尚未生成');
  if (!ref.startsWith('pm://')) return ref;
  return path.join(thumbDir, path.basename(ref));
}

/**
 * @param {{
 *   userDataDir: string,
 *   nativeImage: Electron.NativeImage,
 *   store: { readStore: Function, mergeStore: Function },
 *   ensureThumbnail: (filePath: string, maxSize?: number) => Promise<string | null>,
 *   getThumbDir: () => string,
 *   isPathAuthorized: (filePath: string) => boolean,
 *   unauthorizedError: string,
 *   send: (channel: string, payload?: unknown) => void,
 *   logger?: { info?: Function, warn: Function, error: Function },
 * }} options
 */
function createFaceService({
  userDataDir,
  nativeImage,
  store,
  ensureThumbnail,
  getThumbDir = () => path.join(userDataDir, 'thumbnails'),
  isPathAuthorized,
  unauthorizedError,
  send,
  logger,
}) {
  const modelStore = createFaceModelStore({ userDataDir, logger });

  const toThumbPath = (ref) => resolveThumbRef(ref, getThumbDir());

  let detSession = null;
  let recSession = null;
  let sessionLoading = null;
  let index = null;
  let scanToken = null;
  let scanState = {
    isScanning: false,
    phase: 'idle',
    done: 0,
    total: 0,
    current: '',
    faces: 0,
    failed: 0,
  };

  const emit = (channel, payload) => {
    try {
      send?.(channel, payload);
    } catch (error) {
      logger?.warn?.(`[face] 事件发送失败: ${error.message}`);
    }
  };

  // ---------------------------------------------------------------- 模型 / 会话

  async function loadSessions() {
    if (detSession && recSession) return { detSession, recSession };
    if (!(await modelStore.ensureReady())) {
      throw new Error(MODEL_MISSING_MESSAGE);
    }
    if (!sessionLoading) {
      sessionLoading = (async () => {
        // onnxruntime-node 是原生模块：懒加载，缺失或 ABI 不匹配时只影响人像功能
        const ort = require('onnxruntime-node');
        const options = {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
          intraOpNumThreads: clamp(os.cpus().length - 2, 2, 6),
        };
        detSession = await ort.InferenceSession.create(
          modelStore.modelPath('det_500m.onnx'),
          options
        );
        recSession = await ort.InferenceSession.create(
          modelStore.modelPath('w600k_mbf.onnx'),
          options
        );
        return { detSession, recSession };
      })().catch((error) => {
        sessionLoading = null;
        throw new Error(`人脸识别组件加载失败：${error.message}`);
      });
    }
    return sessionLoading;
  }

  // ---------------------------------------------------------------- 索引读写

  async function loadIndex() {
    if (index) return index;
    const raw = await store.readStore(INDEX_FILE);
    const people = Array.isArray(raw?.people)
      ? raw.people.filter((person) => person && typeof person.id === 'string')
      : [];
    index = {
      version: INDEX_VERSION,
      modelId: raw?.modelId || 'buffalo_sc',
      updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : null,
      entries:
        raw?.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
          ? raw.entries
          : {},
      people,
      assignments:
        raw?.assignments && typeof raw.assignments === 'object' && !Array.isArray(raw.assignments)
          ? raw.assignments
          : {},
    };
    return index;
  }

  async function saveIndex() {
    if (!index) return;
    index.updatedAt = Date.now();
    await store.mergeStore(INDEX_FILE, {
      version: index.version,
      modelId: index.modelId,
      updatedAt: index.updatedAt,
      entries: index.entries,
      people: index.people,
      assignments: index.assignments,
    });
  }

  async function statsOf(current) {
    let photosWithFaces = 0;
    let faces = 0;
    for (const entry of Object.values(current.entries)) {
      if (Array.isArray(entry?.faces) && entry.faces.length > 0) {
        photosWithFaces += 1;
        faces += entry.faces.length;
      }
    }

    // 人物数按「仍有有效人脸指向」统计，避免把重扫后失效的旧人物算进去
    const assignedPeople = new Set();
    for (const [key, personId] of Object.entries(current.assignments)) {
      const parsed = parseFaceKey(key);
      if (!parsed || !personId) continue;
      if (current.entries[parsed.fileId]?.faces?.[parsed.index]) assignedPeople.add(personId);
    }

    return {
      indexed: Object.keys(current.entries).length,
      photosWithFaces,
      faces,
      people: assignedPeople.size,
    };
  }

  async function getStatus() {
    await modelStore.refreshStatus();
    const current = await loadIndex();
    return {
      model: modelStore.getStatus(),
      scan: scanState,
      stats: await statsOf(current),
    };
  }

  // ---------------------------------------------------------------- 检测与特征

  function createPersonId() {
    return `p-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  /** 从已摆正的检测小图上裁一张方形封面，避免界面再算 CSS 裁切 */
  async function writeCover(detImage, detWidth, detHeight, box, fileId, faceIndex) {
    const boxWidth = Math.max(1, box[2] - box[0]);
    const boxHeight = Math.max(1, box[3] - box[1]);
    const side = Math.max(boxWidth, boxHeight) * 1.6;
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;

    const x = clamp(Math.round(cx - side / 2), 0, Math.max(0, detWidth - 1));
    const y = clamp(Math.round(cy - side / 2), 0, Math.max(0, detHeight - 1));
    const width = clamp(Math.round(side), 1, detWidth - x);
    const height = clamp(Math.round(side), 1, detHeight - y);

    const coverName = `${crypto
      .createHash('sha1')
      .update(`${fileId}#${faceIndex}`)
      .digest('hex')
      .slice(0, 24)}.jpg`;
    const coverPath = path.join(modelStore.coverDir, coverName);

    try {
      const cover = detImage
        .crop({ x, y, width, height })
        .resize({ width: COVER_SIZE, height: COVER_SIZE, quality: 'good' });
      await fs.promises.mkdir(modelStore.coverDir, { recursive: true });
      await fs.promises.writeFile(coverPath, cover.toJPEG(82));
      return coverName;
    } catch (error) {
      logger?.warn?.(`[face] 封面生成失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 处理一张照片：检测 + 特征 + 封面。
   * @returns {Promise<{faces: {box:number[], embedding:string, cover:string|null}[], width:number, height:number}>}
   */
  async function analyzePhoto(filePath, fileId, { detSession: det, recSession: rec, ort }) {
    const detThumbPath = toThumbPath(await ensureThumbnail(filePath, DETECT_IMAGE_SIZE));
    const detImage = nativeImage.createFromPath(detThumbPath);
    if (detImage.isEmpty()) throw new Error('图片无法解码');
    const detSize = detImage.getSize();
    if (!detSize.width || !detSize.height) throw new Error('图片尺寸异常');

    const bitmap = detImage.toBitmap();
    const tensor = scrfd.buildDetectorTensor(bitmap, detSize.width, detSize.height);
    const outputs = await det.run({
      [det.inputNames[0]]: new ort.Tensor('float32', tensor, [
        1,
        3,
        scrfd.INPUT_SIZE,
        scrfd.INPUT_SIZE,
      ]),
    });
    let detections = scrfd.decodeDetections(outputs);
    detections = scrfd
      .nms(detections)
      .filter((det) => det.box[2] - det.box[0] >= MIN_FACE_SIZE)
      .slice(0, MAX_FACES_PER_PHOTO);

    if (detections.length === 0) {
      return { faces: [], width: detSize.width, height: detSize.height };
    }

    const alignThumbPath = toThumbPath(await ensureThumbnail(filePath, ALIGN_IMAGE_SIZE));
    const alignImage =
      alignThumbPath === detThumbPath ? detImage : nativeImage.createFromPath(alignThumbPath);
    const alignSize = alignImage.isEmpty() ? detSize : alignImage.getSize();
    const alignBitmap = alignImage.isEmpty() ? bitmap : alignImage.toBitmap();
    const scaleX = alignSize.width / detSize.width;
    const scaleY = alignSize.height / detSize.height;

    const faces = [];
    for (let i = 0; i < detections.length; i += 1) {
      const det = detections[i];
      const kps = det.kps.map(([x, y]) => [x * scaleX, y * scaleY]);
      let embedding;
      try {
        const aligned = arcface.extractAlignedTensor(
          alignBitmap,
          alignSize.width,
          alignSize.height,
          kps
        );
        const output = await rec.run({
          [rec.inputNames[0]]: new ort.Tensor('float32', aligned, [
            1,
            3,
            arcface.ALIGN_SIZE,
            arcface.ALIGN_SIZE,
          ]),
        });
        const tensorOut = output[rec.outputNames[0]];
        embedding = arcface.normalizeEmbedding(Float32Array.from(tensorOut.data));
      } catch (error) {
        logger?.warn?.(`[face] 特征提取失败: ${error.message}`);
        continue;
      }

      const cover = await writeCover(detImage, detSize.width, detSize.height, det.box, fileId, i);
      faces.push({
        box: det.box.map((value) => Math.round(value * 10) / 10),
        embedding: arcface.encodeEmbedding(embedding),
        cover,
      });
    }

    return { faces, width: detSize.width, height: detSize.height };
  }

  // ---------------------------------------------------------------- 聚类

  /** 按现有 assignments 计算每个已有人物的质心 */
  function buildCentroids(current) {
    const buckets = new Map();
    for (const [key, personId] of Object.entries(current.assignments)) {
      const parsed = parseFaceKey(key);
      if (!parsed) continue;
      const face = current.entries[parsed.fileId]?.faces?.[parsed.index];
      if (!face?.embedding) continue;
      if (!buckets.has(personId)) buckets.set(personId, []);
      buckets.get(personId).push(arcface.decodeEmbedding(face.embedding));
    }
    const centroids = new Map();
    for (const person of current.people) {
      const list = buckets.get(person.id) || [];
      if (list.length > 0) centroids.set(person.id, cluster.centroidOf(list));
    }
    return { buckets, centroids };
  }

  /**
   * 给新脸分配人物。只处理尚未 assignment 的脸，避免重扫把用户手动合并的结果冲掉。
   * @param {{fileId:string, index:number, embedding:Float32Array}[]} newFaces
   */
  function assignFaces(current, newFaces) {
    const { buckets, centroids } = buildCentroids(current);
    const order = [...centroids.keys()];

    for (const face of newFaces) {
      const list = order.map((id) => centroids.get(id));
      const { index: hit } = cluster.findClosest(list, face.embedding);
      let personId;
      if (hit >= 0) {
        personId = order[hit];
      } else {
        const person = {
          id: createPersonId(),
          name: '',
          createdAt: Date.now(),
        };
        current.people.push(person);
        personId = person.id;
        centroids.set(personId, face.embedding);
        // 这里只建空桶：下面统一 push 一次。若在这里先塞入一次，
        // 新人物的人脸数会从 2 开始（面上是 1 张，UI 显示 2 张人脸）。
        buckets.set(personId, []);
        order.push(personId);
      }

      current.assignments[faceKey(face.fileId, face.index)] = personId;
      // 增量更新质心，避免「同一张合影里的人脸互相拉开距离」
      const embeddings = buckets.get(personId) || [];
      embeddings.push(face.embedding);
      centroids.set(personId, cluster.centroidOf(embeddings));
    }

    for (const person of current.people) {
      const embeddings = buckets.get(person.id) || [];
      person.faceCount = embeddings.length;
    }
  }

  // ---------------------------------------------------------------- 扫描

  function normalizeCandidates(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const candidates = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const { path: filePath, fileId } = item;
      if (typeof filePath !== 'string' || typeof fileId !== 'string') continue;
      if (!fileId || fileId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(fileId)) continue;
      if (!IMAGE_EXTENSION.test(filePath)) continue;
      if (seen.has(fileId)) continue;
      seen.add(fileId);
      candidates.push({ path: filePath, fileId });
    }
    return candidates;
  }

  async function runScan(candidates, token, force) {
    const sessions = await loadSessions();
    const ort = require('onnxruntime-node');
    const current = await loadIndex();

    const newFaces = [];
    let done = 0;
    let failed = 0;
    let skipped = 0;

    const update = (patch) => {
      scanState = { ...scanState, ...patch };
      emit('face-scan-progress', scanState);
    };

    scanState = {
      isScanning: true,
      phase: 'detecting',
      done: 0,
      total: candidates.length,
      current: '',
      faces: 0,
      failed: 0,
    };
    emit('face-scan-progress', scanState);

    for (const candidate of candidates) {
      if (token.aborted) break;
      done += 1;
      const currentName = path.basename(candidate.path);

      try {
        if (!isPathAuthorized(candidate.path)) throw new Error(unauthorizedError);
        const stat = await fs.promises.stat(candidate.path);
        const existing = current.entries[candidate.fileId];
        const fresh =
          existing &&
          existing.size === stat.size &&
          Math.round(existing.mtime) === Math.round(stat.mtimeMs);

        if (!force && fresh) {
          skipped += 1;
          update({ done, current: currentName });
          continue;
        }

        const result = await analyzePhoto(candidate.path, candidate.fileId, {
          detSession: sessions.detSession,
          recSession: sessions.recSession,
          ort,
        });

        current.entries[candidate.fileId] = {
          name: path.basename(candidate.path),
          size: stat.size,
          mtime: stat.mtimeMs,
          scannedAt: Date.now(),
          width: result.width,
          height: result.height,
          faces: result.faces,
        };

        // 重扫后旧封面可能不再对应，先清掉旧 assignment，等新脸重新聚类
        for (let i = 0; i < (existing?.faces?.length || 0); i += 1) {
          delete current.assignments[faceKey(candidate.fileId, i)];
        }

        for (let i = 0; i < result.faces.length; i += 1) {
          newFaces.push({
            fileId: candidate.fileId,
            index: i,
            embedding: arcface.decodeEmbedding(result.faces[i].embedding),
          });
        }

        update({
          done,
          current: currentName,
          faces: (scanState.faces || 0) + result.faces.length,
        });
      } catch (error) {
        failed += 1;
        logger?.warn?.(`[face] 扫描失败 ${candidate.path}: ${error.message}`);
        update({ done, current: currentName, failed });
      }

      // 每张照片都让出一次事件循环，避免长时间扫描让窗口「转菊花」
      await new Promise((resolve) => setImmediate(resolve));
    }

    update({ phase: 'grouping' });
    assignFaces(current, newFaces);
    await saveIndex();
    const stats = await statsOf(current);

    scanState = {
      isScanning: false,
      phase: token.aborted ? 'cancelled' : 'done',
      done,
      total: candidates.length,
      current: '',
      faces: stats.faces,
      failed,
    };
    emit('face-scan-progress', scanState);
    emit('face-scan-done', { ...stats, failed, skipped });
  }

  async function startScan(payload) {
    if (scanState.isScanning) throw new Error('正在识别中，请稍候');
    const candidates = normalizeCandidates(payload?.photos);
    if (candidates.length === 0) throw new Error('没有可识别的人像照片');

    const token = { aborted: false };
    scanToken = token;
    scanState = {
      isScanning: true,
      phase: 'preparing',
      done: 0,
      total: candidates.length,
      current: '',
      faces: 0,
      failed: 0,
    };

    runScan(candidates, token, Boolean(payload?.force))
      .catch((error) => {
        logger?.error?.(`[face] 扫描中断: ${error.message}`);
        scanState = {
          ...scanState,
          isScanning: false,
          phase: 'error',
        };
        emit('face-scan-progress', scanState);
        emit('face-scan-error', { message: error.message });
      })
      .finally(() => {
        if (scanToken === token) scanToken = null;
      });

    return { started: true, total: candidates.length };
  }

  function cancelScan() {
    if (!scanToken) return false;
    scanToken.aborted = true;
    return true;
  }

  // ---------------------------------------------------------------- 人物查询

  async function listPeople() {
    const current = await loadIndex();
    const byPerson = new Map();
    for (const [key, personId] of Object.entries(current.assignments)) {
      const parsed = parseFaceKey(key);
      if (!parsed) continue;
      const face = current.entries[parsed.fileId]?.faces?.[parsed.index];
      if (!face) continue;
      if (!byPerson.has(personId)) byPerson.set(personId, { faces: [], fileIds: new Set() });
      const bucket = byPerson.get(personId);
      bucket.faces.push(face);
      bucket.fileIds.add(parsed.fileId);
    }

    const people = [];
    for (const person of current.people) {
      const bucket = byPerson.get(person.id);
      if (!bucket || bucket.faces.length === 0) continue;
      const cover = bucket.faces.find((face) => face.cover)?.cover || null;
      people.push({
        id: person.id,
        name: person.name || '',
        createdAt: person.createdAt || 0,
        faceCount: bucket.faces.length,
        photoCount: bucket.fileIds.size,
        coverUrl: cover ? `pm://local/face/${cover}` : null,
      });
    }

    people.sort((a, b) => b.photoCount - a.photoCount || a.createdAt - b.createdAt);
    return people;
  }

  async function personPhotos(personId) {
    const current = await loadIndex();
    const fileIds = new Map();
    for (const [key, assigned] of Object.entries(current.assignments)) {
      if (assigned !== personId) continue;
      const parsed = parseFaceKey(key);
      if (!parsed) continue;
      fileIds.set(parsed.fileId, (fileIds.get(parsed.fileId) || 0) + 1);
    }
    return [...fileIds.entries()].map(([fileId, faceCount]) => ({ fileId, faceCount }));
  }

  async function renamePerson(personId, name) {
    const current = await loadIndex();
    const person = current.people.find((item) => item.id === personId);
    if (!person) throw new Error('人物不存在');
    person.name = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
    await saveIndex();
    return { id: person.id, name: person.name };
  }

  async function mergePeople(targetId, sourceIds) {
    const current = await loadIndex();
    const target = current.people.find((item) => item.id === targetId);
    if (!target) throw new Error('目标人物不存在');
    const sources = new Set(
      (Array.isArray(sourceIds) ? sourceIds : []).filter((id) => id && id !== targetId)
    );
    if (sources.size === 0) throw new Error('请选择要合并的人物');

    let moved = 0;
    for (const [key, personId] of Object.entries(current.assignments)) {
      if (sources.has(personId)) {
        current.assignments[key] = targetId;
        moved += 1;
      }
    }
    current.people = current.people.filter((person) => !sources.has(person.id));
    const { buckets } = buildCentroids(current);
    for (const person of current.people) {
      person.faceCount = (buckets.get(person.id) || []).length;
    }
    await saveIndex();
    return { moved, targetId };
  }

  async function clearIndex() {
    index = emptyIndex();
    await saveIndex();
    await fs.promises.rm(modelStore.coverDir, { recursive: true, force: true });
    return { cleared: true };
  }

  // ---------------------------------------------------------------- IPC

  function registerIpc({ handle, ok }) {
    handle('face-status', async () => ok(await getStatus()));

    // 下载与扫描都走「立即返回 + 事件推送」，避免渲染层长时间挂起一个 invoke
    handle('face-model-download', async () => {
      if (modelStore.getStatus().state === 'downloading') {
        return ok({ started: false, reason: 'downloading' });
      }
      const task = modelStore.download((progress) => {
        emit('face-model-progress', progress);
      });
      task
        .then(() => {
          emit('face-model-progress', modelStore.getStatus());
          emit('face-status-changed');
        })
        .catch((error) => {
          emit('face-model-progress', modelStore.getStatus());
          emit('face-model-error', { message: error.message });
        });
      return ok({ started: true });
    });

    handle('face-model-cancel', async () => ok({ cancelled: modelStore.cancelDownload() }));

    handle('face-scan-start', async (event, payload) => ok(await startScan(payload)));
    handle('face-scan-cancel', async () => ok({ cancelled: cancelScan() }));

    handle('face-people-list', async () => ok(await listPeople()));
    handle('face-person-photos', async (event, personId) =>
      ok(await personPhotos(String(personId || '')))
    );
    handle('face-person-rename', async (event, payload) =>
      ok(await renamePerson(String(payload?.personId || ''), payload?.name))
    );
    handle('face-person-merge', async (event, payload) =>
      ok(await mergePeople(String(payload?.targetId || ''), payload?.sourceIds))
    );
    handle('face-index-clear', async () => ok(await clearIndex()));
  }

  return {
    registerIpc,
    getStatus,
    listPeople,
    personPhotos,
    renamePerson,
    mergePeople,
    clearIndex,
    startScan,
    cancelScan,
    getCoverDir: () => modelStore.coverDir,
    modelStore,
  };
}

module.exports = {
  createFaceService,
  INDEX_FILE,
  __test: { parseFaceKey, faceKey, emptyIndex, resolveThumbRef },
};
