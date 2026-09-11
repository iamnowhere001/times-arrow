/**
 * 轻量日志器（渲染进程）。
 * - debug / info 仅在开发构建输出，生产构建静默，避免把磁盘完整路径等调试信息带进发布产物；
 * - warn / error 始终输出，便于线上排查。
 */
const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
const isDev = env?.DEV ?? false;

type LogArgs = unknown[];

export const logger = {
  debug(...args: LogArgs): void {
    if (isDev) console.debug(...args);
  },
  info(...args: LogArgs): void {
    if (isDev) console.info(...args);
  },
  warn(...args: LogArgs): void {
    console.warn(...args);
  },
  error(...args: LogArgs): void {
    console.error(...args);
  },
};

export default logger;
