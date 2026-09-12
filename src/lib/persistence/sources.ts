/**
 * 图库来源（N8）：把「打开文件夹 / 添加文件」存为常驻入口，重启后据此重建图库。
 *
 * 本模块只做纯数据处理：结构校验、去重合并、旧配置迁移。
 * 落盘由 App 统一走 `savePersistedConfig`，可用性探测走主进程 `checkPaths`。
 */

import { LibrarySource, PersistedConfig } from '@/types';

/**
 * 来源条数上限：只防极端增长（每次导入都会新增来源记录），正常使用远低于此。
 * 超出时淘汰最久未使用的条目。
 */
export const SOURCE_LIMIT = 200;

/** 取路径末级名称；取不到时回退整条路径（用于侧栏展示与提示文案） */
export const basenameOfPath = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** 单个来源的结构校验：路径非空、类型合法、时间戳可兜底 */
function normalizeSource(raw: unknown): LibrarySource | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<LibrarySource>;
  if (typeof item.path !== 'string' || item.path.length === 0) return null;
  if (item.kind !== 'directory' && item.kind !== 'file') return null;

  const addedAt = typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) ? item.addedAt : 0;
  const lastOpenedAt =
    typeof item.lastOpenedAt === 'number' && Number.isFinite(item.lastOpenedAt)
      ? item.lastOpenedAt
      : addedAt;

  return { path: item.path, kind: item.kind, addedAt, lastOpenedAt };
}

/** 按 lastOpenedAt 降序（最近使用在前），并限制总条数 */
function sortAndTrim(list: LibrarySource[]): LibrarySource[] {
  return [...list].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, SOURCE_LIMIT);
}

/**
 * 读取配置里的常驻来源。
 *
 * 旧配置没有 `sources`：把「最近打开」的目录升级为文件夹来源（顺序即新旧），
 * 这样升级后的第一件事就是被询问「要不要恢复上次的图库」，而不是面对空列表。
 *
 * 注意：字段存在时即使是空数组也以它为准 —— 空数组表示用户显式清空过来源
 * （「清空照片列表」会写 `sources: []`），此时不能再从 `recentDirectories` 复活。
 */
export function readSourcesFromConfig(config: PersistedConfig): LibrarySource[] {
  const stored = Array.isArray(config.sources) ? config.sources : null;
  if (stored) {
    const seen = new Set<string>();
    const list: LibrarySource[] = [];
    for (const raw of stored) {
      const source = normalizeSource(raw);
      if (!source || seen.has(source.path)) continue;
      seen.add(source.path);
      list.push(source);
    }
    return sortAndTrim(list);
  }

  const legacy = Array.isArray(config.recentDirectories) ? config.recentDirectories : [];
  const fallbackAt = Date.now();
  const migrated: LibrarySource[] = [];
  const seen = new Set<string>();
  legacy.forEach((path, index) => {
    if (typeof path !== 'string' || path.length === 0 || seen.has(path)) return;
    seen.add(path);
    // 没有原始时间：按下标给一个递减的伪时间，保持旧列表顺序（新在前）
    const at = fallbackAt - index;
    migrated.push({ path, kind: 'directory', addedAt: at, lastOpenedAt: at });
  });
  return sortAndTrim(migrated);
}

/**
 * 合并一批来源（按路径去重）：已存在则更新 `lastOpenedAt`（刷新排序），
 * 不存在则追加。返回新数组；无实际变化（仅时间刷新之外的重复导入）也会刷新时间，
 * 因此调用方只应在「确实导入成功」后调用。
 */
export function upsertSources(
  list: LibrarySource[],
  incoming: Array<Pick<LibrarySource, 'path' | 'kind'>>,
  now: number = Date.now()
): LibrarySource[] {
  if (incoming.length === 0) return list;

  const byPath = new Map(list.map(source => [source.path, source]));
  for (const entry of incoming) {
    if (!entry.path) continue;
    const prev = byPath.get(entry.path);
    if (prev) {
      byPath.set(entry.path, { ...prev, kind: entry.kind, lastOpenedAt: now });
    } else {
      byPath.set(entry.path, { path: entry.path, kind: entry.kind, addedAt: now, lastOpenedAt: now });
    }
  }

  return sortAndTrim([...byPath.values()]);
}
