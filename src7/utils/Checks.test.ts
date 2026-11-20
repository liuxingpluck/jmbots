/** Checks.ts 里插件共用的配置校验：checkNumber、checkFlag、checkModelRef。 */

import { expect, test } from 'bun:test';
import type { ProviderConfig } from '../Resources.ts';
import * as checks from './Checks.ts';


test('checkNumber 按范围收数，报错说清该写成什么样', () => {
  //M 正整数：沿用原来的说法。
  expect(checks.checkNumber(3, 'a', checks.POSITIVE_INT)).toBe(3);
  expect(() => checks.checkNumber(0, 'a', checks.POSITIVE_INT)).toThrow('a 要写成正整数');
  expect(() => checks.checkNumber(1.5, 'a', checks.POSITIVE_INT)).toThrow('a 要写成正整数');
  expect(() => checks.checkNumber('3', 'a', checks.POSITIVE_INT)).toThrow('a 要写成正整数');

  //M 闭区间与左开区间：边界上的值看 min、above 区分。
  const probability = { min: 0, max: 1 };
  expect(checks.checkNumber(0, 'p', probability)).toBe(0);
  expect(() => checks.checkNumber(1.1, 'p', probability)).toThrow('p 要写成不小于 0 且不大于 1 的数');
  const similarity = { above: 0, max: 1 };
  expect(checks.checkNumber(1, 's', similarity)).toBe(1);
  expect(() => checks.checkNumber(0, 's', similarity)).toThrow('s 要写成大于 0 且不大于 1 的数');

  //M 不给范围：任意有限的数，NaN、Infinity 不收。
  expect(checks.checkNumber(-2.5, 'n')).toBe(-2.5);
  expect(() => checks.checkNumber(Number.NaN, 'n')).toThrow('n 要写成数');
  expect(() => checks.checkNumber(Infinity, 'n')).toThrow('n 要写成数');
});


test('checkFlag 只收 true 或 false', () => {
  expect(checks.checkFlag(false, 'f')).toBe(false);
  expect(() => checks.checkFlag('true', 'f')).toThrow('f 要写成 true 或 false');
});


test('checkModelRef 要写成“供应商名/模型 ID”，供应商要在 providers 里', () => {
  const providers = { known: {} } as unknown as Record<string, ProviderConfig>;
  expect(checks.checkModelRef('known/model/v1', 'm', providers)).toBe('known/model/v1');
  expect(() => checks.checkModelRef('known', 'm', providers)).toThrow('m 要写成“供应商名/模型 ID”');
  expect(() => checks.checkModelRef('known/', 'm', providers)).toThrow('m 要写成“供应商名/模型 ID”');
  expect(() => checks.checkModelRef('other/x', 'm', providers)).toThrow('m 的供应商不在 providers 里：other/x');
  expect(() => checks.checkModelRef('', 'm', providers)).toThrow('m 要写成非空的文字');
});
