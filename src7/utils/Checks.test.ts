/** Checks.ts 里插件共用的配置校验：checkNumber、checkFlag、checkModelRef。 */

import { expect, test } from 'bun:test';
import type { ProviderConfig } from '../Resources.ts';
import * as checks from './Checks.ts';
import * as failureModule from './Failure.ts';


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


test('通用校验与网址整数校验统一抛出带 status=400 的 Failure', () => {
  const catch400 = (run: () => unknown): void => {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(failureModule.Failure);
    expect((caught as failureModule.Failure).status).toBe(400);
  };

  catch400(() => checks.checkRecord([], '请求体'));
  catch400(() => checks.checkArray({}, 'items'));
  catch400(() => checks.checkNonEmptyText('', 'name'));
  catch400(() => checks.checkNumber('x', 'port', { integer: true, min: 1, max: 65535 }));
  catch400(() => checks.checkFlag('yes', 'enabled'));
  catch400(() => checks.checkAllowedValue('bad', ['ok', 'no'] as const, 'mode'));
  catch400(() => checks.checkCount('1.5', 'limit'));
  catch400(() => checks.checkDirs('not-array', 'dirs'));
  catch400(() => checks.checkGrants('not-object'));
  catch400(() => checks.checkGrantDir('relative/path'));
  expect(checks.checkCount(undefined, 'limit')).toBeUndefined();
  expect(checks.checkCount('', 'limit')).toBeUndefined();
  expect(checks.checkCount('42', 'limit')).toBe(42);
});


test('不写 plugins 段时默认挂上 db，排在最前，context-fit 等得到它', () => {
  const raw = { providers: { mock: { base_url: 'http://127.0.0.1:9' } }, default_model: 'mock/primary' };
  const config = checks.checkConfig(raw);
  const names = config.plugins.map((item) => item.name);
  expect(names).toEqual(['db', 'workspaces', 'bots', 'cli', 'file-tools', 'context-fit']);
});
