import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Photo } from '@/types';
import { ThumbImage } from '@/components/grid/ThumbnailImage';
import { formatVideoDuration, isVideoPhoto, photoOriginalTime } from '@/utils';
import {
  GeoCluster,
  MapCamera,
  MapViewport,
  buildGeoPoints,
  clampCamera,
  clusterGeoPoints,
  countGeoLocations,
  findClusterAt,
  fitCameraToPoints,
  forEachLandDot,
  formatLatLng,
  projectLngLat,
  worldCamera,
  worldToScreen,
  zoomCameraAt,
} from '@/lib/geo/mapMath';
import { arePlacesLoaded, getPlaces, loadPlaces } from '@/lib/geo/places';
import { findNearestPlace, formatPlaceHint } from '@/lib/geo/placeIndex';

interface LocationMapProps {
  /** 全部照片（调用方已排除隐藏项）：有 GPS 的落成光点，其余计入「未记录地点」 */
  photos: Photo[];
  /** 打开 QuickLook：翻页范围限定为该地点的照片 */
  onQuickLook: (photo: Photo, scope: Photo[]) => void;
  /** 返回图库 */
  onBack: () => void;
  /** 侧栏是否展开：标题栏据此为红绿灯让位 */
  isLeftPaneOpen: boolean;
  /** 浅色主题：点阵底图与光点需要换一套对比度 */
  isLight: boolean;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 屏幕聚合半径：落进同一格的相邻光点合并为一个「地点」 */
const CLUSTER_CELL_PX = 46;
/** 命中半径 */
const HIT_RADIUS_PX = 20;
/** 点阵底图的目标点距（屏幕像素）；拖拽时翻倍以保住帧率 */
const LAND_DOT_SPACING = 4;
/** 滚轮缩放灵敏度 */
const WHEEL_ZOOM_SENSITIVITY = 0.0016;
/** 双击 / 按钮放大倍率 */
const ZOOM_STEP = 1.7;
/** 键盘平移步长（屏幕像素） */
const KEY_PAN_STEP = 90;
/** 照片条最多渲染的缩略图数量 */
const STRIP_LIMIT = 120;

/** canvas 配色：与 styles.css 的暗房色板保持一致（canvas 读不到 CSS 变量） */
const PALETTE = {
  dark: {
    land: 'rgba(250, 247, 242, 0.10)',
    grid: 'rgba(250, 247, 242, 0.045)',
    dot: 'rgba(232, 163, 61, 1)',
    dotSoft: 'rgba(232, 163, 61, 0.18)',
    dotSofter: 'rgba(232, 163, 61, 0.08)',
    dotText: '#1a1409',
    ring: 'rgba(232, 163, 61, 0.9)',
    /** 城市名（底图参照，退后一层） */
    placeLabel: 'rgba(250, 247, 242, 0.42)',
    /** 光点地名（主角，最醒目） */
    siteLabel: 'rgba(250, 247, 242, 0.95)',
    /** 文字描边 = 页面底色：让字从点阵与柔光里立起来 */
    labelHalo: 'rgba(12, 11, 10, 0.9)',
  },
  light: {
    land: 'rgba(26, 22, 17, 0.14)',
    grid: 'rgba(26, 22, 17, 0.05)',
    dot: 'rgba(166, 99, 21, 1)',
    dotSoft: 'rgba(166, 99, 21, 0.2)',
    dotSofter: 'rgba(166, 99, 21, 0.09)',
    dotText: '#ffffff',
    ring: 'rgba(166, 99, 21, 0.9)',
    placeLabel: 'rgba(26, 22, 17, 0.48)',
    siteLabel: 'rgba(26, 22, 17, 0.95)',
    labelHalo: 'rgba(245, 243, 239, 0.92)',
  },
} as const;

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------

const ChevronLeftIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"></polyline>
  </svg>
);

/** 地图钉：与「按地点」的语义直接对应 */
const MapPinIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"></path>
    <circle cx="12" cy="10" r="3"></circle>
  </svg>
);

/** 复位视野：准星 */
const CrosshairIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="7.5"></circle>
    <line x1="12" y1="2" x2="12" y2="5"></line>
    <line x1="12" y1="19" x2="12" y2="22"></line>
    <line x1="2" y1="12" x2="5" y2="12"></line>
    <line x1="19" y1="12" x2="22" y2="12"></line>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>
  </svg>
);

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

const MinusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

/** 视频角标：与图库 / 时光画廊同一套语汇 */
const DurationBadge = ({ text }: { text: string }) => (
  <span className="absolute bottom-1 right-1 z-20 rounded-md bg-black/62 px-1.5 py-0.5 font-numeric text-[9.5px] leading-none tabular-nums text-white/92">
    {text}
  </span>
);

// ---------------------------------------------------------------------------
// canvas 绘制
// ---------------------------------------------------------------------------

/**
 * 陆地底图：每个采样格都填满。
 * 缩到世界视图时格子只有两三个像素，落成一层均匀的淡网点；
 * 放大后格子连成整片，海岸线自然浮现 —— 同一套代码在两种尺度上都读得通。
 */
function drawLandMask(
  ctx: CanvasRenderingContext2D,
  camera: MapCamera,
  viewport: MapViewport,
  isLight: boolean,
  spacing: number
): void {
  const colors = isLight ? PALETTE.light : PALETTE.dark;
  const path = new Path2D();
  forEachLandDot(camera, viewport, spacing, (x, y, cellPx) => {
    // 略微溢出单元格，消除相邻格之间的发丝缝
    const size = Math.max(1.6, cellPx + 0.6);
    path.rect(x - size / 2, y - size / 2, size, size);
  });
  ctx.fillStyle = colors.land;
  ctx.fill(path);
}

/** 经纬网：间距随缩放自适应，提供方位参照又不与点阵抢注意力 */
function drawGraticule(
  ctx: CanvasRenderingContext2D,
  camera: MapCamera,
  viewport: MapViewport,
  isLight: boolean
): void {
  const colors = isLight ? PALETTE.light : PALETTE.dark;
  const pxPerDegree = camera.scale / 360;
  const stepDeg = [30, 15, 5, 2, 1, 0.5].find(step => pxPerDegree * step >= 80) ?? 0.5;

  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let lng = -180; lng <= 180; lng += stepDeg) {
    const x = ((lng + 180) / 360 - camera.centerX) * camera.scale + viewport.width / 2;
    if (x < -1 || x > viewport.width + 1) continue;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewport.height);
  }

  for (let lat = 80; lat >= -80; lat -= stepDeg) {
    const worldY = projectLngLat(0, lat).y;
    const y = (worldY - camera.centerY) * camera.scale + viewport.height / 2;
    if (y < -1 || y > viewport.height + 1) continue;
    ctx.moveTo(0, y);
    ctx.lineTo(viewport.width, y);
  }

  ctx.stroke();
}

/** 光点半径：单张一颗小圆，多张按对数放大（标签定位也要用，抽出来共用） */
const clusterRadius = (count: number): number =>
  count === 1 ? 3 : Math.min(11, 3 + Math.log2(count) * 1.7);

/**
 * 光点：单张一颗小圆，多张按对数放大并标数字。
 * 柔光用两层同心圆代替渐变：几百个点每帧重建渐变对象会造成明显的 GC 抖动。
 */
function drawClusters(
  ctx: CanvasRenderingContext2D,
  clusters: GeoCluster[],
  hoverKey: string | null,
  activeScreen: { x: number; y: number } | null,
  isLight: boolean
): void {
  const colors = isLight ? PALETTE.light : PALETTE.dark;

  for (const cluster of clusters) {
    const count = cluster.points.length;
    const radius = clusterRadius(count);
    const hovered = hoverKey !== null && cluster.key === hoverKey;

    ctx.fillStyle = colors.dotSofter;
    ctx.beginPath();
    ctx.arc(cluster.x, cluster.y, radius * 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = colors.dotSoft;
    ctx.beginPath();
    ctx.arc(cluster.x, cluster.y, radius * 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = colors.dot;
    ctx.beginPath();
    ctx.arc(cluster.x, cluster.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (count > 1) {
      ctx.fillStyle = colors.dotText;
      ctx.font = `600 ${Math.max(8, Math.round(radius * 1.05))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(count), cluster.x, cluster.y + 0.5);
    }

    if (hovered) {
      ctx.strokeStyle = colors.ring;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cluster.x, cluster.y, radius * 2.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 选中地点：一圈安静的定位环，缩放平移时始终跟在它的地理位置上
  if (activeScreen) {
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(activeScreen.x, activeScreen.y, 17, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = colors.dot;
    ctx.beginPath();
    ctx.arc(activeScreen.x, activeScreen.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 标签占位矩形：用来避免文字互相压叠 */
interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: LabelRect, b: LabelRect, pad = 2): boolean =>
  a.x - pad < b.x + b.width &&
  a.x + a.width + pad > b.x &&
  a.y - pad < b.y + b.height &&
  a.y + a.height + pad > b.y;

/** 地图文字统一字体：与界面同族（中文交给系统字体） */
const LABEL_FONT =
  '500 11px -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif';

/**
 * 地名标注：先画光点的地名（主角），再补城市地名（底图参照）。
 * 两者共用一份占位表，谁先放谁优先 —— 放不下的自动省略，
 * 因此缩放时标签数量会自然增减，而不是糊成一片。
 *
 * 城市表是按需加载的（`getPlaces()`）：数据未到位时这里只画光点地名，
 * 到位后由绘制 effect 的 `placesReady` 依赖补一次重绘。
 */
function drawPlaceLabels(
  ctx: CanvasRenderingContext2D,
  camera: MapCamera,
  viewport: MapViewport,
  clusters: GeoCluster[],
  isLight: boolean,
  occupied: LabelRect[]
): void {
  const colors = isLight ? PALETTE.light : PALETTE.dark;
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;

  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const drawLabel = (text: string, x: number, y: number, fill: string): void => {
    const width = ctx.measureText(text).width;
    const rect: LabelRect = { x, y: y - 7, width, height: 14 };
    if (x < 2 || x + width > viewport.width - 2 || y < 8 || y > viewport.height - 8) return;
    if (occupied.some(item => overlaps(item, rect))) return;
    occupied.push(rect);
    // 底色描边：让字从点阵与柔光里立起来，是所有地图标注的通用做法
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = colors.labelHalo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  };

  // 1) 光点地名：照片多的先占位（越大的地点越值得被读到）
  const byCount = [...clusters].sort((a, b) => b.points.length - a.points.length);
  for (const cluster of byCount) {
    const nearest = findNearestPlace(cluster.latitude, cluster.longitude);
    if (!nearest) continue;
    drawLabel(
      nearest.place.name,
      cluster.x + clusterRadius(cluster.points.length) + 7,
      cluster.y,
      colors.siteLabel
    );
  }

  // 2) 城市地名：重要度高、离视野中心近的先放；放不下的自动省略
  const candidates: { name: string; x: number; y: number; rank: number; dist: number }[] = [];
  for (const place of getPlaces()) {
    const screen = worldToScreen(projectLngLat(place.longitude, place.latitude), camera, viewport);
    if (screen.x < 0 || screen.x > viewport.width || screen.y < 0 || screen.y > viewport.height) continue;
    candidates.push({
      name: place.name,
      x: screen.x,
      y: screen.y,
      rank: place.rank,
      dist: (screen.x - centerX) ** 2 + (screen.y - centerY) ** 2,
    });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.dist - b.dist);

  const MAX_PLACE_LABELS = 48;
  let placed = 0;
  for (const candidate of candidates) {
    if (placed >= MAX_PLACE_LABELS) break;
    const marker: LabelRect = { x: candidate.x - 2, y: candidate.y - 2, width: 4, height: 4 };
    if (occupied.some(item => overlaps(item, marker, 1))) continue;
    const before = occupied.length;
    drawLabel(candidate.name, candidate.x + 6, candidate.y, colors.placeLabel);
    if (occupied.length === before) continue; // 被越界或重叠挡下
    occupied.push(marker);
    ctx.fillStyle = colors.placeLabel;
    ctx.fillRect(candidate.x - 1.5, candidate.y - 1.5, 3, 3);
    placed += 1;
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

interface ActiveSite {
  longitude: number;
  latitude: number;
  photos: Photo[];
  /** 「这是哪儿」：地名 + 必要的距离参照 */
  placeHint: string;
}

interface HoverSite {
  key: string;
  x: number;
  y: number;
  longitude: number;
  latitude: number;
  photos: Photo[];
  placeHint: string;
}

/**
 * 按地点浏览（整页视图）。
 *
 * 轻量版地图：底图是内嵌数据逐格绘制的点阵世界（无网络、无地图 SDK），
 * 照片的 EXIF GPS 落成光点，并按屏幕距离聚合成「地点」。
 * 点击地点 → 单张直接进 QuickLook，多张则拉出该地点的照片条，且翻页范围限定在该地点内。
 */
const LocationMap: React.FC<LocationMapProps> = ({
  photos,
  onQuickLook,
  onBack,
  isLeftPaneOpen,
  isLight,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [viewport, setViewport] = useState<MapViewport>({ width: 0, height: 0 });
  const [camera, setCamera] = useState<MapCamera | null>(null);
  const [hover, setHover] = useState<HoverSite | null>(null);
  const [activeSite, setActiveSite] = useState<ActiveSite | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  /** 地名表是否已就绪（按需加载的独立 chunk，见 lib/geo/places.ts） */
  const [placesReady, setPlacesReady] = useState(arePlacesLoaded);
  /** 地点照片条两端是否还有内容：决定边缘渐隐是否显示 */
  const [stripEdge, setStripEdge] = useState({ left: false, right: false });
  const stripScrollRef = useRef<HTMLDivElement | null>(null);
  const measureStripEdge = useCallback(() => {
    const el = stripScrollRef.current;
    if (!el) return;
    setStripEdge(prev => {
      const next = {
        left: el.scrollLeft > 4,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
      };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  /**
   * 进入地图视图时才拉取地名表。
   *
   * 到位后必须把 `placesReady` 推到绘制 effect 的依赖里 —— 否则首帧画完就再也不会
   * 重绘，城市标注要等到用户碰一下地图才出现。加载失败时 `arePlacesLoaded()`
   * 仍为 false，这里不会死循环（`loadPlaces` 内部已消化错误并允许下次重试）。
   */
  useEffect(() => {
    if (placesReady) return;
    let alive = true;
    void loadPlaces().then(() => {
      if (alive) setPlacesReady(arePlacesLoaded());
    });
    return () => {
      alive = false;
    };
  }, [placesReady]);

  const points = useMemo(() => buildGeoPoints(photos), [photos]);
  const locationCount = useMemo(() => countGeoLocations(points), [points]);
  const missingCount = photos.length - points.length;

  /* ------------------------------ 视口与相机 ------------------------------ */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setViewport(prev => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 首次拿到视口尺寸时取景到全部点位；之后视口变化只夹取相机，不打断用户当前的视角
  useEffect(() => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    setCamera(prev => {
      if (prev) return clampCamera(prev, viewport);
      return fitCameraToPoints(points, viewport) ?? worldCamera(viewport);
    });
  }, [viewport, points]);

  const clusters = useMemo(() => {
    if (!camera || viewport.width <= 0 || viewport.height <= 0) return [];
    return clusterGeoPoints(points, camera, viewport, CLUSTER_CELL_PX);
  }, [points, camera, viewport]);

  // 相机一变，旧的悬停位置已无意义
  useEffect(() => {
    setHover(null);
  }, [camera]);

  // 照片集合变化（删除 / 隐藏 / 重命名）后，选中地点里已消失的照片要跟着收敛
  useEffect(() => {
    setActiveSite(prev => {
      if (!prev) return prev;
      const aliveIds = new Set(photos.map(photo => photo.id));
      const alive = prev.photos.filter(p => aliveIds.has(p.id));
      if (alive.length === prev.photos.length) return prev;
      if (alive.length === 0) return null;
      return { ...prev, photos: alive };
    });
  }, [photos]);

  // 照片条出现 / 照片集合变化 / 窗口尺寸变化后，重新测两端可滚动状态
  useEffect(() => {
    if (!activeSite) return;
    const raf = requestAnimationFrame(measureStripEdge);
    const ro = new ResizeObserver(measureStripEdge);
    if (stripScrollRef.current) ro.observe(stripScrollRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [activeSite, photos.length, measureStripEdge]);

  /* ------------------------------ 指针交互 ------------------------------ */

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const didDragRef = useRef(false);
  const latestPointerRef = useRef({ x: 0, y: 0 });
  const dragRafRef = useRef(0);

  const applyDrag = useCallback(() => {
    dragRafRef.current = 0;
    const drag = dragRef.current;
    if (!drag) return;
    const dx = latestPointerRef.current.x - drag.startX;
    const dy = latestPointerRef.current.y - drag.startY;
    setCamera(prev =>
      prev
        ? clampCamera(
            {
              scale: prev.scale,
              centerX: drag.originX - dx / prev.scale,
              centerY: drag.originY - dy / prev.scale,
            },
            viewport
          )
        : prev
    );
  }, [viewport]);

  useEffect(() => () => {
    if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current);
  }, []);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !camera) return;
    const local = localPoint(e);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: local.x,
      startY: local.y,
      originX: camera.centerX,
      originY: camera.centerY,
      moved: false,
    };
    didDragRef.current = false;
    latestPointerRef.current = local;
    setHasInteracted(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const local = localPoint(e);
    latestPointerRef.current = local;

    const drag = dragRef.current;
    if (drag) {
      if (Math.abs(local.x - drag.startX) + Math.abs(local.y - drag.startY) > 3) {
        if (!drag.moved) {
          drag.moved = true;
          setDragging(true);
        }
      }
      if (drag.moved && !dragRafRef.current) {
        dragRafRef.current = requestAnimationFrame(applyDrag);
      }
      return;
    }

    const hit = findClusterAt(clusters, local.x, local.y, HIT_RADIUS_PX);
    setHover(prev => {
      if (!hit) return prev === null ? prev : null;
      if (prev && prev.key === hit.key) return prev;
      return {
        key: hit.key,
        x: hit.x,
        y: hit.y,
        longitude: hit.longitude,
        latitude: hit.latitude,
        photos: hit.points.map(p => p.photo),
        placeHint: formatPlaceHint(findNearestPlace(hit.latitude, hit.longitude)),
      };
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    didDragRef.current = Boolean(drag?.moved);
    dragRef.current = null;
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    if (drag?.moved) setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const openSite = useCallback(
    (sitePhotos: Photo[], longitude: number, latitude: number) => {
      const ordered = [...sitePhotos].sort((a, b) => photoOriginalTime(a) - photoOriginalTime(b));
      // 单张：点一下就直接看，不必先看照片条再点一次
      if (ordered.length === 1) {
        onQuickLook(ordered[0], ordered);
        return;
      }
      setActiveSite({
        longitude,
        latitude,
        photos: ordered,
        placeHint: formatPlaceHint(findNearestPlace(latitude, longitude)),
      });
    },
    [onQuickLook]
  );

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    // 双击的第二次 click 不再触发选择：那是一次缩放操作（detail > 1）
    if (e.detail > 1) return;
    const local = localPoint(e);
    const hit = findClusterAt(clusters, local.x, local.y, HIT_RADIUS_PX);
    if (!hit) {
      setActiveSite(null);
      return;
    }
    openSite(hit.points.map(p => p.photo), hit.longitude, hit.latitude);
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const local = localPoint(e);
    setCamera(prev => (prev ? zoomCameraAt(prev, viewport, local.x, local.y, ZOOM_STEP) : prev));
  };

  // 滚轮缩放：必须用非 passive 监听才能 preventDefault（否则整页跟着上下滚）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const local = localPoint(e);
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      setHasInteracted(true);
      setCamera(prev => (prev ? zoomCameraAt(prev, viewport, local.x, local.y, factor) : prev));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewport]);

  const handleZoomButton = useCallback(
    (factor: number) => {
      setCamera(prev =>
        prev ? zoomCameraAt(prev, viewport, viewport.width / 2, viewport.height / 2, factor) : prev
      );
    },
    [viewport]
  );

  const handleResetView = useCallback(() => {
    setCamera(fitCameraToPoints(points, viewport) ?? worldCamera(viewport));
    setHover(null);
    setHasInteracted(true);
  }, [points, viewport]);

  /** 键盘兜底：方向键平移、+/- 缩放、0 回到全部地点（与 QuickLook 的缩放键位一致） */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const pan = (dx: number, dy: number) => {
      e.preventDefault();
      setCamera(prev =>
        prev
          ? clampCamera(
              {
                scale: prev.scale,
                centerX: prev.centerX + dx / prev.scale,
                centerY: prev.centerY + dy / prev.scale,
              },
              viewport
            )
          : prev
      );
    };
    switch (e.key) {
      case 'ArrowLeft':
        pan(-KEY_PAN_STEP, 0);
        break;
      case 'ArrowRight':
        pan(KEY_PAN_STEP, 0);
        break;
      case 'ArrowUp':
        pan(0, -KEY_PAN_STEP);
        break;
      case 'ArrowDown':
        pan(0, KEY_PAN_STEP);
        break;
      case '+':
      case '=':
        e.preventDefault();
        handleZoomButton(ZOOM_STEP);
        break;
      case '-':
      case '_':
        e.preventDefault();
        handleZoomButton(1 / ZOOM_STEP);
        break;
      case '0':
        e.preventDefault();
        handleResetView();
        break;
      default:
        break;
    }
  };

  /* ------------------------------ 绘制 ------------------------------ */

  const activeScreen = useMemo(() => {
    if (!activeSite || !camera || viewport.width <= 0) return null;
    return worldToScreen(projectLngLat(activeSite.longitude, activeSite.latitude), camera, viewport);
  }, [activeSite, camera, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !camera || viewport.width <= 0 || viewport.height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(viewport.width * dpr);
    const pixelHeight = Math.round(viewport.height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    // 拖拽时底图减半密度：帧预算让给「跟手」
    drawLandMask(ctx, camera, viewport, isLight, dragging ? LAND_DOT_SPACING * 2 : LAND_DOT_SPACING);
    drawGraticule(ctx, camera, viewport, isLight);
    drawClusters(ctx, clusters, hover?.key ?? null, activeScreen, isLight);

    // 光点与其柔光先登记占位，地名标签不压在圆点上
    const occupied: LabelRect[] = clusters.map(cluster => {
      const radius = clusterRadius(cluster.points.length) * 2;
      return { x: cluster.x - radius, y: cluster.y - radius, width: radius * 2, height: radius * 2 };
    });
    drawPlaceLabels(ctx, camera, viewport, clusters, isLight, occupied);
    // placesReady 参与依赖：地名表是按需加载的，到位后要补一次重绘把城市标注画上
  }, [camera, viewport, clusters, hover?.key, activeScreen, isLight, dragging, placesReady]);

  /** 视野内的照片数：缩放到某个区域时，一个安静的「这里有多少」读数 */
  const inViewCount = useMemo(() => {
    if (!camera) return 0;
    let count = 0;
    for (const cluster of clusters) {
      if (
        cluster.x < -24 ||
        cluster.y < -24 ||
        cluster.x > viewport.width + 24 ||
        cluster.y > viewport.height + 24
      ) {
        continue;
      }
      count += cluster.points.length;
    }
    return count;
  }, [clusters, camera, viewport]);

  /* ------------------------------ 悬停预览 ------------------------------ */

  const hoverPreview = useMemo(() => hover?.photos.slice(0, 4) ?? [], [hover]);

  const hoverCardStyle = useMemo((): React.CSSProperties | null => {
    if (!hover) return null;
    // 宽度反推：p-1.5（6*2）+ 4 张 50px 缩略图 + 3 个 4px gap = 224；
    // 高度 = 图区 62 + 底部双行信息 ~56。此前 216/158 配 68px 图，第四张必被裁。
    const cardWidth = 224;
    const cardHeight = 122;
    const gap = 16;
    let left = hover.x + gap;
    let top = hover.y - cardHeight / 2;
    if (left + cardWidth > viewport.width - 12) left = hover.x - cardWidth - gap;
    left = Math.max(12, Math.min(left, Math.max(12, viewport.width - cardWidth - 12)));
    top = Math.max(12, Math.min(top, Math.max(12, viewport.height - cardHeight - 12)));
    return { left, top, width: cardWidth };
  }, [hover, viewport]);

  const isEmpty = points.length === 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-transparent">
      <header
        className={`app-drag z-20 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] backdrop-blur-xl ${
          isLeftPaneOpen ? 'px-4' : 'pl-[78px] pr-4'
        }`}
      >
        <div className="app-no-drag flex h-[52px] items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            title="返回图库（Esc）"
            aria-label="返回图库"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] transition-all duration-200 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:scale-[0.98]"
          >
            <ChevronLeftIcon />
          </button>

          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate text-[17px] font-semibold text-[var(--text-primary)]">按地点浏览</h1>
            {!isEmpty && (
              <div className="hidden items-center gap-2 text-[11px] text-[var(--text-tertiary)] lg:flex">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-glass)] px-2 py-0.5">
                  <MapPinIcon />
                  {locationCount} 个地点
                </span>
                <span className="font-numeric tabular-nums">{points.length} 张照片</span>
                {missingCount > 0 && (
                  <span className="text-[var(--text-quaternary)]">· 另有 {missingCount} 张未记录地点</span>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div
        ref={containerRef}
        role="region"
        aria-label="照片地点地图"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={`relative min-h-0 flex-1 overflow-hidden bg-[var(--bg-primary)] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[rgba(var(--accent-blue-rgb),0.5)] ${
          hover ? 'cursor-pointer' : dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {/* 暗房灯：中心一层极淡的暖光，让空海面不是死黑 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: isLight
              ? 'radial-gradient(ellipse at 50% 42%, rgba(166, 99, 21, 0.07), transparent 62%)'
              : 'radial-gradient(ellipse at 50% 42%, rgba(232, 163, 61, 0.07), transparent 62%)',
          }}
        />

        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

        {isEmpty ? (
          <div className="absolute inset-0 flex items-center justify-center px-8">
            <div className="max-w-sm text-center animate-fadeInUp">
              <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-[rgba(var(--accent-blue-rgb),0.1)] border border-[rgba(var(--accent-blue-rgb),0.22)] text-[var(--accent-blue)]">
                <MapPinIcon size={30} />
              </div>
              <h2 className="mb-2 text-xl font-semibold text-[var(--text-primary)]">还没有带地点的照片</h2>
              <p className="mb-6 text-sm leading-relaxed text-[var(--text-tertiary)]">
                {photos.length === 0
                  ? '导入照片后，带 GPS 信息的照片会在这里落成光点，按拍摄地点聚成一个个可浏览的地点。'
                  : `当前图库里的 ${photos.length} 张照片都没有记录拍摄地点。在手机相机的设置里开启「记录位置」再拍摄，导进来就会出现在这里。`}
              </p>
              <button
                type="button"
                onClick={onBack}
                className="rounded-xl border border-[var(--border-default)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-all duration-200 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:scale-[0.98]"
              >
                返回图库
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* 缩放控件：悬浮在地图右上方的玻璃竖簇。地图类工具的通用位置，
                标题栏因此只剩陈述，不堆操作 */}
            <div className="app-no-drag absolute right-4 top-4 z-20 flex flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-lg)] backdrop-blur-xl">
              <button
                type="button"
                onClick={() => handleZoomButton(1.5)}
                title="放大"
                aria-label="放大"
                className="flex h-8 w-8 items-center justify-center text-[var(--text-secondary)] transition-all duration-150 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:scale-[0.95]"
              >
                <PlusIcon />
              </button>
              <div className="h-px bg-[var(--border-subtle)]" aria-hidden />
              <button
                type="button"
                onClick={handleResetView}
                title="回到全部地点"
                aria-label="回到全部地点"
                className="flex h-8 w-8 items-center justify-center text-[var(--text-secondary)] transition-all duration-150 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:scale-[0.95]"
              >
                <CrosshairIcon />
              </button>
              <div className="h-px bg-[var(--border-subtle)]" aria-hidden />
              <button
                type="button"
                onClick={() => handleZoomButton(1 / 1.5)}
                title="缩小"
                aria-label="缩小"
                className="flex h-8 w-8 items-center justify-center text-[var(--text-secondary)] transition-all duration-150 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:scale-[0.95]"
              >
                <MinusIcon />
              </button>
            </div>

            {/* 视野读数：只在「视野内不是全部」时出现（与全部相同就没有信息量） */}
            {!activeSite && inViewCount > 0 && inViewCount < points.length && (
              <div className="pointer-events-none absolute bottom-4 left-4 z-20">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--text-tertiary)] backdrop-blur-xl">
                  视野内
                  <span className="font-numeric tabular-nums text-[var(--text-secondary)]">{inViewCount}</span>
                  张
                </span>
              </div>
            )}

            {/* 悬停预览：一眼看清这个地点拍到了什么 */}
            {hover && !activeSite && hoverCardStyle && (
              <div className="pointer-events-none absolute z-30 animate-scaleIn" style={hoverCardStyle}>
                <div className="overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-lg)] backdrop-blur-xl">
                  <div className="flex gap-1 p-1.5">
                    {hoverPreview.map(photo => (
                      <div
                        key={photo.id}
                        className="relative h-[50px] w-[50px] shrink-0 overflow-hidden rounded-lg bg-[var(--bg-card)]"
                      >
                        <ThumbImage
                          photo={photo}
                          size={136}
                          className="h-full w-full object-cover"
                          alt={photo.name}
                        />
                        {isVideoPhoto(photo) && photo.duration ? (
                          <DurationBadge text={formatVideoDuration(photo.duration)} />
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-[var(--border-subtle)] px-3 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11.5px] font-medium text-[var(--text-secondary)]">
                        {hover.placeHint}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-[var(--text-quaternary)]">
                        {hover.photos.length} 张
                      </span>
                    </div>
                    <div className="font-numeric text-[10px] tabular-nums text-[var(--text-quaternary)]">
                      {formatLatLng(hover.latitude, hover.longitude)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 选中地点：底部拉出照片条 */}
            {activeSite && (
              <div className="absolute inset-x-0 bottom-0 z-30 animate-fadeInUp px-4 pb-4">
                <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-xl)] backdrop-blur-xl">
                  <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-[var(--accent-blue)]">
                      <MapPinIcon size={13} />
                      <span className="truncate text-[12.5px] font-medium">{activeSite.placeHint}</span>
                    </span>
                    <span className="hidden shrink-0 font-numeric text-[11px] tabular-nums text-[var(--text-quaternary)] sm:inline">
                      {formatLatLng(activeSite.latitude, activeSite.longitude)}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-[var(--text-tertiary)]">
                      共 {activeSite.photos.length} 张
                      {activeSite.photos.length > STRIP_LIMIT && `（仅显示前 ${STRIP_LIMIT} 张）`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveSite(null)}
                      title="关闭地点照片条"
                      aria-label="关闭地点照片条"
                      className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>

                  <div className="relative">
                    <div
                      ref={stripScrollRef}
                      onScroll={measureStripEdge}
                      className="custom-scrollbar flex gap-2 overflow-x-auto p-3"
                    >
                    {activeSite.photos.slice(0, STRIP_LIMIT).map(photo => (
                      <button
                        key={photo.id}
                        type="button"
                        onClick={() => onQuickLook(photo, activeSite.photos)}
                        title={photo.name}
                        className="group relative h-[84px] w-[84px] shrink-0 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] transition-[transform,border-color,box-shadow] duration-200 ease-entrance hover:-translate-y-0.5 hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] active:translate-y-0"
                      >
                        <ThumbImage
                          photo={photo}
                          size={168}
                          className="h-full w-full object-cover"
                          alt={photo.name}
                        />
                        {photo.isFavorite && (
                          <span className="absolute left-1.5 top-1.5 z-20 flex h-4 w-4 items-center justify-center rounded-full bg-black/50 backdrop-blur-xs">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="var(--accent-blue)">
                              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                            </svg>
                          </span>
                        )}
                        {isVideoPhoto(photo) && photo.duration ? (
                          <DurationBadge text={formatVideoDuration(photo.duration)} />
                        ) : null}
                      </button>
                    ))}
                    </div>

                    {/* 边缘渐隐：哪一端还有照片，哪一端才亮 */}
                    <div
                      aria-hidden
                      className={`pointer-events-none absolute inset-y-0 left-0 w-7 bg-gradient-to-r from-[var(--bg-elevated)] to-transparent transition-opacity duration-200 ${stripEdge.left ? 'opacity-100' : 'opacity-0'}`}
                    />
                    <div
                      aria-hidden
                      className={`pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-[var(--bg-elevated)] to-transparent transition-opacity duration-200 ${stripEdge.right ? 'opacity-100' : 'opacity-0'}`}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 手势提示：进入后第一次交互即退场，不做常驻噪音 */}
            {!hasInteracted && (
              <div className="pointer-events-none absolute bottom-4 right-4 z-20 hidden md:block">
                <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1 text-[11px] text-[var(--text-quaternary)] backdrop-blur-xl">
                  滚轮缩放 · 拖拽平移 · 双击放大 · 点击光点看照片
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default LocationMap;
