'use strict';

/**
 * 数据健康检查（v1.0.0）。
 *
 * 回答的是「我现在能不能安心把照片库交给它」：
 *   - 配置有没有备份、备份还能不能解析；
 *   - 迁移留下的 orphans 有多少，是否需要路径重连；
 *   - 缩略图缓存占了多少磁盘；
 *   - 上次迁移做了什么、有没有失败；
 *   - 崩溃日志里有没有未处理的事件。
 *
 * 全部只读，不发网络请求、不上报。检查结果里的路径只展示给本机用户。
 *
 * 本文件的目录遍历刻意在「每个 worker 内串行」：并发由外层 worker 数控制，
 * 这样打开的文件句柄数有上界，也不会让健康检查自己变成一次磁盘风暴。
 */
/* eslint-disable no-await-in-loop */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'config.json';
const BACKUP_FILES = ['config.json.bak', 'config.json.bak.1'];
const OPERATION_LOG = 'operation-log.jsonl';
const MIGRATION_REPORT = 'migration-report.json';
const CORRUPT_PREFIX = '.corrupt-';
const DIR_USAGE_CONCURRENCY = 32;

async function fileSummary(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return { exists: true, size: stat.size, mtime: stat.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtime: null };
  }
}

/** 备份能不能解析：不能解析的备份等于没有备份，必须让用户看见 */
function canParse(filePath) {
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** 目录用量：并发上限内统计文件数与字节数，避免上万缩略图逐个串行等待 */
async function dirUsage(dirPath) {
  let names;
  try {
    names = await fs.promises.readdir(dirPath);
  } catch {
    return { files: 0, bytes: 0 };
  }

  let files = 0;
  let bytes = 0;
  let index = 0;
  const worker = async () => {
    while (true) {
      const i = index;
      index += 1;
      if (i >= names.length) return;
      const stat = await fs.promises
        .stat(path.join(dirPath, names[i]))
        .catch(() => null);
      if (stat?.isFile()) {
        files += 1;
        bytes += stat.size;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DIR_USAGE_CONCURRENCY, names.length || 1) }, worker)
  );
  return { files, bytes };
}

/** 操作日志只数条数与最后时间：日志本身可能有上千行，不把内容带进健康报告 */
async function operationLogStats(logPath) {
  try {
    const raw = await fs.promises.readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    let lastAt = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const entry = JSON.parse(lines[i]);
        if (typeof entry.at === 'number') {
          lastAt = entry.at;
          break;
        }
      } catch {
        /* 单行损坏不影响整体统计 */
      }
    }
    return { entries: lines.length, lastAt, bytes: Buffer.byteLength(raw, 'utf8') };
  } catch {
    return { entries: 0, lastAt: null, bytes: 0 };
  }
}

function readMigrationReport(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, MIGRATION_REPORT), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 写入最近一次启动的迁移结果。
 * 失败不阻断启动：健康面板少一行信息，远好过因为报告写不进去而起不来。
 */
async function writeMigrationReport(userDataDir, result) {
  const target = path.join(userDataDir, MIGRATION_REPORT);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
  } catch {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* 已被 rename 走 */
    }
  }
}

function countOrphans(orphans) {
  return Object.values(orphans ?? {}).reduce(
    (n, value) => n + (Array.isArray(value) ? value.length : Object.keys(value ?? {}).length),
    0
  );
}

/** 损坏备份：config.json.corrupt-* / ai-cache.json.corrupt-* 等，最多列 5 个 */
async function corruptBackups(userDataDir) {
  let names;
  try {
    names = await fs.promises.readdir(userDataDir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.includes(CORRUPT_PREFIX)) continue;
    const summary = await fileSummary(path.join(userDataDir, name));
    found.push({ name, size: summary.size, mtime: summary.mtime });
  }
  return found.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(0, 5);
}

function createHealthCheck({ store, media, userDataDir, crashReporter, logger, thumbCacheLimit }) {
  async function buildReport() {
    const configPath = path.join(userDataDir, CONFIG_FILE);
    const config = await store.readStore(CONFIG_FILE);
    const configSummary = await fileSummary(configPath);

    const backups = [];
    for (const name of BACKUP_FILES) {
      const backupPath = path.join(userDataDir, name);
      const summary = await fileSummary(backupPath);
      backups.push({
        name,
        exists: summary.exists,
        size: summary.size,
        mtime: summary.mtime,
        parseOk: summary.exists ? canParse(backupPath) : null,
      });
    }

    const thumbDir = media.getThumbDir();
    const thumbUsage = await dirUsage(thumbDir);
    const logStats = await operationLogStats(path.join(userDataDir, OPERATION_LOG));
    const crashes = crashReporter.stats();
    const corrupt = await corruptBackups(userDataDir);
    const migration = readMigrationReport(userDataDir);
    const orphanCount = countOrphans(config.orphans);

    const warnings = [];
    if (configSummary.exists && !canParse(configPath)) {
      warnings.push('当前 config.json 无法解析（启动时会被备份并重置，建议先从备份恢复）');
    }
    for (const backup of backups) {
      if (backup.exists && backup.parseOk === false) {
        warnings.push(`${backup.name} 无法解析，不能作为恢复来源`);
      }
    }
    if (orphanCount > 0) {
      warnings.push(`有 ${orphanCount} 条标注等待路径重连（数据资产 → 路径重连）`);
    }
    if (corrupt.length > 0) {
      warnings.push(`存在 ${corrupt.length} 份损坏备份（config.json.corrupt-*），确认无用后可手动清理`);
    }
    if (crashes.entries > 0) {
      warnings.push(`崩溃日志里有 ${crashes.entries} 条记录，可在「打开日志」里查看`);
    }
    if (thumbUsage.files > thumbCacheLimit) {
      warnings.push(`缩略图缓存 ${thumbUsage.files} 个，超过上限 ${thumbCacheLimit} 个，启动时会自动修剪`);
    }
    if (migration?.error) {
      warnings.push(`上次启动的配置迁移失败：${migration.error}`);
    }

    return {
      checkedAt: Date.now(),
      config: {
        path: configPath,
        exists: configSummary.exists,
        size: configSummary.size,
        mtime: configSummary.mtime,
        parseOk: configSummary.exists ? canParse(configPath) : null,
        version: Number.isFinite(Number(config.version)) ? Number(config.version) : 0,
        backups,
      },
      orphans: orphanCount,
      thumbCache: {
        dir: thumbDir,
        files: thumbUsage.files,
        bytes: thumbUsage.bytes,
        limit: thumbCacheLimit,
      },
      operationLog: logStats,
      crashLog: crashes,
      migration,
      corruptBackups: corrupt,
      warnings,
    };
  }

  function registerIpc({ handle, ok, fail }) {
    handle('get-data-health', async () => {
      try {
        return ok(await buildReport());
      } catch (error) {
        logger?.warn?.('[health] 数据健康检查失败:', error.message);
        return fail(`健康检查失败：${error.message}`);
      }
    });
  }

  return { buildReport, registerIpc };
}

module.exports = {
  createHealthCheck,
  writeMigrationReport,
  MIGRATION_REPORT,
  CONFIG_FILE,
  BACKUP_FILES,
};
