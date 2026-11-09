'use strict';

/**
 * 主进程崩溃记录（v1.0.0 · K4 剩余半边）。
 *
 * 此前 `uncaughtException` / `unhandledRejection` 只 `console.error` 到终端：
 * 用户双击打开的 DMG 没有终端，一次异常就等同于「应用某天悄悄坏了」——
 * 既没有证据，也没人知道发生过。这里补上两件事：
 *   1. 把异常落盘到 `crash-log.jsonl`（有上限，不会无限增长）；
 *   2. 同时写入 `crash-pending.json`，下次启动由渲染层取走并提示一次。
 *
 * 为什么记录必须同步：`uncaughtException` 之后进程状态已经不可信，
 * 异步写盘可能永远没有机会 flush。异常是低频事件，同步写可以接受。
 *
 * 隐私：日志只留在本机 userData，不上传、不埋点。消息与堆栈截断到固定长度，
 * 避免一条异常把磁盘写爆。
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = 'crash-log.jsonl';
const PENDING_FILE = 'crash-pending.json';
const LOG_LIMIT = 100;
const PENDING_LIMIT = 10;
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;

function toEntry(kind, error) {
  let message = '未知错误';
  let stack = '';

  if (error instanceof Error) {
    message = error.message || error.name || message;
    stack = error.stack ?? '';
  } else if (typeof error === 'string') {
    message = error;
  } else if (error !== undefined && error !== null) {
    try {
      message = JSON.stringify(error);
    } catch {
      // 循环引用 / BigInt 等无法序列化的值：退回 String，绝不让记录本身再抛一次
      message = String(error);
    }
  }

  return {
    at: Date.now(),
    kind,
    message: String(message).slice(0, MAX_MESSAGE),
    stack: String(stack).slice(0, MAX_STACK),
  };
}

/** 同目录临时文件 + rename，避免写到一半留下半截 JSON */
function writeAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function createCrashReporter({ userDataDir, logger }) {
  const logPath = path.join(userDataDir, LOG_FILE);
  const pendingPath = path.join(userDataDir, PENDING_FILE);

  function readLog() {
    try {
      const raw = fs.readFileSync(logPath, 'utf8');
      return raw
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
    } catch {
      return [];
    }
  }

  function readPending() {
    try {
      const parsed = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * 记录一条异常。**同步**写盘：调用点通常已经处于不可信的进程状态。
   * 记录失败只告警，绝不让「记录异常」本身再抛出一个异常。
   */
  function record(kind, error) {
    const entry = toEntry(kind, error);
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');

      const entries = readLog();
      if (entries.length > LOG_LIMIT) {
        const kept = entries.slice(-LOG_LIMIT);
        writeAtomic(logPath, `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`);
      }

      const pending = readPending();
      pending.push(entry);
      writeAtomic(pendingPath, JSON.stringify(pending.slice(-PENDING_LIMIT), null, 2));
    } catch (writeError) {
      logger?.warn?.('[crash] 写入崩溃日志失败:', writeError.message);
    }
    return entry;
  }

  /**
   * 取走待提示的异常（取走即清空）。
   *
   * 与存储损坏通知同一语义：这是「上次运行出过事」的一次性事件，
   * 反复提示只会变成噪音。清空失败时仍返回内容，宁可重复提示也别吞掉。
   */
  function drain() {
    const pending = readPending();
    if (pending.length > 0) {
      try {
        fs.unlinkSync(pendingPath);
      } catch {
        /* 文件已不存在 / 权限问题：下次启动会再次提示，不是坏事 */
      }
    }
    return pending;
  }

  /** 供「数据健康检查」使用的统计；不读取 pending，避免误清空待提示队列 */
  function stats() {
    const entries = readLog();
    return {
      entries: entries.length,
      lastAt: entries.length > 0 ? entries[entries.length - 1].at : null,
      path: logPath,
    };
  }

  return { record, drain, stats, logPath };
}

module.exports = { createCrashReporter, LOG_FILE, PENDING_FILE, LOG_LIMIT };
