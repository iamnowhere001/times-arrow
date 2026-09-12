/**
 * 图库右键菜单项构造（从 App 抽出的纯逻辑）。
 *
 * 分两种情境：
 * - 空白区右键：图库级操作（导入 / 全选 / 检测相似 / 清空照片列表）；
 * - 条目右键：单张 + 选中集操作，右键项若在选中集内则对整组生效。
 *
 * 所有副作用通过 `ContextMenuActionsDeps` 注入，函数本身不读取任何组件状态，
 * 便于独立阅读与测试。菜单文案与快捷键与重构前逐字保持一致。
 */

import { ContextMenuItem } from '@/components/common/ContextMenu';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/utils';

export interface ContextMenuActionsDeps {
  /** 当前右键目标；为 null 表示空白区右键 */
  contextPhoto: Photo | null;
  /** 当前可见条目数（visiblePhotos.length） */
  visibleCount: number;
  /** 图库条目总数（photos.length） */
  photoCount: number;
  /** 当前选中集合 */
  selectedIds: ReadonlySet<string>;
  /** 按 id 读取最新照片（读取 ref，避免闭包过期） */
  getPhotoById: (id: string) => Photo | undefined;

  onImport: () => void;
  onSelectAllVisible: () => void;
  onCheckDuplicates: () => void;
  onClearList: () => void;
  onOpenQuickLook: (photo: Photo) => void;
  onToggleFavorite: (id: string) => void;
  onSetHidden: (ids: string[], value: boolean) => void;
  onCopyImage: (photo: Photo) => void;
  onShowInFolder: (photo: Photo) => void;
  onCopyPath: (photo: Photo) => void;
  onOpenInEditor: (photo: Photo) => void;
  onExportSelected: () => void;
  onMovePhotos: (photos: Photo[]) => void;
  onOpenAdjustDate: () => void;
  onOpenRename: () => void;
  onOpenDelete: () => void;
}

export function buildContextMenuActions(deps: ContextMenuActionsDeps): ContextMenuItem[] {
  const {
    contextPhoto,
    visibleCount,
    photoCount,
    selectedIds,
    getPhotoById,
    onImport,
    onSelectAllVisible,
    onCheckDuplicates,
    onClearList,
    onOpenQuickLook,
    onToggleFavorite,
    onSetHidden,
    onCopyImage,
    onShowInFolder,
    onCopyPath,
    onOpenInEditor,
    onExportSelected,
    onMovePhotos,
    onOpenAdjustDate,
    onOpenRename,
    onOpenDelete,
  } = deps;

  // 空白区右键：图库级操作
  if (!contextPhoto) {
    return [
      {
        label: '导入图片、视频或文件夹…',
        shortcut: '⌘O',
        onClick: () => onImport(),
      },
      { separator: true },
      {
        label: '全选',
        shortcut: '⌘A',
        disabled: visibleCount === 0,
        onClick: () => onSelectAllVisible(),
      },
      {
        label: '检测相似照片',
        disabled: photoCount === 0,
        onClick: () => onCheckDuplicates(),
      },
      ...(photoCount > 0 ? [{ separator: true } as ContextMenuItem, {
        label: '清空照片列表',
        onClick: () => onClearList(),
      }] : []),
    ];
  }

  // 条目右键：单张 + 选中集操作
  const photo = contextPhoto;
  const isVideo = isVideoPhoto(photo);

  // 右键的条目若在选中集内，则对整组生效（与重命名 / 删除一致）
  const targetIds = selectedIds.has(photo.id) && selectedIds.size > 1 ? [...selectedIds] : [photo.id];
  const allHidden = targetIds.every(id => getPhotoById(id)?.isHidden);
  const hideLabel =
    targetIds.length > 1
      ? `${allHidden ? '取消隐藏' : '隐藏'} ${targetIds.length} 项`
      : allHidden
        ? '取消隐藏'
        : '隐藏';

  return [
    {
      label: isVideo ? '播放' : '打开',
      shortcut: '␣',
      onClick: () => onOpenQuickLook(photo),
    },
    {
      label: photo.isFavorite ? '取消收藏' : '收藏',
      shortcut: '⌘⇧F',
      onClick: () => onToggleFavorite(photo.id),
    },
    {
      label: hideLabel,
      onClick: () => onSetHidden(targetIds, !allHidden),
    },
    { separator: true },
    // 视频无法写入图片剪贴板
    ...(isVideo ? [] : [{
      label: '复制图片',
      onClick: () => onCopyImage(photo),
    } as ContextMenuItem]),
    {
      label: '在访达中显示',
      onClick: () => onShowInFolder(photo),
    },
    {
      label: '复制路径',
      onClick: () => onCopyPath(photo),
    },
    {
      label: '用默认应用打开',
      onClick: () => onOpenInEditor(photo),
    },
    // 导出走 canvas 重编码，仅图片可用
    ...(isVideo ? [] : [{
      label: `导出${selectedIds.size > 1 ? ` ${selectedIds.size} 张` : '…'}`,
      onClick: () => onExportSelected(),
    } as ContextMenuItem]),
    {
      label: targetIds.length > 1 ? `移动 ${targetIds.length} 项到…` : '移动到…',
      onClick: () => onMovePhotos(
        targetIds
          .map(id => getPhotoById(id))
          .filter((p): p is Photo => Boolean(p))
      ),
    },
    { separator: true },
    {
      label: '调整日期与时间…',
      onClick: () => onOpenAdjustDate(),
    },
    {
      label: selectedIds.size > 1 ? `重命名 ${selectedIds.size} 项…` : '重命名…',
      onClick: () => onOpenRename(),
    },
    {
      label: selectedIds.size > 1 ? `删除 ${selectedIds.size} 项` : '删除',
      shortcut: '⌘⌫',
      danger: true,
      onClick: () => onOpenDelete(),
    },
  ];
}
