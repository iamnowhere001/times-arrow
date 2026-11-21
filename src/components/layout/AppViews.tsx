import type { ComponentProps } from 'react';
import type { Photo } from '@/types';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import ViewErrorFallback from '@/components/common/ViewErrorFallback';
import DuplicateDetector from '@/components/duplicate/DuplicateDetector';
import TimelineGallery from '@/components/timeline/TimelineGallery';
import LocationMap from '@/components/map/LocationMap';
import PeopleView from '@/components/people/PeopleView';
import AboutView from '@/components/about/AboutView';

/**
 * 整页视图路由：重复检测 / 时光画廊 / 按地点浏览 / 人像 / 关于更新。
 *
 * ## 为什么只包含这五个
 *
 * 图库视图（工具栏 + 网格 + 详情面板）刻意留在这里之外 —— 它与 App 的状态
 * 有六十余处直接耦合，抽出去只能变成一次同规模的 props 转发，行数不减、
 * 维护点翻倍。真正的减负要靠「状态下沉」（把图库那批状态收进独立的 hook），
 * 那是一次结构性改动，不在本批次范围内。
 *
 * 这五个视图的共同点才是路由该管的事：各自接管整个主内容区、
 * 自带返回入口、共享同一份「渲染出错时回到图库」兜底。
 *
 * ## 为什么用 ComponentProps 推导而不是手写 props
 *
 * 视图组件的 props 会变。用 `ComponentProps<typeof X>` 推导，
 * 加字段时这里不需要跟着改，typecheck 会直接指向真正的调用点。
 */

type DuplicatesProps = ComponentProps<typeof DuplicateDetector>;
type AboutProps = ComponentProps<typeof AboutView>;

export type FullPageView = 'duplicates' | 'timeline' | 'map' | 'people' | 'about';

export interface AppViewsProps {
  view: FullPageView;
  /** 各视图 ErrorBoundary 兜底的返回动作：一律回图库 */
  onBackToLibrary: () => void;
  /** 左栏是否可见：整页视图据此给内容区让出宽度（左侧浮动返回按钮的位置依赖它） */
  isLeftPaneOpen: boolean;

  duplicates: Omit<DuplicatesProps, 'isLeftPaneOpen'>;
  /** 时光画廊与地图同源：非隐藏的全部照片（带 GPS 的落成光点） */
  timelinePhotos: Photo[];
  onTimelineQuickLook: ComponentProps<typeof TimelineGallery>['onQuickLook'];
  onMapQuickLook: ComponentProps<typeof LocationMap>['onQuickLook'];
  people: Omit<ComponentProps<typeof PeopleView>, 'onBack' | 'isLeftPaneOpen'>;
  onBackFromPeople: () => void;

  about: Omit<AboutProps, 'onBack'>;
  onExitAbout: () => void;
}

export default function AppViews({
  view,
  onBackToLibrary,
  isLeftPaneOpen,
  duplicates,
  timelinePhotos,
  onTimelineQuickLook,
  onMapQuickLook,
  people,
  onBackFromPeople,
  about,
  onExitAbout,
}: AppViewsProps) {
  if (view === 'duplicates') {
    return (
      <ErrorBoundary
        label="重复检测"
        fallback={
          <ViewErrorFallback
            title="相似检测视图出错"
            description="图库内容仍然完好，可返回图库继续整理。"
            onAction={onBackToLibrary}
          />
        }
      >
        <DuplicateDetector {...duplicates} isLeftPaneOpen={isLeftPaneOpen} />
      </ErrorBoundary>
    );
  }

  if (view === 'timeline') {
    return (
      <ErrorBoundary
        label="时光画廊"
        fallback={
          <ViewErrorFallback
            title="时光画廊渲染出错"
            description="图库内容仍然完好，可返回图库继续浏览。"
            onAction={onBackToLibrary}
          />
        }
      >
        <TimelineGallery
          photos={timelinePhotos}
          onQuickLook={onTimelineQuickLook}
          onBack={onBackToLibrary}
          isLeftPaneOpen={isLeftPaneOpen}
        />
      </ErrorBoundary>
    );
  }

  if (view === 'map') {
    return (
      <ErrorBoundary
        label="按地点浏览"
        fallback={
          <ViewErrorFallback
            title="地图视图出错"
            description="图库内容仍然完好，可返回图库继续浏览。"
            onAction={onBackToLibrary}
          />
        }
      >
        <LocationMap
          photos={timelinePhotos}
          onQuickLook={onMapQuickLook}
          onBack={onBackToLibrary}
          isLeftPaneOpen={isLeftPaneOpen}
        />
      </ErrorBoundary>
    );
  }

  if (view === 'people') {
    return (
      <ErrorBoundary
        label="人像"
        fallback={
          <ViewErrorFallback
            title="人像视图出错"
            description="图库内容仍然完好，可返回图库继续浏览。人像索引不会因此丢失。"
            onAction={onBackToLibrary}
          />
        }
      >
        <PeopleView {...people} onBack={onBackFromPeople} isLeftPaneOpen={isLeftPaneOpen} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary
      label="关于与更新"
      fallback={
        <ViewErrorFallback
          title="关于页渲染出错"
          description="图库内容仍然完好，可返回图库继续整理。"
          onAction={onBackToLibrary}
        />
      }
    >
      <AboutView {...about} onBack={onExitAbout} />
    </ErrorBoundary>
  );
}
