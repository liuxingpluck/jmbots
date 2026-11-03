/**
 * 藏密钥的离线测试：工具结果里出现配置里的密钥（字符串、对象里、带引号转义的）都换成 ***，没出现时原样返回。
 */
import * as bunTest from 'bun:test';
import * as utils from '../src/utils/Utils.ts';


bunTest.test('字符串和对象里的密钥都换成 ***', () => {
  bunTest.expect(utils.redactSecrets('106:    app_secret: \'abcDEF123456\'', ['abcDEF123456'])).toBe('106:    app_secret: \'***\'');
  bunTest.expect(utils.redactSecrets({ output: 'key=ab"cd\\efgh', code: 0 }, ['ab"cd\\efgh'])).toEqual({ output: 'key=***', code: 0 });
});


bunTest.test('没有密钥出现时原样返回同一个值', () => {
  /** 原值。 */
  const value = { output: 'hello' };
  bunTest.expect(utils.redactSecrets(value, ['abcDEF123456'])).toBe(value);
  bunTest.expect(utils.redactSecrets(undefined, ['abcDEF123456'])).toBeUndefined();
});
