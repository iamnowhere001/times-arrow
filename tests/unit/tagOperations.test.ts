import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyTagOperation,
  normalizeTag,
  planBatchTagChange,
  rankTags,
  suggestTags,
  tagCoverage,
} from '@/lib/tags/tagOperations';
import { makePhoto } from './fixtures';

/**
 * v0.7.0 第一批：批量标签（D9）。
 *
 * 最容易出错的不是「加个标签」，而是：只改真正需要改的照片（否则撤销会误伤）、
 * 以及建议 / 侧栏 / 覆盖统计共用同一份频次口径。
 */

const shot = (id: string, tags: string[], fileId = `fid-${id}`) =>
  makePhoto({ id, fileId, tags, name: `${id}.jpg` });

describe('标签输入与单张操作', () => {
  it('去掉空白与用户习惯性敲的 # 前缀', () => {
    expect(normalizeTag('  ##旅行  ')).toBe('旅行');
    expect(normalizeTag('   ')).toBe('');
  });

  it('添加时去重，移除时只删同名，无变化时内容不变', () => {
    expect(applyTagOperation(['旅行'], { kind: 'add', tag: '旅行' })).toEqual(['旅行']);
    expect(applyTagOperation(['旅行'], { kind: 'add', tag: '#家人' })).toEqual(['旅行', '家人']);
    expect(applyTagOperation(['旅行', '家人'], { kind: 'remove', tag: '家人' })).toEqual(['旅行']);
    expect(applyTagOperation(['旅行'], { kind: 'remove', tag: '不存在' })).toEqual(['旅行']);
    expect(applyTagOperation(['旅行'], { kind: 'add', tag: '   ' })).toEqual(['旅行']);
  });
});

describe('批量变更规划', () => {
  const photos = [shot('a', ['旅行']), shot('b', []), shot('c', ['旅行', '家人'])];
  const keyOf = (p: { fileId?: string }) => p.fileId ?? '';

  it('只有真正变化的照片进变更集，before 保留用于精确撤销', () => {
    const changes = planBatchTagChange(photos, { kind: 'add', tag: '#旅行' }, keyOf);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: 'b',
      key: 'fid-b',
      before: [],
      after: ['旅行'],
    });
  });

  it('移除时只命中含该标签的照片', () => {
    const changes = planBatchTagChange(photos, { kind: 'remove', tag: '旅行' }, keyOf);
    expect(changes.map((c) => c.id)).toEqual(['a', 'c']);
    expect(changes[1].before).toEqual(['旅行', '家人']);
    expect(changes[1].after).toEqual(['家人']);
  });

  it('空标签或全是空操作时返回空集，不产生无意义的写盘', () => {
    expect(planBatchTagChange(photos, { kind: 'add', tag: '  ' }, keyOf)).toEqual([]);
    expect(planBatchTagChange([shot('a', ['旅行'])], { kind: 'add', tag: '旅行' }, keyOf)).toEqual(
      []
    );
  });
});

describe('频次统计与建议', () => {
  const photos = [
    shot('a', ['旅行', '家人']),
    shot('b', ['旅行']),
    shot('c', ['家人']),
    shot('d', ['海边']),
  ];

  it('按频次降序，同频按名称排序', () => {
    expect(rankTags(photos)).toEqual([
      { name: '家人', count: 2 },
      { name: '旅行', count: 2 },
      { name: '海边', count: 1 },
    ]);
  });

  it('输入建议优先匹配包含关系并排除完全相同的输入', () => {
    const ranked = rankTags(photos);
    expect(suggestTags(ranked, '旅').map((t) => t.name)).toEqual(['旅行']);
    expect(suggestTags(ranked, '旅行')).toEqual([]);
    expect(suggestTags(ranked, '')).toHaveLength(3);
  });

  it('tagCoverage 与 rankTags 同源（详情面板与侧栏不会出现两套数字）', () => {
    expect(tagCoverage(photos.slice(0, 2))).toEqual(rankTags(photos.slice(0, 2)));
  });
});

describe('多选面板不再只读（静态断言）', () => {
  it('DetailsPane 多选分支挂载 BatchTagsPanel，侧栏有标签入口', () => {
    const details = readFileSync(
      resolve(process.cwd(), 'src/components/detail/DetailsPane.tsx'),
      'utf8'
    );
    expect(details).toContain('<BatchTagsPanel');
    const sidebar = readFileSync(
      resolve(process.cwd(), 'src/components/layout/Sidebar.tsx'),
      'utf8'
    );
    expect(sidebar).toContain('onSelectTag');
    expect(sidebar).toContain('rankedTags');
  });
});
