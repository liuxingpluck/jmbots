/**
 * 界面语言（docs/界面/02_一个程序跑起来的规划.md 第 2 步）：现在有简体中文、繁体中文、英语、法语，将来按 GitHub 上的请求加。
 * 写法：代码里直接写简体中文原文，t('有 {count} 处改动', { count })；简体中文不用语言包，别的语言一个 JSON，原文 → 译文。
 * 加一种语言：在 locales/ 加一个 JSON，在 LANGUAGES 和 PACKS 各加一行，别的代码不用改。缺的词退回英文，再退回原文。
 * 语言存在 config.yaml 的 ui.language（网页和基地读同一个），这个浏览器也记一份，打开时不闪；第一次打开跟系统语言。网址带 ?lang=en 时用它（截图核对用）。
 */
import * as react from 'react';
import en from './locales/en.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import zhTW from './locales/zh-TW.json' with { type: 'json' };
import * as context from './Context.ts';
import * as traceText from './locales/Trace.ts';


/** 支持的语言：代码和它自己的名字（下拉框里显示）。 */
export const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
] as const;

/** 语言代码。 */
export type Language = (typeof LANGUAGES)[number]['code'];

/** 语言包：原文 → 译文。简体中文就是原文，没有包。 */
const PACKS: Partial<Record<Language, Record<string, string>>> = { 'zh-TW': zhTW, en, fr };

/** 浏览器里记语言用的键。 */
const STORAGE_KEY = 'jmbots.language';


/**
 * 一个语言代码认不认识；不认识的按前缀找最接近的（zh-HK → 繁体，en-US → 英语）。
 * @param code 语言代码（config.yaml 里写的，或者系统语言）。
 * @returns 支持的语言；都对不上是 undefined。
 */
export function matchLanguage(code: string | undefined | null): Language | undefined {
  /** 小写。 */
  const lower = (code ?? '').trim().toLowerCase();
  /** 完全一样的。 */
  const exact = LANGUAGES.find((item) => item.code.toLowerCase() === lower);
  if (exact) {
    return exact.code;
  }
  if (/^zh[-_](tw|hk|mo|hant)/.test(lower)) {
    return 'zh-TW';
  }
  if (lower.startsWith('zh')) {
    return 'zh-CN';
  }
  return LANGUAGES.find((item) => lower.startsWith(`${item.code}-`) || lower === item.code)?.code;
}


/**
 * 打开时用哪种语言：这个浏览器记着的（设置里选过的）→ 简体中文。
 * 不跟系统语言走（用户 11-17：默认是中文，要换在设置里换）。
 * @param storage 浏览器本地存储。
 */
export function loadLanguage(storage: Pick<Storage, 'getItem'>): Language {
  //M 读取浏览器里记住的界面语言并归一化到受支持代码，读不到或非法时退回简体中文。
  return matchLanguage(storage.getItem(STORAGE_KEY)) ?? 'zh-CN';
}


/**
 * 记下语言。
 * @param storage 浏览器本地存储。
 * @param language 语言。
 */
export function saveLanguage(storage: Pick<Storage, 'setItem'>, language: Language): void {
  storage.setItem(STORAGE_KEY, language);
}


/**
 * 翻译：查语言包，缺的退回英文，再退回原文；{名字} 换成参数。纯函数好测。
 * @param language 语言。
 * @param text 简体中文原文。
 * @param params 参数。
 */
export function translate(language: Language, text: string, params?: Record<string, string | number>): string {
  if (traceText.isTraceText(text)) {
    const traceLanguage = traceText.getTraceLanguage(language);
    return traceText.getTraceText(traceLanguage, text, params);
  }

  //M 简体中文原文不用再查英文包兜底。
  let fallback: string | undefined;
  if (language !== 'zh-CN') {
    fallback = PACKS.en?.[text];
  }
  /** 译文。 */
  const found = PACKS[language]?.[text] ?? fallback ?? text;
  if (!params) return found;

  //M 把译文里的 {变量名} 占位符替换为实参值，未提供的占位符保持原样以免破坏文案。
  return found.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name in params) return String(params[name]);

    return whole;
  });
}


/** 翻译函数的样子。 */
export type Translate = (text: string, params?: Record<string, string | number>) => string;

/** 跟踪点的已知编号按当前语言翻译，旧记录直接显示原文。 */
export function renderTrace(t: Translate, text: string, params?: traceText.TraceParams): string {
  if (!traceText.isTraceText(text)) return text;

  return t(text, params);
}


/**
 * 不翻译，只把参数填进原文：纯函数模块（状态文字、斜杠命令……）的 t 参数默认用它，测试和没传 t 时是简体中文。
 * @param text 原文。
 * @param params 参数。
 */
export const source: Translate = (text, params) => translate('zh-CN', text, params);


/** 独立子页无全局状态仓库时的空订阅函数。 */
function subscribeStandalone(): () => void {
  return () => undefined;
}


/**
 * 读取独立子页（如 /tutorial/、/work-decision/）的当前语言偏好：网址 ?lang= 优先，其次本地存储，默认简体中文。
 * @returns 语言代码。
 */
function getStandaloneLanguage(): Language {
  if (typeof window === 'undefined') return 'zh-CN';

  const params = new URLSearchParams(window.location.search);
  const asked = matchLanguage(params.get('lang'));
  if (asked !== undefined) return asked;

  try {
    return loadLanguage(window.localStorage);
  } catch {
    return 'zh-CN';
  }
}


/**
 * 组件里用的翻译函数：主页面订阅状态仓库实时切换，独立子页（无 UiContext）直接读取浏览器语言偏好。
 * @returns t。
 */
export function useT(): Translate {
  const store = react.useContext(context.UiContext);
  let subscribe: (onStoreChange: () => void) => () => void = subscribeStandalone;
  if (store !== null) {
    subscribe = store.subscribe;
  }
  const getSnapshot = (): Language => {
    if (store !== null) {
      return matchLanguage(store.getState().language) ?? 'zh-CN';
    }
    return getStandaloneLanguage();
  };
  //M 统一经 useSyncExternalStore 取语言，保证主界面实时响应且独立入口不因缺 UiContext 崩溃。
  const language = react.useSyncExternalStore<Language>(subscribe, getSnapshot, () => 'zh-CN');
  //M 缓存绑定当前语言的 t 函数，避免每次渲染生成新引用导致下游 effect 重复执行。
  return react.useCallback((text, params) => translate(language, text, params), [language]);
}
