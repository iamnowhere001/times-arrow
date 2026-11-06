import { describe, expect, it } from 'vitest';
import { isAlbumNameTaken, isNameTaken, namesEqual } from '@/lib/album/albumNames';
import type { SmartAlbum } from '@/types';

/** v0.6.2 批次 1（K26）：相簿重名校验必须两处一致（保存弹窗 + hook 防御） */
describe('相簿名比较', () => {
  it('去首尾空格、忽略大小写', () => {
    expect(namesEqual(' 旅行 ', '旅行')).toBe(true);
    expect(namesEqual('Trip', 'trip')).toBe(true);
    expect(namesEqual('旅行', '家人')).toBe(false);
  });

  it('空名不参与查重', () => {
    expect(isNameTaken(['旅行'], '   ')).toBe(false);
  });
});

describe('相簿重名校验', () => {
  const albums = [
    { id: 'a', name: '旅行' },
    { id: 'b', name: '家人' },
  ] as SmartAlbum[];

  it('同名、带空格、大小写不同都算冲突', () => {
    expect(isAlbumNameTaken(albums, '旅行')).toBe(true);
    expect(isAlbumNameTaken(albums, '  旅行  ')).toBe(true);
    expect(
      isNameTaken(
        albums.map((a) => a.name),
        '旅行'
      )
    ).toBe(true);
  });

  it('不同名不冲突', () => {
    expect(isAlbumNameTaken(albums, '2024 旅行')).toBe(false);
  });

  it('重命名时排除自己，改名不变不算冲突', () => {
    expect(isAlbumNameTaken(albums, '旅行', 'a')).toBe(false);
    expect(isAlbumNameTaken(albums, 'Trip', 'a')).toBe(false);
  });

  it('重命名成别人的名字仍然冲突', () => {
    expect(isAlbumNameTaken(albums, '家人', 'a')).toBe(true);
    expect(isAlbumNameTaken(albums, ' 家人 ', 'a')).toBe(true);
  });
});
