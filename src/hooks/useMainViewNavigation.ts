import { useCallback, useState } from 'react';

/**
 * 主视图导航。
 *
 * 六个视图是互斥的整页切换，没有「返回栈」——从任何一个整页视图返回都只回图库。
 * 因此这里只提供三个动作：`goTo(view)`、`backToLibrary()`、以及状态本身。
 *
 * 改造前 App 里有七个 `useCallback(() => setMainView('xxx'), [])` 的单行包装，
 * 其中四个（进入相似检测 / 退出相似检测 / 退出关于页 / 返回图库）语义完全相同，
 * 只是写给不同调用点的。收在这里之后，调用点直接用 `goTo('duplicates')` 或
 * `backToLibrary`，不需要再维护同义的包装函数。
 *
 * 剩下的三个（侧栏的「时光画廊 / 按地点 / 关于」入口）仍保留在 App：
 * Sidebar 是 `React.memo` 的，必须给它稳定引用，内联箭头会破坏 memo。
 */
export type MainView = 'library' | 'timeline' | 'map' | 'people' | 'duplicates' | 'about';

export interface MainViewNavigation {
  mainView: MainView;
  /** 直接设置：仅用于需要「原样转交」的场景，正常路径请用 goTo */
  setMainView: (view: MainView) => void;
  goTo: (view: MainView) => void;
  backToLibrary: () => void;
}

export function useMainViewNavigation(initial: MainView = 'library'): MainViewNavigation {
  const [mainView, setMainViewState] = useState<MainView>(initial);
  const setMainView = useCallback((view: MainView) => setMainViewState(view), []);
  const goTo = useCallback((view: MainView) => setMainViewState(view), []);
  const backToLibrary = useCallback(() => setMainViewState('library'), []);

  return { mainView, setMainView, goTo, backToLibrary };
}
