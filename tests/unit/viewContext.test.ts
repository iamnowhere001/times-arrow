import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MediaFilter } from '@/types';
import { createEmptyFilters } from '@/lib/filter/filters';
import { buildViewContext, navItemActive } from '@/lib/filter/viewContext';

/**
 * K20：同一个动作不能有两种结果。
 *
 * 钉住两件事：
 *   1. 侧栏高亮按「分类 / 媒体类型」两个独立维度判定，组合条件下不会整栏失去高亮；
 *   2. 搜索词与当前相簿必须出现在条件条里 —— 只有「看得见」才算规则统一。
 */

const nav = (category: string, filter: MediaFilter) => ({ category, filter });

describe('侧栏高亮：两个维度独立', () => {
  it('默认状态只有「所有照片」高亮', () => {
    expect(navItemActive(nav('all', 'all'), 'all', 'all')).toBe(true);
    expect(navItemActive(nav('favorites', 'all'), 'all', 'all')).toBe(false);
    expect(navItemActive(nav('all', 'video'), 'all', 'all')).toBe(false);
  });

  it('「收藏夹 + 视频」两项同时高亮（K20 的直接症状）', () => {
    expect(navItemActive(nav('favorites', 'all'), 'favorites', 'video')).toBe(true);
    expect(navItemActive(nav('all', 'video'), 'favorites', 'video')).toBe(true);
    expect(navItemActive(nav('all', 'all'), 'favorites', 'video')).toBe(false);
  });

  it('「已隐藏 + 截屏」同样两项高亮', () => {
    expect(navItemActive(nav('hidden', 'all'), 'hidden', 'screenshot')).toBe(true);
  });

  it('单独选媒体类型时只有该项高亮', () => {
    expect(navItemActive(nav('all', 'image'), 'all', 'image')).toBe(true);
    expect(navItemActive(nav('all', 'all'), 'all', 'image')).toBe(false);
    expect(navItemActive(nav('hidden', 'all'), 'all', 'image')).toBe(false);
  });

  it('单独选收藏夹时只有收藏夹高亮', () => {
    expect(navItemActive(nav('favorites', 'all'), 'favorites', 'all')).toBe(true);
    expect(navItemActive(nav('all', 'all'), 'favorites', 'all')).toBe(false);
  });
});

describe('条件条上下文', () => {
  const empty = createEmptyFilters();

  it('空视图：条件条不出现', () => {
    const ctx = buildViewContext({ filters: empty, searchQuery: '' });
    expect(ctx.active).toBe(false);
    expect(ctx.chips).toHaveLength(0);
  });

  it('只有搜索词也必须显示（旧实现整条隐藏，正是暗规则的来源）', () => {
    const ctx = buildViewContext({ filters: empty, searchQuery: '  旅行  ' });
    expect(ctx.active).toBe(true);
    expect(ctx.chips).toEqual([{ key: 'search', label: '搜索：旅行', kind: 'search' }]);
  });

  it('相簿与筛选按顺序出现在搜索词之后，且各自可清除', () => {
    const ctx = buildViewContext({
      filters: { ...empty, favoritesOnly: true },
      searchQuery: '海边',
      albumName: '周末',
    });
    expect(ctx.chips.map((c) => c.kind)).toEqual(['search', 'album', 'filter']);
    expect(ctx.chips[1].label).toBe('相簿：周末');
    expect(ctx.chips[2].patch).toBeDefined();
    expect(ctx.albumName).toBe('周末');
  });

  it('空白搜索词与空相簿名不产生 chip', () => {
    const ctx = buildViewContext({ filters: empty, searchQuery: '   ', albumName: '  ' });
    expect(ctx.active).toBe(false);
    expect(ctx.chips).toHaveLength(0);
  });
});

describe('入口规则统一（静态断言）', () => {
  it('点智能相簿不再清空搜索词', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/hooks/useSmartAlbums.ts'), 'utf8');
    const body = source.slice(
      source.indexOf('const handleSelectAlbum'),
      source.indexOf('const handleDeleteAlbum')
    );
    expect(body).not.toContain("setSearchQuery('')");
    expect(body).toContain('setFilters(normalizeFilters(album.filters))');
  });

  it('条件条接住了搜索词与相簿名', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/layout/ActiveFiltersBar.tsx'),
      'utf8'
    );
    expect(source).toContain('buildViewContext(');
    expect(source).toContain('onClearSearch');
    expect(source).toContain('onResetAll');
  });
});
