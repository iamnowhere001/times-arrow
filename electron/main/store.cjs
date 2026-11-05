'use strict';

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { CONFIG_VERSION } = require('./migrations.cjs');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);
const copyFile = promisify(fs.copyFile);

function createStore({ userDataDir, logger }) {
  // ---------------------------------------------------------------------------
  // 本地 JSON 存储
  // - config.json：收藏 / 隐藏 / 标签 / 时间修正 / 智能相簿 / 视图偏好 / 窗口尺寸
  // - ai-cache.json：AI 分析结果（体量较大，单独成文件便于限量与清理）
  // - ai-config.json：AI 服务配置（API Key / Base URL / 模型），由应用内「AI 设置」写入
  // 都先写临时文件再 rename（原子替换），避免写入中途被打断而损坏整个文件。
  // ---------------------------------------------------------------------------
  const STORE_CONFIG = 'config.json';
  const STORE_AI_CACHE = 'ai-cache.json';
  const STORE_AI_CONFIG = 'ai-config.json';

  /** fileName → 解析后的对象（内存缓存，避免每次读盘） */
  const storeCache = new Map();

  function storePath(fileName) {
    return path.join(userDataDir, fileName);
  }

  /**
   * 存储损坏的通知队列。
   *
   * 损坏文件已经被改名留证（见 readStore），但**用户不知道** —— 他只会发现
   * 「我的相册/收藏没了」，既不知道原因，也不知道有备份可捞。
   * 这里把恢复事件攒起来，由渲染进程在启动后取走并提示一次。
   *
   * 用「取走即清空」而不是持续状态：这是一次性事件，反复提示只会变成噪音。
   */
  const storageNotices = [];

  /** 取出并清空待提示的存储恢复事件 */
  function drainStorageNotices() {
    const notices = storageNotices.splice(0, storageNotices.length);
    return notices;
  }

  async function readStore(fileName) {
    if (storeCache.has(fileName)) return storeCache.get(fileName);

    let data = {};
    try {
      const raw = await readFile(storePath(fileName), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch {
      // 首次运行或文件损坏：从空存储开始，不阻塞启动。
      // 但损坏文件要先挪开留证 —— 否则紧接着的任意一次写入就会把它整体覆盖，
      // 原本还有救的收藏 / 相簿 / 标签就真的没了。
      const backupPath = `${storePath(fileName)}.corrupt-${Date.now()}`;
      try {
        await rename(storePath(fileName), backupPath);
        // 只有真的挪成功了才算「损坏」：文件不存在（首次运行）不该提示用户
        storageNotices.push({
          file: fileName,
          backupPath,
          at: Date.now(),
        });
        logger.warn(`[store] ${fileName} 无法解析，已备份到 ${backupPath}`);
      } catch {
        // 文件本来就不存在（首次运行），无需处理
      }
    }
    storeCache.set(fileName, data);
    return data;
  }

  /**
   * 同名文件的写队列：把「读-改-写」串行化。
   *
   * 渲染进程有多处并发落盘（视频元数据 1.5s 防抖、偏好 600ms 防抖、收藏 / 标签 / 相簿即时写），
   * 不排队的话两次写入会共用同一个内存快照，后一次直接覆盖前一次的结果。
   */
  const storeWriteChains = new Map();
  let storeTmpSeq = 0;

  function withStoreLock(fileName, task) {
    const prev = storeWriteChains.get(fileName) ?? Promise.resolve();
    const next = prev.then(task);
    // 队列本身不能被上一次失败卡死：失败只影响调用方拿到的返回值
    storeWriteChains.set(
      fileName,
      next.catch(() => {})
    );
    return next;
  }

  /**
   * 写盘前滚动保留上一版 config.json。
   * 迁移 / 误写把配置改坏时，.bak 与 .bak.1 是最后一道可回退的副本。
   * 备份失败只告警，绝不阻断主写入：写不进配置比少一份备份严重得多。
   */
  async function rotateConfigBackup(target) {
    try {
      await fs.promises.access(target);
    } catch {
      return; // 首次运行，没有上一版可留
    }
    const bak = `${target}.bak`;
    const older = `${target}.bak.1`;
    try {
      // rename 到已存在目标在 POSIX 上是覆盖，无需先 unlink
      try {
        await rename(bak, older);
      } catch {
        /* 还没有上一版 .bak */
      }
      await copyFile(target, bak);
    } catch (error) {
      logger.warn('[store] config 备份轮转失败:', error.message);
    }
  }

  async function writeStore(fileName) {
    const target = storePath(fileName);
    if (fileName === STORE_CONFIG) await rotateConfigBackup(target);
    // 临时文件名必须唯一：固定 .tmp 会让两次并发写入互相截断
    //（后一次以 w 模式打开即清空前一次尚未落盘的内容）
    const tmp = `${target}.${process.pid}.${(storeTmpSeq += 1)}.tmp`;
    const payload = JSON.stringify(storeCache.get(fileName) ?? {}, null, 2);
    try {
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, target);
    } catch (error) {
      // 留下半截临时文件会持续占用磁盘，且下次启动不会被清理
      try {
        await unlink(tmp);
      } catch {
        /* 已被 rename 走，忽略 */
      }
      throw error;
    }
  }

  async function mergeStore(fileName, patch) {
    if (!patch || typeof patch !== 'object') return false;
    return withStoreLock(fileName, async () => {
      const store = await readStore(fileName);
      Object.assign(store, patch);
      await writeStore(fileName);
      return true;
    });
  }

  /** 同步读取已加载的配置（窗口尺寸等主进程内部数据用） */
  function currentConfig() {
    return storeCache.get(STORE_CONFIG) ?? {};
  }

  function registerStoreIpc({ handle, ok, fail }) {
    /**
     * 读取配置。
     * 注意这里的 fail-soft：配置文件损坏时返回空配置而不是 fail —— 配置读不出来
     * 不应该让应用起不来（用户会看到「图库打不开」而不是「配置坏了」，更难自救）。
     * 损坏本身记在日志里；「备份损坏文件并提示用户」是 P2 的独立事项。
     */
    handle('load-config', async () => {
      try {
        return ok(await readStore(STORE_CONFIG));
      } catch (error) {
        logger.warn('Failed to load config, falling back to empty:', error.message);
        return ok({});
      }
    });

    // 每次保存都直接落盘：写入量很小，但「改完就退出」不应丢数据
    handle('save-config', async (event, patch) => {
      if (!patch || typeof patch !== 'object') {
        return fail('无效的配置内容');
      }
      const saved = await mergeStore(STORE_CONFIG, patch);
      if (!saved) {
        return fail('配置保存失败');
      }
      return ok(true);
    });

    handle('load-ai-cache', async () => {
      try {
        return ok(await readStore(STORE_AI_CACHE));
      } catch (error) {
        // 与配置同理：AI 缓存只是可再生的加速数据，读不出来就当没有
        logger.warn('Failed to load AI cache, falling back to empty:', error.message);
        return ok({});
      }
    });

    // AI 结果由渲染进程整体维护（含条数上限），这里直接替换 entries
    handle('save-ai-cache', async (event, entries) => {
      const saved = await mergeStore(STORE_AI_CACHE, { version: CONFIG_VERSION, entries });
      if (!saved) {
        return fail('AI 缓存保存失败');
      }
      return ok(true);
    });
  }

  return {
    STORE_CONFIG,
    STORE_AI_CACHE,
    STORE_AI_CONFIG,
    storeCache,
    readStore,
    mergeStore,
    currentConfig,
    drainStorageNotices,
    withStoreLock,
    writeStore,
    registerStoreIpc,
  };
}

module.exports = { createStore };
