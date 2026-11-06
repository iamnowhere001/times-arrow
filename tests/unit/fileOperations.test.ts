import { afterEach, describe, expect, it } from 'vitest';
import { movePhotosToTrash } from '@/lib/fs/fileOperations';
import { makePhoto } from './fixtures';

/**
 * 删除分流的回归测试。
 *
 * 这里钉住的是一条曾经真实存在的缺陷：movePhotosToTrash 先把错误转译成中文，
 * 调用方再拿转译结果去匹配 ENOENT —— 原始错误码已经不在了，判定永远为 false，
 * 于是「文件已被外部删除」的条目被塞进重试集合，用户点重试只会再失败一次。
 */
function stubElectron(deleteFile: (path: string) => Promise<{ ok: boolean; error?: string }>) {
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { deleteFile },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('movePhotosToTrash 失败分流', () => {
  it('ENOENT 归入 gonePhotos，而不是可重试的失败项', async () => {
    stubElectron(async () => ({
      ok: false,
      error: "ENOENT: no such file or directory, unlink '/tmp/a.jpg'",
    }));

    const photo = makePhoto({ id: 'a', path: '/tmp/a.jpg' });
    const result = await movePhotosToTrash([photo]);

    expect(result.gonePhotos).toEqual([photo]);
    expect(result.failedPhotos).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.deletedIds.size).toBe(0);
  });

  it('权限错误归入可重试的失败项，并给出人话说明', async () => {
    stubElectron(async () => ({
      ok: false,
      error: "EACCES: permission denied, unlink '/tmp/b.jpg'",
    }));

    const photo = makePhoto({ id: 'b', path: '/tmp/b.jpg' });
    const result = await movePhotosToTrash([photo]);

    expect(result.gonePhotos).toHaveLength(0);
    expect(result.failedPhotos).toEqual([photo]);
    expect(result.errors[0]).toContain('没有访问权限');
    // 转译后不应再出现原始错误码，避免把内部路径 / 系统文案甩给用户
    expect(result.errors[0]).not.toContain('EACCES');
  });

  it('抛出的 ENOENT 同样按失效条目处理', async () => {
    stubElectron(async () => {
      throw new Error("ENOENT: no such file or directory, unlink '/tmp/c.jpg'");
    });

    const photo = makePhoto({ id: 'c', path: '/tmp/c.jpg' });
    const result = await movePhotosToTrash([photo]);

    expect(result.gonePhotos).toEqual([photo]);
    expect(result.failedPhotos).toHaveLength(0);
  });

  it('成功项、无路径项与失败项互不干扰', async () => {
    stubElectron(async (path) => {
      if (path.endsWith('ok.jpg')) return { ok: true };
      return { ok: false, error: "ENOSPC: no space left on device, unlink '/tmp/full.jpg'" };
    });

    const okPhoto = makePhoto({ id: 'ok', path: '/tmp/ok.jpg' });
    const fullPhoto = makePhoto({ id: 'full', path: '/tmp/full.jpg' });
    const pathless = makePhoto({ id: 'pathless', path: undefined });
    const result = await movePhotosToTrash([okPhoto, fullPhoto, pathless]);

    expect(result.deletedIds).toEqual(new Set(['ok', 'pathless']));
    expect(result.pathlessRemoved).toBe(1);
    expect(result.failedPhotos).toEqual([fullPhoto]);
    expect(result.errors[0]).toContain('磁盘空间不足');
    expect(result.gonePhotos).toHaveLength(0);
  });
});
