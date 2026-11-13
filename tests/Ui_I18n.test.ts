/**
 * 界面语言（web/src/I18n.ts）的离线测试：三个语言包的键和提取结果一致、没有空值、占位符和原文一样；
 * translate 缺词退回英文再退回原文、填参数；matchLanguage、loadLanguage、saveLanguage。
 * 提取脚本在 scripts/I18n_Extract.ts，键的来源和它保持一致。
 */
import * as bunTest from 'bun:test';
import * as extract from '../scripts/I18n_Extract.ts';
import * as i18n from '../web/src/I18n.ts';
import enJson from '../web/src/locales/en.json' with { type: 'json' };
import frJson from '../web/src/locales/fr.json' with { type: 'json' };
import zhTWJson from '../web/src/locales/zh-TW.json' with { type: 'json' };


/** 英语包。 */
const enPack = enJson as Record<string, string>;

/** 法语包。 */
const frPack = frJson as Record<string, string>;

/** 繁体中文包。 */
const zhTWPack = zhTWJson as Record<string, string>;


/**
 * 一段文字里的占位符名字（{count} → count），排好序。
 * @param text 文字。
 */
function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}


/**
 * 造一个只要 getItem 的本地存储。
 * @param items 存着的东西。
 */
function storageOf(items: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (key) => items[key] ?? null };
}


bunTest.describe('语言包', () => {
  bunTest.test('每个语言包的键都和提取结果一样、没有空值、占位符和原文一样', () => {
    /** 要翻译的全部原文。 */
    const keys = extract.collectKeys();
    bunTest.expect(keys.length).toBeGreaterThan(0);
    /** 三个包。 */
    const packs: Record<string, Record<string, string>> = { 'zh-TW': zhTWPack, en: enPack, fr: frPack };
    for (const pack of Object.values(packs)) {
      bunTest.expect(Object.keys(pack).sort()).toEqual(keys);
      for (const key of keys) {
        /** 译文。 */
        const value = pack[key] ?? '';
        bunTest.expect(value.length).toBeGreaterThan(0);
        bunTest.expect(placeholdersOf(value)).toEqual(placeholdersOf(key));
      }
    }
  });
});


bunTest.describe('翻译', () => {
  bunTest.test('填参数：原文和译文里的 {名字} 都换成值', () => {
    /** 带一个参数的原文。 */
    const key = '有 {count} 处改动还没保存';
    bunTest.expect(i18n.translate('zh-CN', key, { count: 3 })).toBe('有 3 处改动还没保存');
    bunTest.expect(i18n.translate('en', key, { count: 3 })).toBe(enPack[key]!.replace('{count}', '3'));
    bunTest.expect(i18n.translate('fr', key, { count: 3 })).toBe(frPack[key]!.replace('{count}', '3'));
    bunTest.expect(i18n.translate('zh-TW', key, { count: 3 })).toBe(zhTWPack[key]!.replace('{count}', '3'));
  });

  bunTest.test('缺词退回英文；英文也没有就退回原文', () => {
    /** 拿一个三个包都有的词。 */
    const key = '等待中';
    /** 英文译文。 */
    const english = enPack[key]!;
    /** 先拿掉法语的，看看是不是用英文顶。 */
    const saved = frPack[key]!;
    delete frPack[key];
    try {
      bunTest.expect(i18n.translate('fr', key)).toBe(english);
    } finally {
      frPack[key] = saved;
    }
    bunTest.expect(i18n.translate('fr', '这句三个包都没有')).toBe('这句三个包都没有');
    bunTest.expect(i18n.translate('en', '这句三个包都没有')).toBe('这句三个包都没有');
  });
});


bunTest.describe('认语言', () => {
  bunTest.test('繁体、简体、英语、法语的变体都认；不认识的不猜', () => {
    bunTest.expect(i18n.matchLanguage('zh-HK')).toBe('zh-TW');
    bunTest.expect(i18n.matchLanguage('zh-TW')).toBe('zh-TW');
    bunTest.expect(i18n.matchLanguage('ZH-hant')).toBe('zh-TW');
    bunTest.expect(i18n.matchLanguage('zh-SG')).toBe('zh-CN');
    bunTest.expect(i18n.matchLanguage('zh')).toBe('zh-CN');
    bunTest.expect(i18n.matchLanguage('en-US')).toBe('en');
    bunTest.expect(i18n.matchLanguage('fr-CA')).toBe('fr');
    bunTest.expect(i18n.matchLanguage('de')).toBeUndefined();
    bunTest.expect(i18n.matchLanguage('')).toBeUndefined();
    bunTest.expect(i18n.matchLanguage(undefined)).toBeUndefined();
  });

  bunTest.test('打开时：浏览器记着的 → 系统语言 → 英语；记下的能读回来', () => {
    bunTest.expect(i18n.loadLanguage(storageOf({}), 'en-US')).toBe('en');
    bunTest.expect(i18n.loadLanguage(storageOf({ 'jmbots.language': 'zh-HK' }), 'en-US')).toBe('zh-TW');
    bunTest.expect(i18n.loadLanguage(storageOf({ 'jmbots.language': 'fr' }), 'en-US')).toBe('fr');
    bunTest.expect(i18n.loadLanguage(storageOf({ 'jmbots.language': '乱写' }), 'de')).toBe('en');
    /** 记下来的。 */
    const saved: Record<string, string> = {};
    i18n.saveLanguage({ setItem: (key, value) => void (saved[key] = value) }, 'fr');
    bunTest.expect(saved['jmbots.language']).toBe('fr');
  });
});
