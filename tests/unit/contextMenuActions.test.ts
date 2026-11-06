import { describe, expect, it, vi } from 'vitest';
import { buildContextMenuActions, type ContextMenuActionsDeps } from '@/lib/contextMenuActions';
import type { ContextMenuItem } from '@/types/contextMenu';
import { makePhoto } from './fixtures';

/**
 * v0.6.2 批次 1（K13）：右键菜单的「作用域」必须说到做到。
 *
 * 原则 3「一个动作，一个明确结果」在这里落成三类断言：
 *   1. 菜单里的数字等于实际会处理的项目数；
 *   2. 会落空的动作不渲染（整组都是视频时不给导出、视频不给复制图片）；
 *   3. 单张语义的动作在多选时显式标「仅此张」，不冒充批量。
 */

const photoA = makePhoto({ id: 'a', name: 'a.jpg' });
const photoB = makePhoto({ id: 'b', name: 'b.jpg' });
const photoV = makePhoto({ id: 'v', name: 'v.mp4', type: 'video/mp4' });
const ALL = [photoA, photoB, photoV];

function makeDeps(overrides: Partial<ContextMenuActionsDeps> = {}): ContextMenuActionsDeps {
  return {
    contextPhoto: photoA,
    visibleCount: ALL.length,
    photoCount: ALL.length,
    selectedIds: new Set(['a']),
    getPhotoById: (id) => ALL.find((p) => p.id === id),
    onImport: vi.fn(),
    onSelectAllVisible: vi.fn(),
    onCheckDuplicates: vi.fn(),
    onClearList: vi.fn(),
    onOpenQuickLook: vi.fn(),
    onToggleFavorite: vi.fn(),
    onSetHidden: vi.fn(),
    onCopyImage: vi.fn(),
    onShowInFolder: vi.fn(),
    onCopyPath: vi.fn(),
    onOpenInEditor: vi.fn(),
    onExportSelected: vi.fn(),
    onMovePhotos: vi.fn(),
    onOpenAdjustDate: vi.fn(),
    onOpenRename: vi.fn(),
    onOpenDelete: vi.fn(),
    ...overrides,
  };
}

const labels = (items: ContextMenuItem[]) =>
  items.flatMap((item) => (item.label ? [item.label] : []));
const findItem = (items: ContextMenuItem[], needle: string) =>
  items.find((item) => item.label?.includes(needle));

describe('右键菜单作用域（K13）', () => {
  it('单张图片：保持原有简洁文案，导出项存在', () => {
    const items = buildContextMenuActions(makeDeps());
    expect(labels(items)).toContain('收藏');
    expect(labels(items)).toContain('复制图片');
    expect(labels(items)).toContain('导出…');
    expect(labels(items)).not.toContain('删除 1 项');
  });

  it('2 图 + 1 视频：导出只报图片数并说明跳过视频', () => {
    const items = buildContextMenuActions(makeDeps({ selectedIds: new Set(['a', 'b', 'v']) }));
    expect(labels(items)).toContain('导出 2 张图片（跳过 1 个视频）');
    expect(labels(items)).toContain('重命名 3 项…');
    expect(labels(items)).toContain('删除 3 项');
    expect(labels(items)).toContain('移动 3 项到…');
  });

  it('多选时单张语义的动作显式标「仅此张」', () => {
    const items = buildContextMenuActions(makeDeps({ selectedIds: new Set(['a', 'b', 'v']) }));
    for (const label of ['打开 · 仅此张', '复制图片 · 仅此张', '在访达中显示 · 仅此张']) {
      expect(labels(items)).toContain(label);
    }
  });

  it('注入批量收藏后：文案标真实数量，点击作用于整组', () => {
    const onToggleFavoriteMany = vi.fn();
    const onToggleFavorite = vi.fn();
    const items = buildContextMenuActions(
      makeDeps({
        selectedIds: new Set(['a', 'b', 'v']),
        onToggleFavoriteMany,
        onToggleFavorite,
      })
    );
    expect(labels(items)).toContain('收藏 3 项');
    findItem(items, '收藏 3 项')?.onClick?.();
    expect(onToggleFavoriteMany).toHaveBeenCalledWith(
      expect.arrayContaining(['a', 'b', 'v']),
      true
    );
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });

  it('未注入批量收藏时：不谎报数量，只改右键这一张', () => {
    const onToggleFavorite = vi.fn();
    const items = buildContextMenuActions(
      makeDeps({ selectedIds: new Set(['a', 'b']), onToggleFavorite })
    );
    expect(labels(items)).toContain('收藏 · 仅此张');
    expect(labels(items)).not.toContain('收藏 2 项');
    findItem(items, '收藏 · 仅此张')?.onClick?.();
    expect(onToggleFavorite).toHaveBeenCalledWith('a');
  });

  it('整组已收藏时点击是取消收藏', () => {
    const onToggleFavoriteMany = vi.fn();
    const favorited = ALL.map((p) => ({ ...p, isFavorite: true }));
    const items = buildContextMenuActions(
      makeDeps({
        selectedIds: new Set(['a', 'b', 'v']),
        getPhotoById: (id) => favorited.find((p) => p.id === id),
        onToggleFavoriteMany,
      })
    );
    expect(labels(items)).toContain('取消收藏 3 项');
    findItem(items, '取消收藏 3 项')?.onClick?.();
    expect(onToggleFavoriteMany).toHaveBeenCalledWith(expect.any(Array), false);
  });

  it('右键视频、选中集含图片：导出项仍要出现（原来整项消失）', () => {
    const items = buildContextMenuActions(
      makeDeps({ contextPhoto: photoV, selectedIds: new Set(['a', 'b', 'v']) })
    );
    expect(labels(items)).toContain('导出 2 张图片（跳过 1 个视频）');
    expect(labels(items)).not.toContain('复制图片');
  });

  it('整组都是视频：不渲染导出（不显示会落空的动作）', () => {
    const items = buildContextMenuActions(
      makeDeps({ contextPhoto: photoV, selectedIds: new Set(['v']) })
    );
    expect(labels(items).some((label) => label.startsWith('导出'))).toBe(false);
    expect(labels(items)).not.toContain('复制图片');
  });

  it('移动项把整组照片交给回调，而不是只给右键那一张', () => {
    const onMovePhotos = vi.fn();
    const items = buildContextMenuActions(
      makeDeps({ selectedIds: new Set(['a', 'b', 'v']), onMovePhotos })
    );
    findItem(items, '移动 3 项')?.onClick?.();
    expect(onMovePhotos).toHaveBeenCalledWith(expect.arrayContaining([photoA, photoB, photoV]));
  });

  it('空白区右键只给图库级动作', () => {
    const items = buildContextMenuActions(makeDeps({ contextPhoto: null }));
    expect(labels(items)).toContain('导入图片、视频或文件夹…');
    expect(labels(items)).toContain('全选');
    expect(labels(items).some((label) => label.includes('删除'))).toBe(false);
  });
});
