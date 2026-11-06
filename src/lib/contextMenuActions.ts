/**
 * 图库右键菜单项构造（从 App 抽出的纯逻辑）。
 *
 * 分两种情境：
 * - 空白区右键：图库级操作（导入 / 全选 / 检测相似 / 清空照片列表）；
 * - 条目右键：单张 + 选中集操作，右键项若在选中集内则对整组生效。
 *
 * 所有副作用通过 `ContextMenuActionsDeps` 注入，函数本身不读取任何组件状态，
 * 便于独立阅读与测试。
 *
 * v0.6.2 批次 1（K13）：多选时每个动作都要说清自己作用于谁 ——
 * 会落空的动作不渲染（整组都是视频时不给「导出」），单张语义的动作显式标
 * 「仅此张」，批量动作标真实数量。文案里的数字必须等于实际作用域。
 */

import type { ContextMenuItem } from '@/types/contextMenu';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/lib/media/mediaTypes';

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
  /**
   * 批量收藏：注入后，多选时「收藏」才真正作用于整组而不是右键那一张。
   * 不注入时保持单张行为，并把文案标成「仅此张」，绝不谎报数量。
   */
  onToggleFavoriteMany?: (ids: string[], value: boolean) => void;
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
    onToggleFavoriteMany,
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
      ...(photoCount > 0
        ? [
            { separator: true } as ContextMenuItem,
            {
              label: '清空照片列表',
              onClick: () => onClearList(),
            },
          ]
        : []),
    ];
  }

  // 条目右键：单张 + 选中集操作
  const photo = contextPhoto;
  const isVideo = isVideoPhoto(photo);

  // 右键的条目若在选中集内，则对整组生效（与重命名 / 删除一致）
  const targetIds =
    selectedIds.has(photo.id) && selectedIds.size > 1 ? [...selectedIds] : [photo.id];
  const targetPhotos = targetIds
    .map((id) => getPhotoById(id))
    .filter((p): p is Photo => Boolean(p));
  const isMulti = targetIds.length > 1;
  const imageCount = targetPhotos.filter((p) => !isVideoPhoto(p)).length;
  const videoCount = targetPhotos.length - imageCount;
  const singleOnly = isMulti ? ' · 仅此张' : '';

  const allHidden = targetIds.every((id) => getPhotoById(id)?.isHidden);
  const hideLabel =
    targetIds.length > 1
      ? `${allHidden ? '取消隐藏' : '隐藏'} ${targetIds.length} 项`
      : allHidden
        ? '取消隐藏'
        : '隐藏';

  // 多选时只有注入了批量能力才敢标「N 项」；否则说清只改右键这一张
  const favoriteAll = isMulti && Boolean(onToggleFavoriteMany);
  const allFavorite = targetPhotos.length > 0 && targetPhotos.every((p) => p.isFavorite);
  const favoriteLabel = favoriteAll
    ? `${allFavorite ? '取消收藏' : '收藏'} ${targetIds.length} 项`
    : `${photo.isFavorite ? '取消收藏' : '收藏'}${singleOnly}`;

  return [
    {
      label: `${isVideo ? '播放' : '打开'}${singleOnly}`,
      shortcut: '␣',
      onClick: () => onOpenQuickLook(photo),
    },
    {
      label: favoriteLabel,
      shortcut: '⌘⇧F',
      onClick: () => {
        if (favoriteAll && onToggleFavoriteMany) {
          onToggleFavoriteMany(targetIds, !allFavorite);
        } else {
          onToggleFavorite(photo.id);
        }
      },
    },
    {
      label: hideLabel,
      onClick: () => onSetHidden(targetIds, !allHidden),
    },
    { separator: true },
    // 视频无法写入图片剪贴板，整组都是视频时这一项也不会落空
    ...(isVideo
      ? []
      : [
          {
            label: `复制图片${singleOnly}`,
            onClick: () => onCopyImage(photo),
          } as ContextMenuItem,
        ]),
    {
      label: `在访达中显示${singleOnly}`,
      onClick: () => onShowInFolder(photo),
    },
    {
      label: `复制路径${singleOnly}`,
      onClick: () => onCopyPath(photo),
    },
    {
      label: `用默认应用打开${singleOnly}`,
      onClick: () => onOpenInEditor(photo),
    },
    // 导出走 canvas 重编码，仅图片可用：按整组里真实的图片数标注，
    // 一个可导出的都没有就不渲染（右键视频但选中集含图片时仍应出现）
    ...(imageCount === 0
      ? []
      : [
          {
            label: isMulti
              ? `导出 ${imageCount} 张图片${videoCount > 0 ? `（跳过 ${videoCount} 个视频）` : ''}`
              : '导出…',
            onClick: () => onExportSelected(),
          } as ContextMenuItem,
        ]),
    {
      label: targetIds.length > 1 ? `移动 ${targetIds.length} 项到…` : '移动到…',
      onClick: () => onMovePhotos(targetPhotos),
    },
    { separator: true },
    {
      label: '调整日期与时间…',
      onClick: () => onOpenAdjustDate(),
    },
    {
      label: isMulti ? `重命名 ${targetIds.length} 项…` : '重命名…',
      onClick: () => onOpenRename(),
    },
    {
      label: isMulti ? `删除 ${targetIds.length} 项` : '删除',
      shortcut: '⌘⌫',
      danger: true,
      onClick: () => onOpenDelete(),
    },
  ];
}
