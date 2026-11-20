import type { ComponentProps } from 'react';
import type { LibrarySource, Photo, PhotoFilters, SmartAlbum } from '@/types';
import type { ContextMenuItem } from '@/types/contextMenu';
import type { ToastData } from '@/types/toast';
import type { AppModals } from '@/hooks/useAppModals';
import { basenameOfPath } from '@/lib/persistence/sources';
import type { useUpdateChecker } from '@/hooks/useUpdateChecker';
import ContextMenu from '@/components/common/ContextMenu';
import ToastStack from '@/components/layout/ToastStack';
import QuickLook from '@/components/detail/QuickLook';
import RenameModal from '@/components/modal/RenameModal';
import DeleteConfirmModal from '@/components/modal/DeleteConfirmModal';
import ClearListConfirmModal from '@/components/modal/ClearListConfirmModal';
import RestoreLibraryModal from '@/components/modal/RestoreLibraryModal';
import AiSettingsModal from '@/components/modal/AiSettingsModal';
import UpdateModal from '@/components/modal/UpdateModal';
import DataAssetsModal from '@/components/modal/DataAssetsModal';
import ExportModal from '@/components/modal/ExportModal';
import AdjustDateModal from '@/components/modal/AdjustDateModal';
import SaveAlbumModal from '@/components/modal/SaveAlbumModal';
import ShortcutsOverlay from '@/components/common/ShortcutsOverlay';

/**
 * 全部弹层与浮层。
 *
 * ## 为什么集中在一个文件
 *
 * 这些组件彼此没有依赖，共同点只有一个：**由某个布尔开关控制显隐**。
 * 散在 App 的 return 里时，加一个弹窗要在千行文件里找插入点，
 * 而且「哪个开关对应哪个弹层」只能靠读 JSX 反推。集中之后：
 * 加弹层是往这里加一段，App 只负责把状态传进来。
 *
 * ## 开关从哪来
 *
 * 十个本地开关走 `modals`（见 hooks/useAppModals），不再逐个作为 props 传递 ——
 * 它们没有业务含义，只有 open / close，传一个对象就够了。
 *
 * 三个例外刻意保留为独立 props，因为它们不属于本地 state：
 * - `isRestorePromptOpen` 由 useLibrarySources 拥有；
 * - `updateChecker.isOpen` 由 useUpdateChecker 拥有；
 * - 关闭导出要顺带清空 `exportTargets`、关闭恢复提示要弹 Toast，都带副作用。
 *
 * ## 什么不该放在这里
 *
 * 带业务分支的流程（导出完成后的汇总判定）留在 App —— 它们是决策，
 * 不是「开关 → 渲染」的映射。这里只接收已决好的回调。
 */

type RenameConfirm = ComponentProps<typeof RenameModal>['onConfirm'];
type DeleteConfirm = ComponentProps<typeof DeleteConfirmModal>['onConfirm'];
type ClearListConfirm = ComponentProps<typeof ClearListConfirmModal>['onConfirm'];
type AdjustDateApply = ComponentProps<typeof AdjustDateModal>['onApply'];
type SaveAlbumSave = ComponentProps<typeof SaveAlbumModal>['onSave'];
type ExportFinish = ComponentProps<typeof ExportModal>['onFinish'];
type ToastDismiss = ComponentProps<typeof ToastStack>['onDismiss'];

export interface AppOverlaysProps {
  /** 十个本地开关（useAppModals） */
  modals: AppModals;

  // 右键菜单
  contextMenu: { x: number; y: number; photo?: Photo } | null;
  contextMenuActions: ContextMenuItem[];
  onCloseContextMenu: () => void;

  // Toast
  toasts: ToastData[];
  onDismissToast: ToastDismiss;

  // 重命名 / 删除 / 清空：都以「当前选中集」为作用对象
  onRenameConfirm: RenameConfirm;
  photos: Photo[];
  selectedIds: Set<string>;
  isFileOpBusy: boolean;
  onDeleteConfirm: DeleteConfirm;
  onClearListConfirm: ClearListConfirm;

  // 恢复上次的图库：开关与数据来自 useLibrarySources，关闭 / 确认都带副作用
  isRestorePromptOpen: boolean;
  onCloseRestorePrompt: () => void;
  onConfirmRestore: () => void;
  sources: LibrarySource[];
  directorySources: LibrarySource[];
  fileSources: LibrarySource[];
  unavailableSourceCount: number;

  // 设置类共用的提示通道
  onNotify: (message: string, type?: 'success' | 'info' | 'error' | 'warning') => void;

  onSaveAlbum: SaveAlbumSave;
  filters: PhotoFilters;
  albums: SmartAlbum[];

  onApplyDateAdjustment: AdjustDateApply;
  selectedPhotos: Photo[];

  // 检查更新与下载（开关与状态都在 useUpdateChecker 里）
  updateChecker: ReturnType<typeof useUpdateChecker>;

  // 导出：关闭时要清空 exportTargets，副作用留在 App
  onCloseExport: () => void;
  exportTargets: Photo[];
  onExportFinish: ExportFinish;

  // 全屏预览
  quickLookPhoto: Photo | null;
  onCloseQuickLook: () => void;
  quickLookList: Photo[];
  quickLookIndex: number;
  quickLookPreloadSources: string[];
  onQuickLookNext: () => void;
  onQuickLookPrev: () => void;
  onQuickLookJump: (photo: Photo) => void;
  onToggleFavorite: (id: string) => void;
}

export default function AppOverlays({
  modals,
  contextMenu,
  contextMenuActions,
  onCloseContextMenu,
  toasts,
  onDismissToast,
  onRenameConfirm,
  photos,
  selectedIds,
  isFileOpBusy,
  onDeleteConfirm,
  onClearListConfirm,
  isRestorePromptOpen,
  onCloseRestorePrompt,
  onConfirmRestore,
  sources,
  directorySources,
  fileSources,
  unavailableSourceCount,
  onNotify,
  onSaveAlbum,
  filters,
  albums,
  onApplyDateAdjustment,
  selectedPhotos,
  updateChecker,
  onCloseExport,
  exportTargets,
  onExportFinish,
  quickLookPhoto,
  onCloseQuickLook,
  quickLookList,
  quickLookIndex,
  quickLookPreloadSources,
  onQuickLookNext,
  onQuickLookPrev,
  onQuickLookJump,
  onToggleFavorite,
}: AppOverlaysProps) {
  return (
    <>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={onCloseContextMenu}
          actions={contextMenuActions}
        />
      )}

      {/* Toast 队列：底部居中堆叠，避免遮挡工具栏（渲染见 ToastStack） */}
      <ToastStack toasts={toasts} onDismiss={onDismissToast} />

      {modals.rename.isOpen && (
        <RenameModal
          isOpen={modals.rename.isOpen}
          onClose={modals.rename.close}
          onConfirm={onRenameConfirm}
          photos={photos.filter((p) => selectedIds.has(p.id))}
          count={selectedIds.size}
          isBusy={isFileOpBusy}
        />
      )}
      {modals.deleteConfirm.isOpen && (
        <DeleteConfirmModal
          isOpen={modals.deleteConfirm.isOpen}
          count={selectedIds.size}
          isDiskOperation={true}
          onClose={modals.deleteConfirm.close}
          onConfirm={onDeleteConfirm}
          isBusy={isFileOpBusy}
        />
      )}

      {/* 清空照片列表二次确认：侧栏底部入口与右键菜单都走这里 */}
      <ClearListConfirmModal
        isOpen={modals.clearList.isOpen}
        count={photos.length}
        onClose={modals.clearList.close}
        onConfirm={onClearListConfirm}
      />

      {/* 「恢复上次的图库」确认框（N8）：启动时存在常驻来源才出现 */}
      <RestoreLibraryModal
        isOpen={isRestorePromptOpen}
        sourceCount={sources.length}
        directoryCount={directorySources.length}
        fileCount={fileSources.length}
        directoryNames={directorySources.map((source) => basenameOfPath(source.path))}
        unavailableCount={unavailableSourceCount}
        onClose={onCloseRestorePrompt}
        onConfirm={onConfirmRestore}
      />

      {/* AI 分析设置：应用内配置 DeepSeek API Key / 接口地址 / 模型 */}
      <AiSettingsModal
        isOpen={modals.aiSettings.isOpen}
        onClose={modals.aiSettings.close}
        onNotify={onNotify}
      />

      {/* 检查更新：GitHub Releases 检查 / 下载 DMG / 引导安装（见 hooks/useUpdateChecker） */}
      <UpdateModal
        isOpen={updateChecker.isOpen}
        onClose={updateChecker.closePanel}
        currentVersion={updateChecker.currentVersion}
        checkResult={updateChecker.checkResult}
        isChecking={updateChecker.isChecking}
        error={updateChecker.error}
        download={updateChecker.download}
        onCheck={updateChecker.checkNow}
        onDownload={updateChecker.startDownload}
        onCancelDownload={updateChecker.cancelDownload}
        onOpenDownload={updateChecker.openDownloaded}
        onRevealDownload={updateChecker.revealDownloaded}
        onOpenRelease={updateChecker.openReleasePage}
      />

      {/* 数据资产：配置导出导入 / 路径重连 / 操作日志与撤销 / 增量备份 */}
      <DataAssetsModal
        isOpen={modals.dataAssets.isOpen}
        onClose={modals.dataAssets.close}
        onNotify={onNotify}
      />

      {modals.exportModal.isOpen && (
        <ExportModal
          isOpen={modals.exportModal.isOpen}
          photos={exportTargets}
          onClose={onCloseExport}
          onFinish={onExportFinish}
        />
      )}

      {modals.adjustDate.isOpen && (
        <AdjustDateModal
          isOpen={modals.adjustDate.isOpen}
          photos={selectedPhotos}
          onClose={modals.adjustDate.close}
          onApply={onApplyDateAdjustment}
        />
      )}

      {modals.saveAlbum.isOpen && (
        <SaveAlbumModal
          isOpen={modals.saveAlbum.isOpen}
          filters={filters}
          existingNames={albums.map((album) => album.name)}
          onClose={modals.saveAlbum.close}
          onSave={onSaveAlbum}
        />
      )}

      {modals.shortcuts.isOpen && <ShortcutsOverlay onClose={modals.shortcuts.close} />}

      {quickLookPhoto && (
        <QuickLook
          photo={quickLookPhoto}
          onClose={onCloseQuickLook}
          onNext={onQuickLookNext}
          onPrev={onQuickLookPrev}
          onFirst={quickLookList.length > 0 ? () => onQuickLookJump(quickLookList[0]) : undefined}
          hasNext={quickLookIndex >= 0 && quickLookIndex < quickLookList.length - 1}
          hasPrev={quickLookIndex > 0}
          currentIndex={quickLookIndex}
          totalCount={quickLookList.length}
          onToggleFavorite={onToggleFavorite}
          preloadSources={quickLookPreloadSources}
        />
      )}
    </>
  );
}
