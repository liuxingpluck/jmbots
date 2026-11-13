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
 * 打开时用哪种语言：这个浏览器记着的 → 系统语言 → 英语。
 * @param storage 浏览器本地存储。
 * @param system 系统语言（navigator.language）。
 */
export function loadLanguage(storage: Pick<Storage, 'getItem'>, system: string | undefined): Language {
  return matchLanguage(storage.getItem(STORAGE_KEY)) ?? matchLanguage(system) ?? 'en';
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
  /** 译文。 */
  const found = PACKS[language]?.[text] ?? (language === 'zh-CN' ? undefined : PACKS.en?.[text]) ?? text;
  return params ? found.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole)) : found;
}


/** 翻译函数的样子。 */
export type Translate = (text: string, params?: Record<string, string | number>) => string;


/**
 * 不翻译，只把参数填进原文：纯函数模块（状态文字、斜杠命令……）的 t 参数默认用它，测试和没传 t 时是简体中文。
 * @param text 原文。
 * @param params 参数。
 */
export const source: Translate = (text, params) => translate('zh-CN', text, params);


/**
 * 组件里用的翻译函数：语言变了组件跟着重画。
 * @returns t。
 */
export function useT(): Translate {
  /** 现在的语言。 */
  const language = context.useUi((state) => state.language);
  return react.useCallback((text, params) => translate(language, text, params), [language]);
}
