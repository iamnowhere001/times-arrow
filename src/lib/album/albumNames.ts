import type { SmartAlbum } from '@/types';

/**
 * 智能相簿名称的唯一入口（v0.6.2 · K26）。
 *
 * 相簿名是用户手输的，保存与重命名两处都要查重；把比较规则收敛到这里，
 * 免得 UI 用 `===`、hook 用 `toLowerCase()`，出现「看着不重名其实撞了」。
 * 规则：去首尾空格 + 忽略大小写；空名不参与查重（由调用方拦下）。
 */

/** 两个相簿名是否等价 */
export function namesEqual(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/** 名称是否已在给定的名字列表里 */
export function isNameTaken(names: readonly string[], name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return names.some((existing) => namesEqual(existing, trimmed));
}

/** 名称是否已被别的相簿占用；excludeId 用于重命名时排除自己 */
export function isAlbumNameTaken(
  albums: readonly SmartAlbum[],
  name: string,
  excludeId?: string
): boolean {
  return isNameTaken(
    albums.filter((album) => album.id !== excludeId).map((album) => album.name),
    name
  );
}
