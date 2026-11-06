import { describe, expect, it } from 'vitest';
import { deriveEmptyStateCopy, type EmptyKind } from '@/lib/filter/libraryViewState';
import type { MediaFilter } from '@/types';

const base: { searchQuery: string; mediaFilter: MediaFilter; totalCount: number } = {
  searchQuery: '海边',
  mediaFilter: 'all',
  totalCount: 1204,
};

function copyOf(kind: EmptyKind, overrides: Partial<typeof base> = {}) {
  return deriveEmptyStateCopy({ ...base, kind, ...overrides });
}

describe('deriveEmptyStateCopy', () => {
  it('首屏引导导入，且不显示旁注', () => {
    const copy = copyOf('library');
    expect(copy.title).toBe('打开你的图库');
    expect(copy.action).toBe('import');
    expect(copy.hint).toBeUndefined();
  });

  it('搜索无结果时把关键词带进描述，动作为清除搜索', () => {
    const copy = copyOf('search');
    expect(copy.title).toBe('没有匹配的结果');
    expect(copy.description).toContain('「海边」');
    expect(copy.action).toBe('clearSearch');
    expect(copy.hint).toContain('1204');
  });

  it('「全部已隐藏」引导去已隐藏视图，且不显示旁注', () => {
    const copy = copyOf('allHidden');
    expect(copy.action).toBe('showHidden');
    expect(copy.actionLabel).toBe('查看「已隐藏」');
    expect(copy.hint).toBeUndefined();
  });

  it('筛选无结果时动作为清除筛选', () => {
    const copy = copyOf('filter');
    expect(copy.action).toBe('clearFilters');
    expect(copy.actionLabel).toBe('清除筛选');
  });

  it('媒体类型为空时文案跟随当前类型', () => {
    const copy = copyOf('media', { mediaFilter: 'video' });
    expect(copy.title).toBe('还没有视频');
    expect(copy.description).toContain('视频');
    expect(copy.action).toBe('showAllMedia');
  });

  it('收藏夹为空时引导回所有照片', () => {
    const copy = copyOf('favorites');
    expect(copy.action).toBe('showAll');
    expect(copy.actionLabel).toBe('前往「所有照片」');
  });

  it('已隐藏视图为空时没有主按钮', () => {
    expect(copyOf('hiddenEmpty').action).toBe('none');
  });
});
