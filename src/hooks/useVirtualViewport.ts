import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface VirtualViewportOptions {
  /**
   * 宽度按「内容区」算（扣掉滚动容器横向内边距）。
   * 网格铺行必须开：clientWidth 含 p-4 的 32px，直接拿去铺行会让最右一张
   * 越出内容区，撑出横向滚动条。列表只关心高度，无需开启。
   */
  contentWidth?: boolean;
  /** 每次滚动事件同步回调（rAF 节流之前），用于持续记录滚动位置 */
  onScroll?: (top: number) => void;
}

/**
 * 虚拟化共用的视口状态：ResizeObserver 量尺寸 + rAF 节流 scrollTop。
 * 网格（绝对定位铺行）与列表（占位行）两套窗口化都从这里取，
 * 滚动事件频率远高于刷新率，直接 setState 会造成大量无效重渲染。
 */
export function useVirtualViewport(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  { contentWidth = false, onScroll }: VirtualViewportOptions = {}
) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const update = () => {
      let width = el.clientWidth;
      if (contentWidth) {
        const style = getComputedStyle(el);
        const paddingX =
          (Number.parseFloat(style.paddingLeft) || 0) +
          (Number.parseFloat(style.paddingRight) || 0);
        width = Math.max(0, width - paddingX);
      }
      const height = el.clientHeight;
      setViewport((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height }
      );
    };
    update();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef, contentWidth]);

  // 回调存 ref：调用方可以传内联闭包，handleScroll 仍保持稳定引用
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;

  const rafRef = useRef(0);
  const pendingTopRef = useRef(0);
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    pendingTopRef.current = top;
    onScrollRef.current?.(top);
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      // 取帧内最新值而非首个事件值：快速滚动时少渲染一帧过期位置
      setScrollTop((prev) => (prev === pendingTopRef.current ? prev : pendingTopRef.current));
    });
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  return { viewport, scrollTop, handleScroll };
}
