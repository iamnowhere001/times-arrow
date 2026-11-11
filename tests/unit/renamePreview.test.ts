import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RenameOptions } from '@/types';
import {
  RENAME_PREVIEW_MAX_ROWS,
  applyRenameProbe,
  buildRenamePreview,
} from '@/lib/fs/renamePreview';
import { makePhoto, localTime } from './fixtures';

/**
 * K11：预览必须等于落盘结果。
 *
 * 这里钉住三件事：候选名规则、批内重名与磁盘同名是两套独立语义、
 * 以及主进程探测结果能按正确下标写回（错位下标比不校准更危险）。
 */

const baseOptions = (patch: Partial<RenameOptions> = {}): RenameOptions => ({
  mode: 'sequence',
  prefix: '照片_',
  startNumber: 1,
  numberPadding: 3,
  findText: '',
  replaceText: '',
  useRegex: false,
  dateFormat: 'yyyy-MM-dd_HHmmss',
  datePrefix: 'photo_',
  repair: {
    fixMojibake: true,
    stripJunkPrefix: true,
    stripCopyMarks: true,
    fallbackToDate: true,
    dateFormat: 'yyyy-MM-dd_HHmmss',
    datePrefix: 'photo_',
  },
  ...patch,
});

const photo = (id: string, name: string, taken: number, withPath = true) =>
  makePhoto({
    id,
    name,
    path: withPath ? `/库/2026/${name}` : undefined,
    dateTaken: taken,
  });

const shots = [
  photo('a', 'IMG_0001.JPG', localTime(2026, 1, 1)),
  photo('b', 'IMG_0002.JPG', localTime(2026, 1, 2)),
];

describe('预览生成', () => {
  it('按拍摄时间排序并保留原扩展名', () => {
    const preview = buildRenamePreview(shots, baseOptions());
    expect(preview.rows.map((r) => r.to)).toEqual(['照片_001.JPG', '照片_002.JPG']);
    expect(preview.error).toBeUndefined();
    expect(preview.changedCount).toBe(2);
    expect(preview.truncated).toBe(0);
  });

  it('批内重名追加 _1，与磁盘同名的 -1 是不同语义', () => {
    const collided = buildRenamePreview(
      [photo('a', 'alpha.JPG', 1), photo('b', 'beta.JPG', 2)],
      baseOptions({ mode: 'replace', useRegex: true, findText: '\\w+', replaceText: 'same' })
    );
    expect(collided.rows.map((r) => r.to)).toEqual(['same.JPG', 'same_1.JPG']);
    expect(collided.rows[0].adjusted).toBe(false);
    expect(collided.rows[1].adjusted).toBe(true);
  });

  it('同目录内同名才加序号，不同目录互不影响', () => {
    const a = photo('a', 'alpha.JPG', 1);
    const b = makePhoto({
      id: 'b',
      name: 'beta.JPG',
      path: '/库/别的目录/beta.JPG',
      dateTaken: 2,
    });
    const preview = buildRenamePreview(
      [a, b],
      baseOptions({ mode: 'replace', useRegex: true, findText: '\\w+', replaceText: 'same' })
    );
    expect(preview.rows.map((r) => r.to)).toEqual(['same.JPG', 'same.JPG']);
    expect(preview.rows.every((r) => !r.adjusted)).toBe(true);
  });

  it('非法文件名在预览阶段就报错，不会等到落盘', () => {
    const preview = buildRenamePreview(
      shots,
      baseOptions({ mode: 'replace', findText: 'IMG', replaceText: 'bad/name' })
    );
    expect(preview.error).toBeDefined();
    expect(preview.rows).toHaveLength(0);
  });

  it('拖放降级照片仍显示预览，但不进探测请求且下标不错位', () => {
    const photos = [
      photo('a', 'IMG_0001.JPG', 1),
      photo('drag', '拖入.jpg', 2, false),
      photo('b', 'IMG_0002.JPG', 3),
    ];
    const preview = buildRenamePreview(photos, baseOptions());
    expect(preview.rows).toHaveLength(3);
    expect(preview.plans).toHaveLength(2);
    expect(preview.plans.map((p) => p.index)).toEqual([0, 2]);
    expect(preview.plans.every((p) => p.oldPath && p.desiredPath)).toBe(true);
  });

  it('超过展示上限时 truncated 只影响显示，探测仍覆盖全部行', () => {
    const photos = Array.from({ length: 8 }, (_, i) => photo(`p${i}`, `IMG_${i}.JPG`, i + 1));
    const preview = buildRenamePreview(photos, baseOptions());
    expect(preview.rows).toHaveLength(8);
    expect(preview.plans).toHaveLength(8);
    expect(preview.truncated).toBe(8 - RENAME_PREVIEW_MAX_ROWS);
  });
});

describe('磁盘同名探测结果写回', () => {
  it('把 -1 序号写回对应行，并重算 changedCount', () => {
    const preview = buildRenamePreview(shots, baseOptions());
    const probed = applyRenameProbe(preview, preview.plans, [
      { finalName: '照片_001-1.JPG', conflicted: true },
      { finalName: '照片_002.JPG', conflicted: false },
    ]);
    expect(probed.rows[0].to).toBe('照片_001-1.JPG');
    expect(probed.rows[0].diskAdjusted).toBe(true);
    expect(probed.rows[0].desiredPath).toContain('照片_001-1.JPG');
    expect(probed.rows[1].diskAdjusted).toBe(false);
    expect(probed.changedCount).toBe(2);
    // 原对象不被就地修改（React 依赖引用变化来重渲染）
    expect(preview.rows[0].to).toBe('照片_001.JPG');
  });

  it('结果条数与请求对不上时原样返回，绝不按错位下标改名字', () => {
    const preview = buildRenamePreview(shots, baseOptions());
    const unchanged = applyRenameProbe(preview, preview.plans, [
      { finalName: '完全不相干.jpg', conflicted: false },
    ]);
    expect(unchanged).toBe(preview);
  });

  it('探测结果为原名时（改名到自身）不标记磁盘冲突', () => {
    const preview = buildRenamePreview([shots[0]], baseOptions());
    const probed = applyRenameProbe(preview, preview.plans, [
      { finalName: '照片_001.JPG', conflicted: false },
    ]);
    expect(probed.rows[0].diskAdjusted).toBe(false);
  });
});

describe('预览规则只有一处（静态断言）', () => {
  it('RenameModal 不再内联生成规则，组件提交与预览共用同一份 options', () => {
    const modal = readFileSync(
      resolve(process.cwd(), 'src/components/modal/RenameModal.tsx'),
      'utf8'
    );
    expect(modal).toContain('buildRenamePreview(photos, options)');
    expect(modal).toContain('onConfirm(options)');
    expect(modal).not.toContain('const sortByTakenTime');
    expect(modal).not.toContain('PREVIEW_MAX_ROWS =');
  });
});
