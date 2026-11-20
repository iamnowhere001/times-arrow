import { describe, expect, it } from 'vitest';
import { isPathInLibrary, isSameOrInsideDir, normalizeDirPath } from '@/lib/persistence/sources';

/**
 * 路径包含关系的判定。
 *
 * 这几条不是「工具函数顺便测一下」，而是移动操作的直接依据：
 * 判错一个方向就会出两种相反的故障 ——
 * 把库外误判成库内，条目留在列表里点开 404；
 * 把库内误判成库外，用户整理完子目录回来发现照片全不见了。
 */

const dir = (path: string) => ({ path, kind: 'directory' as const });
const file = (path: string) => ({ path, kind: 'file' as const });

describe('normalizeDirPath', () => {
  it('去掉末尾分隔符并统一反斜杠', () => {
    expect(normalizeDirPath('/a/b/')).toBe('/a/b');
    expect(normalizeDirPath('C:\\a\\b\\')).toBe('C:/a/b');
  });

  it('根路径保持不变', () => {
    expect(normalizeDirPath('/')).toBe('/');
  });
});

describe('isSameOrInsideDir', () => {
  it('同目录为真', () => {
    expect(isSameOrInsideDir('/photos', '/photos')).toBe(true);
  });

  it('子目录为真', () => {
    expect(isSameOrInsideDir('/photos/2024/trip', '/photos')).toBe(true);
  });

  it('仅有相同前缀但不是子目录 → 假（否则 /photos-2023 会被当成 /photos 里面）', () => {
    expect(isSameOrInsideDir('/photos-2023/a.jpg', '/photos')).toBe(false);
    expect(isSameOrInsideDir('/photos-old', '/photos')).toBe(false);
  });

  it('父目录不是子目录', () => {
    expect(isSameOrInsideDir('/photos', '/photos/2024')).toBe(false);
  });

  it('末尾分隔符不影响判断', () => {
    expect(isSameOrInsideDir('/photos/2024/', '/photos/')).toBe(true);
  });

  it('反斜杠与正斜杠混用也能判对', () => {
    expect(isSameOrInsideDir('C:\\photos\\2024', 'C:/photos')).toBe(true);
  });

  it('根目录能匹配任意绝对路径', () => {
    expect(isSameOrInsideDir('/anything/here', '/')).toBe(true);
  });
});

describe('isPathInLibrary', () => {
  it('落在文件夹来源下 → 在库内', () => {
    expect(isPathInLibrary('/photos/trip', [dir('/photos')])).toBe(true);
  });

  it('落在所有来源之外 → 不在库内', () => {
    expect(isPathInLibrary('/Desktop/moved', [dir('/photos')])).toBe(false);
  });

  it('只要命中任一来源即可', () => {
    expect(isPathInLibrary('/backup/2024', [dir('/photos'), dir('/backup')])).toBe(true);
  });

  it('单文件来源不构成目录范围', () => {
    expect(isPathInLibrary('/photos/x.jpg', [file('/photos/x.jpg')])).toBe(false);
  });

  it('空来源列表 → 不在库内', () => {
    expect(isPathInLibrary('/photos', [])).toBe(false);
  });
});
