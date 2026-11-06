import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildGridLayout,
  findRowAt,
  photoAspect,
  CARD_CHROME_HEIGHT,
  CARD_PADDING,
  GRID_GAP,
  type GridRow,
} from '@/lib/grid/justifiedLayout';
import { makePhoto } from './fixtures';

/**
 * 网格行布局的几何不变式。
 *
 * 守的是一条会直接伤到浏览体验的边界：**行宽必须落在内容区里**。
 * 图库滚动容器带 p-4 左右内边距，早期直接拿 clientWidth 铺行，最右一张会越出
 * 内容区约 32px；卡片 hover 的 scale(1.005) 再补上几个亚像素，横向滚动条就出现了。
 * 另外 48px 行高下限曾让「窄窗口 + 超宽全景图」的行反超容器宽度。
 */
const ROOT = resolve(import.meta.dirname, '../..');
const readGrid = () => readFileSync(resolve(ROOT, 'src/components/grid/ImageGrid.tsx'), 'utf8');

const photo = (id: string, width = 4, height = 3) =>
  makePhoto({ id, dimensions: { width, height } });

/** 每行内容的右边界（最后一张卡片的右边缘） */
const rightEdge = (row: GridRow) => {
  const last = row.cells[row.cells.length - 1];
  return last.left + last.width;
};

/** 混合常见比例与极端比例，覆盖元数据回填前后的排列 */
const mixedItems = () => [
  photo('a', 4000, 3000),
  photo('b', 3000, 4000),
  photo('c', 5000, 1000),
  photo('d'), // dimensions 未回填，走 4:3 兜底
  photo('e', 1080, 2340), // 手机截屏
  photo('f', 1000, 200), // 超宽全景（会被钳到 5:1）
  photo('g', 100, 500), // 超长竖图（会被钳到 0.2:1）
  photo('h', 1600, 900),
];

describe('justified 行布局几何', () => {
  it('任意容器宽度 / 缩放档位下，每行右边界都不超过可用宽度', () => {
    const items = [...mixedItems(), ...mixedItems()];
    for (const width of [200, 320, 640, 868, 900, 1280, 1920]) {
      for (const targetRowHeight of [100, 200, 260, 400]) {
        const layout = buildGridLayout(items, width, targetRowHeight);
        expect(layout.rows.length).toBeGreaterThan(0);
        for (const row of layout.rows) {
          expect(rightEdge(row)).toBeLessThanOrEqual(width + 0.01);
          expect(row.height).toBeGreaterThan(0);
        }
      }
    }
  });

  it('满行恰好铺满内容区，末行不拉伸', () => {
    const width = 868; // 900 的 clientWidth 扣掉 p-4 之后的内容区宽度
    const items = Array.from({ length: 12 }, (_, i) => photo(`p${i}`, 3, 2));
    const layout = buildGridLayout(items, width, 200);

    expect(layout.rows.length).toBeGreaterThan(1);
    for (const row of layout.rows.slice(0, -1)) {
      expect(rightEdge(row)).toBeCloseTo(width, 5);
    }
    expect(rightEdge(layout.rows[layout.rows.length - 1])).toBeLessThanOrEqual(width + 0.01);
  });

  it('窄窗口 + 超宽全景图不会被 48px 行高下限撑出容器', () => {
    // 旧实现把行高钳到 48 后没有回算宽度：5:1 的图在 200px 容器里会占 242px。
    const items = Array.from({ length: 6 }, (_, i) => photo(`wide${i}`, 5000, 1000));
    const layout = buildGridLayout(items, 200, 100);
    for (const row of layout.rows) {
      expect(rightEdge(row)).toBeLessThanOrEqual(200.01);
    }
  });

  it('相邻图片净留白 4px（间距 2 + 两侧内边距各 1）', () => {
    expect(GRID_GAP + CARD_PADDING * 2).toBe(4);
    expect(CARD_CHROME_HEIGHT).toBe(CARD_PADDING * 2);

    const layout = buildGridLayout(mixedItems(), 900, 260);
    const row = layout.rows.find((r) => r.cells.length > 1);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.cells[1].left - (row.cells[0].left + row.cells[0].width)).toBeCloseTo(GRID_GAP, 5);
    expect(layout.rows[1].top - (layout.rows[0].top + layout.rows[0].height)).toBeCloseTo(
      CARD_CHROME_HEIGHT + GRID_GAP,
      5
    );
  });

  it('rowOfItem 与行内顺序对齐，totalHeight 收在最后一行底部', () => {
    const items = mixedItems();
    const layout = buildGridLayout(items, 900, 260);
    const allCells = layout.rows.flatMap((r) => r.cells.map((c) => c.photo.id));
    expect(allCells).toEqual(items.map((p) => p.id));
    items.forEach((p, i) => {
      expect(layout.rows[layout.rowOfItem[i]].cells.some((c) => c.photo.id === p.id)).toBe(true);
    });
    const last = layout.rows[layout.rows.length - 1];
    expect(layout.totalHeight).toBeCloseTo(last.top + last.height + CARD_CHROME_HEIGHT, 5);
  });

  it('空输入 / 零宽度不产生行', () => {
    expect(buildGridLayout([], 900, 200).rows).toEqual([]);
    expect(buildGridLayout([photo('a')], 0, 200).rows).toEqual([]);
  });

  it('findRowAt 返回 top <= y 的最后一行', () => {
    const layout = buildGridLayout(mixedItems(), 900, 260);
    for (let i = 0; i < layout.rows.length; i += 1) {
      expect(findRowAt(layout.rows, layout.rows[i].top)).toBe(i);
      expect(findRowAt(layout.rows, layout.rows[i].top + 1)).toBe(i);
    }
    expect(findRowAt(layout.rows, -1)).toBe(0);
    expect(findRowAt(layout.rows, Number.MAX_SAFE_INTEGER)).toBe(layout.rows.length - 1);
  });

  it('宽高比按极端值钳制，缺失尺寸走 4:3 兜底', () => {
    expect(photoAspect(photo('a', 1000, 100))).toBe(5);
    expect(photoAspect(photo('b', 100, 1000))).toBeCloseTo(0.2, 5);
    expect(photoAspect(makePhoto({ id: 'c' }))).toBeCloseTo(4 / 3, 5);
  });
});

describe('布局常量与渲染层的一致性（静态断言）', () => {
  it('CARD_PADDING 与 ImageCard 的 className 内边距一致', () => {
    const paddingClass: Record<number, string> = { 1: 'p-px', 2: 'p-0.5', 4: 'p-1' };
    expect(paddingClass[CARD_PADDING]).toBeDefined();
    expect(readGrid()).toContain(`items-center ${paddingClass[CARD_PADDING]} rounded-lg`);
  });

  it('滚动容器扣掉横向 padding 后再铺行，并显式关掉横向滚动', () => {
    const source = readGrid();
    expect(source).toContain('el.clientWidth - paddingX');
    expect(source).toContain('overflow-y-auto overflow-x-hidden');
    expect(source).not.toContain('setViewport({ width: el.clientWidth');
  });

  it('卡片间隙也算空白：布局容器绑定 contentRef 并参与空白点击判定', () => {
    // VirtualGrid 注释承诺「点击卡片间隙 → 取消选择」，但间隙的 target 是内层
    // 布局容器而非滚动容器；只认 currentTarget 时这条契约是落空的。
    const source = readGrid();
    expect(source).toContain('const contentRef = useRef<HTMLDivElement>(null)');
    expect(source).toContain('<div ref={contentRef} style={{ position:');
    expect(source).toContain('e.target === e.currentTarget || e.target === contentRef.current');
  });
});
