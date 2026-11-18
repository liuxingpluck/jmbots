/** 决策图新加的界面字按 jmbots 的语言包翻译，简体中文原样显示。 */
import * as i18n from '../I18n.ts';

/** 打开页面时用哪种语言：网址带 ?lang= 时用它，否则用浏览器记着的。 */
function getLanguage(): i18n.Language {
  //M 网址参数方便截图核对别的语言。
  const params = new URLSearchParams(window.location.search);
  const asked = i18n.matchLanguage(params.get('lang'));
  if (asked !== undefined) return asked;

  //G 隐私模式下读本地存储可能抛错，读不到就用简体中文。
  try {
    return i18n.loadLanguage(window.localStorage);
  } catch {
    return 'zh-CN';
  }
}

/** 页面打开时定一次语言，切换语言要刷新页面。 */
//M 模块加载时读一次，整页用同一种语言。
const LANGUAGE = getLanguage();

/**
 * 翻译一句界面字。
 * @param text 简体中文原文。
 * @param params 原文里 {名字} 的值。
 * @returns 当前语言的译文，缺词退回原文。
 */
export function t(text: string, params?: Record<string, string | number>): string {
  //M 交给 jmbots 的语言包查词，缺词退回英文再退回原文。
  return i18n.translate(LANGUAGE, text, params);
}
