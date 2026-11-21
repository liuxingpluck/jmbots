/**
 * 教程视图模式、导图树种类与多语言状态钩子（不依赖 @xyflow/react 或 d3-hierarchy，供首屏壳直接引用）。
 */
import * as react from 'react';
import * as i18n from '../I18n.ts';


const VIEW_KEY = 'jmbots.tutorial.view';
const TREE_KEY = 'jmbots.tutorial.mind-tree';
const VIEWS = ['canvas', 'mind'] as const;
const TREES = ['project', 'trace', 'lines'] as const;

export type TreeView = (typeof TREES)[number];
export type TraceSubMode = 'flow' | 'plugin' | 'table';


/** 读取持久化选择，只接受给定选项，访问失败使用默认。 */
export function getStoredChoice<T extends string>(key: string, defaults: T, allowed: readonly T[]): T {
  try {
    const saved = window.localStorage.getItem(key);
    //G 忽略旧值和无法识别的值。
    const chosen = allowed.find((option) => option === saved);
    return chosen ?? defaults;
  } catch {
    return defaults;
  }
}


/** 保存非敏感的视图偏好，存储禁用时界面继续工作。 */
export function saveStoredChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    //G 存储不可用也允许切换视图。
  }
}


/** 在原画布和思维导图之间保留上次使用的选择；地址带 ?view= 时优先，手机直开 ?canvas= 默认进步骤流。 */
export function useTutorialView(): { view: 'canvas' | 'mind'; select: (next: 'canvas' | 'mind') => void } {
  //M 优先读地址栏显式指定的视图；手机竖屏点开具体消息画布时默认进纵向步骤卡片而非上次残留的导图。
  const [view, setView] = react.useState<'canvas' | 'mind'>(() => {
    const query = new URLSearchParams(window.location.search);
    const requested = query.get('view');
    if (requested === 'canvas' || requested === 'mind') return requested;
    if (window.innerWidth < 800 && query.get('canvas') !== null) return 'canvas';

    return getStoredChoice(VIEW_KEY, 'canvas', VIEWS);
  });
  const select = (next: 'canvas' | 'mind'): void => {
    //M 控件马上切换，同时为下次打开记住选择。
    setView(next);
    saveStoredChoice(VIEW_KEY, next);
  };
  return { view, select };
}


/** 画布上显示哪棵树（项目结构、消息走过的路、骨架逐行），由左栏点选，记住上次的。 */
export function useMindTree(): { mode: TreeView; select: (next: TreeView) => void } {
  //M 第一次打开是项目结构，以后恢复上次看的树。
  const [mode, setMode] = react.useState(() => getStoredChoice(TREE_KEY, 'project', TREES));
  const select = react.useCallback((next: TreeView): void => {
    //M 马上换树，同时为下次打开记住。
    setMode(next);
    saveStoredChoice(TREE_KEY, next);
  }, []);
  return { mode, select };
}


/** 教程独立入口沿用地址和浏览器语言偏好。 */
export function useMindWords(): i18n.Translate {
  const [language] = react.useState<i18n.Language>(() => {
    const query = new URLSearchParams(window.location.search);
    //M 地址里的语言优先，便于独立打开教程链接。
    const requested = query.get('lang');
    const explicit = i18n.matchLanguage(requested);
    if (explicit !== undefined) return explicit;

    try {
      //M 没有显式语言时沿用网页记住的语言。
      const storage = window.localStorage;
      return i18n.loadLanguage(storage);
    } catch {
      return 'zh-CN';
    }
  });
  //M 给树和右栏持有同一稳定的翻译函数。
  return react.useCallback((key, params) => i18n.translate(language, key, params), [language]);
}
