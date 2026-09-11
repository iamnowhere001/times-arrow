/**
 * 外观模式 Hook（从 App 抽出）。
 *
 * 管理「明亮 / 暗黑 / 跟随系统」三态，并在 theme === 'system' 时通过 matchMedia
 * 实时响应系统深浅色偏好。主题真正变化时挂一次全局颜色过渡，播完立刻摘掉。
 */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/** 外观模式：明亮 / 暗黑 / 跟随系统（后两者可实时响应 OS 深浅色偏好） */
export type Theme = 'dark' | 'light' | 'system';

export interface UseThemeModeResult {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  /** 解析出的实际主题：跟随系统时取系统偏好，否则取用户显式选择 */
  resolvedTheme: 'dark' | 'light';
  isLight: boolean;
}

export function useThemeMode(): UseThemeModeResult {
  // 外观模式：明亮 / 暗黑 / 跟随系统，默认跟随系统
  const [theme, setTheme] = useState<Theme>('system');
  // 系统当前深浅色（仅 theme === 'system' 时生效）：用 matchMedia 监听，Electron 与浏览器通用
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  );
  // 解析出的实际主题：跟随系统时取系统偏好，否则取用户显式选择
  const resolvedTheme: 'dark' | 'light' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const isLight = resolvedTheme === 'light';
  // 主题切换过渡的卸载计时器：连续切换时只保留最后一次
  const themeTransitionTimerRef = useRef<number | null>(null);
  const isFirstThemeApply = useRef(true);

  // 监听系统深浅色偏好变化，跟随系统时实时切换
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    setSystemDark(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // 主题真正变化的那一刻才挂上全局颜色过渡，播完立刻摘掉：
  // 常驻 transition 会拖慢所有 hover / 按下的响应；首次渲染不播，避免开局幻跳
  useEffect(() => {
    if (isFirstThemeApply.current) {
      isFirstThemeApply.current = false;
      return;
    }
    if (themeTransitionTimerRef.current !== null) {
      window.clearTimeout(themeTransitionTimerRef.current);
    }
    document.documentElement.classList.add('theme-transition');
    themeTransitionTimerRef.current = window.setTimeout(() => {
      document.documentElement.classList.remove('theme-transition');
      themeTransitionTimerRef.current = null;
    }, 240);
  }, [resolvedTheme]);

  return { theme, setTheme, resolvedTheme, isLight };
}
