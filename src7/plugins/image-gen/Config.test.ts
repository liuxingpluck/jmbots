/** 用合成供应商验证生图插件的新旧配置优先级，不调用模型。 */
import { expect, test } from 'bun:test';
import type * as cordis from 'cordis';
import * as imageGen from './index.ts';

test('生图配置兼容旧值，新值优先且可以清空', () => {
  const providers = { sample: { baseUrl: 'http://127.0.0.1:9', apiKey: '' } };
  const engine = { image_model: 'sample/legacy' };
  let registrations = 0;
  const ctx = {
    resources: { raw: { engine }, config: { providers } },
    tools: { register: () => { registrations += 1; } },
  } as unknown as cordis.Context;

  imageGen.apply(ctx);
  expect(registrations).toBe(1);

  engine.image_model = 'missing/legacy';
  expect(() => imageGen.apply(ctx)).toThrow('供应商 missing');
  expect(registrations).toBe(1);

  imageGen.apply(ctx, { image_model: 'sample/current' });
  imageGen.apply(ctx, { image_model: '' });
  expect(() => imageGen.apply(ctx, { image_model: 'sample/' })).toThrow('供应商/模型 ID');
  expect(registrations).toBe(3);
});
