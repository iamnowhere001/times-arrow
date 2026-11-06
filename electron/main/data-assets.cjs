'use strict';

/**
 * 本文件里的 IO 循环一律刻意串行，因此统一关闭 no-await-in-loop：
 *   - 回收站匹配必须「找到即停」，并发反而会误伤同名候选；
 *   - 目录遍历串行是为了控制同时打开的文件句柄数；
 *   - 备份串行是为了按文件顺序回报进度，并且不与用户的其他磁盘操作抢 IO。
 */
/* eslint-disable no-await-in-loop */

/**
 * 「数据资产」专项的主进程 IPC 集合。
 *
 * 一组能力，一个共同目标：用户的标注与文件不该因为路径变化或误操作而丢失。
 * 集中在同一模块里，是为了让所有「接收渲染层路径」的入口集中做白名单校验 ——
 * 这是本项目的安全约定，散到多个文件里最容易漏。
 *
 * 包含：内容指纹、配置导出 / 导入、路径重连、操作日志与撤销、按原目录增量备份。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { computeFileFingerprints } = require('../lib/fingerprint.cjs');
const { CONFIG_VERSION } = require('./migrations.cjs');

const STORE_CONFIG = 'config.json';
const STORE_AI_CACHE = 'ai-cache.json';
const LOG_FILE = 'operation-log.jsonl';
const LOG_LIMIT = 2000;
const MAX_BACKUP_DEPTH = 12;

function orphanEntries(orphans, rekey) {
  const items = [];
  for (const [field, value] of Object.entries(orphans ?? {})) {
    if (Array.isArray(value)) {
      for (const old of value) {
        const next = rekey(old);
        if (next) items.push({ field, old, next, isArray: true });
      }
    } else {
      for (const [old, record] of Object.entries(value ?? {})) {
        const next = rekey(old);
        if (next) items.push({ field, old, next, record, isArray: false });
      }
    }
  }
  return items;
}

function createDataAssets({
  handle,
  ok,
  fail,
  isPathAuthorized,
  logger,
  dialog,
  store,
  userDataDir,
  send,
}) {
  const { readStore, mergeStore } = store;
  const logPath = path.join(userDataDir, LOG_FILE);

  // -------------------------------------------------------------------------
  // 操作日志：追加式 jsonl，撤销另写一行而不是改写历史
  // -------------------------------------------------------------------------
  async function appendOperation(entry) {
    try {
      await fs.promises.mkdir(userDataDir, { recursive: true });
      const line = JSON.stringify({ id: crypto.randomUUID(), at: Date.now(), ...entry }) + '\n';
      await fs.promises.appendFile(logPath, line, 'utf8');

      // 按条数上限滚动：临时文件 + rename，避免中途断电留下半截日志
      const raw = await fs.promises.readFile(logPath, 'utf8').catch(() => '');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length > LOG_LIMIT) {
        const tmp = `${logPath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, lines.slice(-LOG_LIMIT).join('\n') + '\n', 'utf8');
        await fs.promises.rename(tmp, logPath);
      }
      return true;
    } catch (error) {
      // 日志写失败绝不能阻断已完成的文件操作
      logger?.warn?.('[operations] 写入操作日志失败:', error.message);
      return false;
    }
  }

  /** 供 main.js 的文件操作 handler 埋点；内部吞掉所有异常 */
  const recordOperation = appendOperation;

  async function listOperations({ offset = 0, limit = 50, type = 'all' } = {}) {
    const raw = await fs.promises.readFile(logPath, 'utf8').catch(() => '');
    const all = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const undone = new Set(all.filter((e) => e.type === 'undo' && e.target).map((e) => e.target));
    const ops = all
      .filter((e) => e.type !== 'undo')
      .reverse()
      .map((e) => ({ ...e, undone: undone.has(e.id) }));
    const filtered = type === 'all' ? ops : ops.filter((e) => e.type === type);
    return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  /**
   * 撤销删除：Electron 的 shell.trashItem 是单向的，没有「取回」API。
   * macOS 上回收站就是 ~/.Trash，按 文件名 + size + mtime 三重校验后 rename 回原位；
   * 找不到就明确报错，绝不静默假装成功，也绝不覆盖原位置已有的文件。
   */
  async function restoreFromTrash(op) {
    if (process.platform !== 'darwin') {
      return fail('自动取回目前仅支持 macOS，请在系统回收站中手动找回');
    }
    const trashDir = path.join(os.homedir(), '.Trash');
    const base = path.basename(op.from);
    const names = await fs.promises.readdir(trashDir).catch(() => null);
    if (!names) return fail('无法读取系统回收站');

    for (const name of names) {
      // 同名冲突时 macOS 会给回收站里的文件加后缀
      if (name !== base && !name.startsWith(`${base} `)) continue;
      const candidate = path.join(trashDir, name);
      const stat = await fs.promises.stat(candidate).catch(() => null);
      if (!stat?.isFile()) continue;
      if (op.size && stat.size !== op.size) continue;
      if (op.mtime && Math.abs(stat.mtimeMs - op.mtime) > 5000) continue;
      if (fs.existsSync(op.from)) {
        return fail('原位置已有同名文件，为避免覆盖未自动取回');
      }
      await fs.promises.rename(candidate, op.from);
      return null;
    }
    return fail('回收站里未找到匹配的文件（可能已被清空或改名），请手动取回');
  }

  async function undoOperation(id) {
    const { entries } = await listOperations({ offset: 0, limit: LOG_LIMIT, type: 'all' });
    const op = entries.find((e) => e.id === id);
    if (!op) return fail('找不到这条操作记录');
    if (op.undone) return fail('这条操作已经撤销过了');

    if (op.type === 'rename') {
      if (!isPathAuthorized(op.from) || !isPathAuthorized(op.to)) {
        return fail('路径不在当前会话的授权范围内，请先重新导入该目录');
      }
      if (!fs.existsSync(op.to)) return fail('改名后的文件已不在原处，无法自动改回');
      if (fs.existsSync(op.from)) return fail('原文件名已被占用，为避免覆盖未自动改回');
      await fs.promises.rename(op.to, op.from);
      await appendOperation({ type: 'undo', target: id, result: 'renamed-back' });
      return ok({ path: op.from });
    }

    if (op.type === 'delete') {
      if (!isPathAuthorized(op.from)) {
        return fail('原路径不在当前会话的授权范围内，请先重新导入该目录');
      }
      const error = await restoreFromTrash(op);
      if (error) return error;
      await appendOperation({ type: 'undo', target: id, result: 'restored' });
      return ok({ path: op.from });
    }

    return fail(`${op.type} 类型的操作暂不支持自动撤销，请按日志里的路径手工处理`);
  }

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------
  handle('compute-file-ids', async (event, paths) => {
    if (!Array.isArray(paths)) return fail('无效的路径列表');
    const allowed = paths.filter((p) => typeof p === 'string' && p && isPathAuthorized(p));
    if (allowed.length === 0) return ok({});
    return ok(await computeFileFingerprints(allowed, 8));
  });

  /** 导出配置：只带用户数据，刻意不含 ai-config.json（里面是明文密钥） */
  handle('export-config', async () => {
    const config = await readStore(STORE_CONFIG);
    const aiCache = await readStore(STORE_AI_CACHE);
    const chosen = await dialog.showSaveDialog({
      title: '导出时光画框配置',
      defaultPath: '时光画框-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (chosen.canceled || !chosen.filePath) return ok(null);

    const payload = {
      // 格式标识，不是显示名：v0.6.1 及更早导出的配置里写的就是 'PhotoMinder'，
      // 改掉会让用户已有的备份全部无法导入。界面文案统一为「时光画框」不影响这里。
      app: 'PhotoMinder',
      exportedAt: new Date().toISOString(),
      version: CONFIG_VERSION,
      config,
      aiCache,
      note: '不含 AI 设置里的 API Key；导入后需重新填写。',
    };
    await fs.promises.writeFile(chosen.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return ok({ path: chosen.filePath });
  });

  /** 导入配置：二次确认 + 完整替换主要分段；当前配置已由 .bak 轮转留底 */
  handle('import-config', async () => {
    const chosen = await dialog.showOpenDialog({
      title: '导入时光画框配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (chosen.canceled || !chosen.filePaths?.[0]) return ok(null);

    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(chosen.filePaths[0], 'utf8'));
    } catch {
      return fail('文件不是有效的 JSON');
    }
    if (
      !payload ||
      // 见 export-config：'PhotoMinder' 是历史导出文件的格式标识，不能随显示名改
      payload.app !== 'PhotoMinder' ||
      !payload.config ||
      typeof payload.config !== 'object'
    ) {
      return fail('这不是时光画框导出的配置文件');
    }

    const answer = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '导入并覆盖'],
      defaultId: 0,
      cancelId: 0,
      message:
        '导入会覆盖当前的收藏 / 标签 / 相簿 / 来源等设置；当前配置已自动备份为 config.json.bak。确定继续？',
    });
    if (answer.response !== 1) return ok(null);

    const src = payload.config;
    await mergeStore(STORE_CONFIG, {
      version: CONFIG_VERSION,
      favorites: src.favorites ?? [],
      hidden: src.hidden ?? [],
      tags: src.tags ?? {},
      dateOverrides: src.dateOverrides ?? {},
      videoMeta: src.videoMeta ?? {},
      albums: src.albums ?? [],
      sources: src.sources ?? [],
      preferences: src.preferences ?? {},
      duplicate: src.duplicate ?? {},
      orphans: src.orphans ?? {},
    });
    if (payload.aiCache) {
      await mergeStore(STORE_AI_CACHE, {
        version: CONFIG_VERSION,
        entries: payload.aiCache.entries ?? {},
        orphans: payload.aiCache.orphans ?? {},
      });
    }
    return ok({ path: chosen.filePaths[0], needReload: true });
  });

  /** 路径重连面板的数据：来源可用性 + 待续接的孤儿记录数 */
  handle('get-relink-candidates', async () => {
    const config = await readStore(STORE_CONFIG);
    const sources = (config.sources ?? []).filter((s) => s && typeof s.path === 'string');
    const list = await Promise.all(
      sources.map(async (s) => ({
        path: s.path,
        kind: s.kind,
        available: await fs.promises
          .access(s.path)
          .then(() => true)
          .catch(() => false),
      }))
    );
    const orphans = config.orphans ?? {};
    const orphanCount = Object.values(orphans).reduce(
      (n, v) => n + (Array.isArray(v) ? v.length : Object.keys(v ?? {}).length),
      0
    );
    return ok({ sources: list, orphanCount });
  });

  /**
   * 把某个来源从 oldRoot 重连到 newRoot：
   * 改 sources 路径，并把 orphans 里该前缀下的旧记录按新路径重算指纹、写回主字段。
   * 冲突（同一 id 已有记录）保留现值并计数，不静默覆盖。
   */
  handle('relink-source', async (event, oldRoot, newRoot) => {
    if (typeof oldRoot !== 'string' || typeof newRoot !== 'string' || !oldRoot || !newRoot) {
      return fail('无效的目录路径');
    }
    if (!isPathAuthorized(newRoot)) {
      return fail('目标目录尚未授权，请先通过「选择目录」选中它');
    }

    const config = await readStore(STORE_CONFIG);
    const sources = (config.sources ?? []).map((s) =>
      s.path === oldRoot ? { ...s, path: newRoot } : s
    );
    const rekey = (p) =>
      p === oldRoot || p.startsWith(oldRoot + path.sep) ? newRoot + p.slice(oldRoot.length) : null;

    const orphans = JSON.parse(JSON.stringify(config.orphans ?? {}));
    const items = orphanEntries(orphans, rekey);
    const ids = await computeFileFingerprints(
      items.map((x) => x.next),
      8
    );

    const patch = { version: CONFIG_VERSION, sources };
    const ensure = (field) => {
      if (patch[field]) return;
      patch[field] =
        field === 'favorites' || field === 'hidden'
          ? [...(config[field] ?? [])]
          : { ...(config[field] ?? {}) };
    };
    const adopted = { count: 0, conflicts: 0, unresolved: 0 };

    for (const item of items) {
      const id = ids[item.next];
      if (!id) {
        adopted.unresolved += 1;
        continue;
      }
      ensure(item.field);
      const bucket = patch[item.field];
      if (item.isArray) {
        if (bucket.includes(id)) adopted.conflicts += 1;
        else bucket.push(id);
        orphans[item.field] = (orphans[item.field] ?? []).filter((p) => p !== item.old);
      } else {
        if (id in bucket) adopted.conflicts += 1;
        else bucket[id] = item.record;
        if (orphans[item.field]) delete orphans[item.field][item.old];
      }
      adopted.count += 1;
    }
    patch.orphans = orphans;
    await mergeStore(STORE_CONFIG, patch);
    return ok(adopted);
  });

  handle('get-operation-log', async (event, query) => ok(await listOperations(query ?? {})));
  handle('undo-operation', async (event, id) => undoOperation(id));

  // -------------------------------------------------------------------------
  // F10 按原目录结构增量备份
  // -------------------------------------------------------------------------
  let backupRunning = false;
  let backupCancelled = false;

  async function walk(dir, depth, out) {
    if (depth > MAX_BACKUP_DEPTH) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1, out);
      else if (entry.isFile()) out.push(full);
    }
  }

  handle('start-backup', async (event, targetDir) => {
    if (backupRunning) return fail('已有备份任务在进行中');
    if (typeof targetDir !== 'string' || !targetDir || !isPathAuthorized(targetDir)) {
      return fail('目标目录无效或尚未授权');
    }
    const config = await readStore(STORE_CONFIG);
    const roots = (config.sources ?? [])
      .filter((s) => s && s.kind === 'directory' && typeof s.path === 'string')
      .map((s) => s.path);
    if (roots.length === 0) return fail('没有可备份的目录来源');

    backupRunning = true;
    backupCancelled = false;
    const files = [];
    try {
      for (const root of roots) {
        if (
          !(await fs.promises
            .access(root)
            .then(() => true)
            .catch(() => false))
        )
          continue;
        const found = [];
        await walk(root, 0, found);
        for (const src of found) {
          // 保留原目录结构：备份根下按来源目录名分一层，再跟相对路径
          files.push({ src, rel: path.join(path.basename(root), path.relative(root, src)) });
        }
      }

      const result = { total: files.length, copied: 0, skipped: 0, failed: 0, cancelled: false };
      for (let i = 0; i < files.length; i += 1) {
        if (backupCancelled) {
          result.cancelled = true;
          break;
        }
        const { src, rel } = files[i];
        const dest = path.join(targetDir, rel);
        try {
          const st = await fs.promises.stat(src);
          let skip = false;
          const dt = await fs.promises.stat(dest).catch(() => null);
          if (dt) skip = dt.size === st.size && Math.abs(dt.mtimeMs - st.mtimeMs) < 1000;
          if (skip) {
            result.skipped += 1;
          } else {
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            await fs.promises.copyFile(src, dest);
            result.copied += 1;
          }
        } catch (error) {
          result.failed += 1;
          logger?.warn?.('[backup] 复制失败:', src, error.message);
        }
        send('backup-progress', { ...result, done: i + 1, current: rel });
      }
      return ok(result);
    } finally {
      backupRunning = false;
    }
  });

  handle('cancel-backup', async () => {
    backupCancelled = true;
    return ok(true);
  });

  return { recordOperation };
}

module.exports = { createDataAssets };
