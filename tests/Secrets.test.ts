/**
 * 密钥替身的离线测试：真值 ↔ 替身来回换、长密钥先换、太短的不换、原文里的替身字样不误伤、
 * 认不出的替身不抛错、names() 不泄真值。全部用假密钥，不出现任何真实密钥。
 */
import * as bunTest from 'bun:test';
import * as secrets from '../src/capabilities/Secrets.ts';


/** 假的密钥真值，专门造的，跟真实密钥无关。 */
const FAKE_APP_SECRET = 'fake-secret-abcdefgh';

/** 另一个假的密钥真值。 */
const FAKE_TOKEN = 'another-fake-token-1234';


bunTest.test('同一个真值出现多次都换成替身，换回来跟原文一模一样', () => {
  /** 替身表。 */
  const table = new secrets.Secrets([FAKE_APP_SECRET]);
  /** 原文：这个真值出现两次。 */
  const text = `app_secret=${FAKE_APP_SECRET}\nagain=${FAKE_APP_SECRET}`;
  /** 换过之后的文字。 */
  const masked = table.mask(text);
  bunTest.expect(masked).toBe('app_secret={{secret:1}}\nagain={{secret:1}}');
  bunTest.expect(masked).not.toContain(FAKE_APP_SECRET);
  bunTest.expect(table.unmask(masked)).toBe(text);
});


bunTest.test('长密钥先换，不会被短密钥切坏', () => {
  /** 短的真值。 */
  const shortValue = 'abcd1234';
  /** 长的真值，前缀和短的一模一样。 */
  const longValue = 'abcd12345678';
  /** 替身表：短的是第 1 条，长的是第 2 条。 */
  const table = new secrets.Secrets([shortValue, longValue]);
  bunTest.expect(table.mask(`a=${longValue}`)).toBe('a={{secret:2}}');
  bunTest.expect(table.mask(`a=${shortValue}`)).toBe('a={{secret:1}}');
  /** 两个一起出现：长的不许被切成 {{secret:1}}5678。 */
  const text = `short=${shortValue}\nlong=${longValue}`;
  bunTest.expect(table.mask(text)).toBe('short={{secret:1}}\nlong={{secret:2}}');
  bunTest.expect(table.unmask(table.mask(text))).toBe(text);
});


bunTest.test('不到 8 个字的真值不参与替换', () => {
  /** 7 个字的真值、空串、刚好 8 个字的真值。 */
  const table = new secrets.Secrets(['abc1234', '', 'abcd1234']);
  bunTest.expect(table.names()).toEqual(['{{secret:1}}']);
  bunTest.expect(table.mask('abc1234 abcd1234')).toBe('abc1234 {{secret:1}}');
  bunTest.expect(table.unmask('abc1234 {{secret:1}}')).toBe('abc1234 abcd1234');
});


bunTest.test('文字里本来就有的 {{secret:1}} 字样 round-trip 后原样还在', () => {
  /** 替身表。 */
  const table = new secrets.Secrets([FAKE_APP_SECRET]);
  /** 原文：既有像替身的字样，也有真值。 */
  const text = `注意 {{secret:1}} 是示例，真值是 ${FAKE_APP_SECRET}`;
  /** mask 先把示例字样转义，再把真值换成替身。 */
  const masked = table.mask(text);
  bunTest.expect(masked).toBe('注意 {{secret-literal:1}} 是示例，真值是 {{secret:1}}');
  bunTest.expect(table.unmask(masked)).toBe(text);
});


bunTest.test('编号超范围的替身原样留着，不抛错', () => {
  /** 只有一条真值，所以编号 2 和 99 都认不出来。 */
  const table = new secrets.Secrets([FAKE_APP_SECRET]);
  bunTest.expect(table.unmask('a {{secret:2}} b {{secret:99}} c')).toBe('a {{secret:2}} b {{secret:99}} c');
  bunTest.expect(new secrets.Secrets([]).unmask('{{secret:1}}')).toBe('{{secret:1}}');
  bunTest.expect(new secrets.Secrets([]).mask('{{secret:1}}')).toBe('{{secret:1}}');
});


bunTest.test('names() 只有代号，不含任何真值', () => {
  /** 替身表。 */
  const table = new secrets.Secrets([FAKE_APP_SECRET, FAKE_TOKEN]);
  /** 代号列表。 */
  const names = table.names();
  bunTest.expect(names).toEqual(['{{secret:1}}', '{{secret:2}}']);
  //G 列表里一个真值都不许出现。
  for (const name of names) {
    bunTest.expect(name.includes(FAKE_APP_SECRET)).toBe(false);
    bunTest.expect(name.includes(FAKE_TOKEN)).toBe(false);
  }
  //M 返回的是副本，调用方改掉也不影响内部。
  names.length = 0;
  bunTest.expect(table.names()).toEqual(['{{secret:1}}', '{{secret:2}}']);
});


bunTest.test('重复的真值只占一个编号', () => {
  /** 替身表：第一个真值传了两遍。 */
  const table = new secrets.Secrets([FAKE_APP_SECRET, FAKE_APP_SECRET, FAKE_TOKEN]);
  bunTest.expect(table.names()).toEqual(['{{secret:1}}', '{{secret:2}}']);
  bunTest.expect(table.mask(`${FAKE_APP_SECRET} ${FAKE_APP_SECRET}`)).toBe('{{secret:1}} {{secret:1}}');
});
