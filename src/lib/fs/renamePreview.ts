/**
 * 批量重命名的预览生成（K11）。
 *
 * 原先这段逻辑内联在 RenameModal 的 useMemo 里，无法单测，也无法被落盘侧复用，
 * 于是出现「预览 照片_001.jpg、落盘 照片_001-1.jpg」这类漂移：预览只看得见
 * 选中集内部的重名，看不见磁盘上**未选中**的同名文件。
 *
 * 这里做两件事：
 *   1. 把「候选名生成 + 批内重名 + 名称校验」收敛成纯函数，预览与落盘共用同一份
 *      `RenameOptions`（组件提交时直接把 options 交给 handleBatchRename）；
 *   2. 产出 `plans`（待向主进程只读探测的条目），由 `applyRenameProbe` 把主进程
 *      按 reserveUniquePath 规则算出的最终名字写回预览行 —— 预览即落盘结果。
 *
 * 注意：探测是**只读且有时效**的。预览到确认之间若磁盘发生变化，落盘仍以主进程
 * 当时的原子占位结果为准，并由 Toast 明确告知（这是 TOCTOU 无法消除的部分）。
 */

import type { Photo, RenameOptions } from '@/types';
import { folderOfPath, joinPath, validateFilename } from '@/lib/fs/pathUtils';
import { formatDateForNaming } from '@/lib/format/format';
import { repairFileName } from '@/lib/media/filenameRepair';
import { photoTakenTime } from '@/lib/media/photoTime';

/** 预览只展示前几行，但探测会覆盖全部行，避免「看不到的行与落盘不一致」 */
export const RENAME_PREVIEW_MAX_ROWS = 5;

export interface RenamePreviewRow {
  from: string;
  to: string;
  /** 批内重名，已追加 _1 / _2 */
  adjusted: boolean;
  /** 磁盘上已有同名，主进程将追加 -1 / -2（探测后才知道） */
  diskAdjusted: boolean;
  /** 乱码修复模式的处理说明 */
  note?: string;
  /** 源路径；拖放降级照片可能为空 */
  oldPath: string;
  /** 期望的目标路径（探测后会被改写为最终路径） */
  desiredPath: string;
}

/** 一条待主进程只读探测的请求；index 指回 rows 的下标 */
export interface RenamePreviewPlan {
  index: number;
  oldPath: string;
  desiredPath: string;
}

export interface RenameProbeResult {
  finalName: string;
  conflicted: boolean;
}

export interface RenamePreview {
  rows: RenamePreviewRow[];
  plans: RenamePreviewPlan[];
  error?: string;
  /** 未展示的行数 */
  truncated: number;
  /** 名称会真正发生变化的项数 */
  changedCount: number;
}

/** 扩展名（含点）；无扩展名返回空串 */
const extWithDot = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};

/** 在扩展名前插入 _N（批内重名），与主进程落盘时的 -N 是两套不同语义，不要合并 */
const withBatchSuffix = (name: string, counter: number): string => {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${stem}_${counter}${ext}`;
};

/**
 * 生成预览。返回全量 rows（UI 自行截断展示），以及可用于主进程探测的 plans。
 * 校验沿用 `validateFilename`：它的不变式保证「校验通过 ⟹ sanitizeFilename 是恒等变换」，
 * 因此预览显示的名字与落盘规范化后的名字不可能不同。
 */
export const buildRenamePreview = (photos: Photo[], options: RenameOptions): RenamePreview => {
  const empty: RenamePreview = { rows: [], plans: [], truncated: 0, changedCount: 0 };

  if (options.mode === 'replace' && !options.useRegex && options.findText === '') {
    return { ...empty, error: '请输入要查找的文本' };
  }
  if (options.mode === 'replace' && options.useRegex && options.findText !== '') {
    try {
      void new RegExp(options.findText);
    } catch {
      return { ...empty, error: '无效的正则表达式' };
    }
  }
  const repair = options.repair;
  if (
    options.mode === 'repair' &&
    repair &&
    !repair.fixMojibake &&
    !repair.stripJunkPrefix &&
    !repair.stripCopyMarks &&
    !repair.fallbackToDate
  ) {
    return { ...empty, error: '请至少启用一条处理规则' };
  }

  const sorted = [...photos].sort((a, b) => photoTakenTime(a) - photoTakenTime(b));
  const rows: RenamePreviewRow[] = [];
  const plans: RenamePreviewPlan[] = [];
  const used = new Set<string>();
  let changedCount = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const photo = sorted[i];
    const ext = extWithDot(photo.name);
    const stem = ext ? photo.name.slice(0, photo.name.length - ext.length) : photo.name;
    let to: string;
    let note: string | undefined;

    if (options.mode === 'repair') {
      const repaired = repairFileName(
        photo.name,
        repair ?? {
          fixMojibake: true,
          stripJunkPrefix: true,
          stripCopyMarks: true,
          fallbackToDate: true,
          dateFormat: options.dateFormat,
          datePrefix: options.datePrefix,
        },
        photoTakenTime(photo)
      );
      to = repaired.name;
      note = repaired.changed ? repaired.notes.join('、') || '已处理' : '无需修改';
    } else if (options.mode === 'sequence') {
      const padding =
        options.numberPadding && options.numberPadding > 0 ? options.numberPadding : 3;
      to = `${options.prefix}${(options.startNumber + i).toString().padStart(padding, '0')}${ext}`;
    } else if (options.mode === 'replace') {
      let base = stem;
      if (options.useRegex) {
        base = base.replace(new RegExp(options.findText, 'g'), options.replaceText);
      } else if (options.findText !== '') {
        base = base.split(options.findText).join(options.replaceText);
      }
      to = `${base}${ext}`;
    } else {
      const photoDate = new Date(photoTakenTime(photo) || Date.now());
      const dateStr = formatDateForNaming(photoDate, options.dateFormat || 'yyyy-MM-dd_HHmmss');
      to = `${options.datePrefix ?? 'photo_'}${dateStr}${ext}`;
    }

    // 批内重名只在同一目录内成立；磁盘上未被选中的同名文件由主进程探测补上
    const dirKey = folderOfPath(photo.path || '');
    let counter = 1;
    let adjusted = false;
    while (used.has(`${dirKey}\u0000${to}`)) {
      to = withBatchSuffix(to, counter);
      counter += 1;
      adjusted = true;
    }
    used.add(`${dirKey}\u0000${to}`);

    const verdict = validateFilename(to);
    if (!verdict.ok) {
      return { ...empty, error: `「${to}」${verdict.reason}` };
    }

    if (to !== photo.name) changedCount += 1;

    const oldPath = photo.path || '';
    const desiredPath = oldPath ? joinPath(folderOfPath(oldPath), to) : '';
    const index = rows.length;
    rows.push({
      from: photo.name,
      to,
      adjusted,
      diskAdjusted: false,
      note,
      oldPath,
      desiredPath,
    });
    // 拖放降级、没有磁盘路径的照片无法也不需要探测
    if (oldPath && desiredPath) plans.push({ index, oldPath, desiredPath });
  }

  return {
    rows,
    plans,
    changedCount,
    truncated: Math.max(0, rows.length - RENAME_PREVIEW_MAX_ROWS),
  };
};

/**
 * 把主进程的只读探测结果写回预览行。
 * 结果条数对不上时原样返回 —— 宁可显示未经磁盘校准的预览，也不要按错位下标改名字。
 */
export const applyRenameProbe = (
  preview: RenamePreview,
  plans: readonly RenamePreviewPlan[],
  results: readonly RenameProbeResult[]
): RenamePreview => {
  if (results.length !== plans.length) return preview;

  const rows = [...preview.rows];
  plans.forEach((plan, k) => {
    const row = rows[plan.index];
    const finalName = results[k]?.finalName;
    if (!row || !finalName) return;
    rows[plan.index] = {
      ...row,
      to: finalName,
      desiredPath: row.oldPath ? joinPath(folderOfPath(row.oldPath), finalName) : '',
      diskAdjusted: finalName !== row.to,
    };
  });

  return {
    ...preview,
    rows,
    changedCount: rows.filter((row) => row.to !== row.from).length,
  };
};
