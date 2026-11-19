/** 用合成供应商验证生图插件的配置入口，不调用模型。 */
import { expect, test } from 'bun:test';
import type * as cordis from 'cordis';
import * as imageGen from './index.ts';

test('生图忽略旧 engine，插件模型可配置或留空', () => {
  const providers = { sample: { baseUrl: 'http://127.0.0.1:9', apiKey: '' } };
  const engine = { image_model: 'missing/legacy' };
  let registrations = 0;
  const ctx = {
    resources: { raw: { engine }, config: { providers } },
    tools: { register: () => { registrations += 1; } },
  } as unknown as cordis.Context;

  //M 忽略旧段中的未知供应商，缺省配置仍可登记工具。
  imageGen.apply(ctx);
  expect(registrations).toBe(1);

  //M 接受现行模型与显式空串。
  const current = { image_model: 'sample/current' };
  const empty = { image_model: '' };
  imageGen.apply(ctx, current);
  imageGen.apply(ctx, empty);

  //G 现行配置仍须使用有效的格式和已登记的供应商。
  const invalid = { image_model: 'sample/' };
  const missing = { image_model: 'missing/current' };
  expect(() => imageGen.apply(ctx, invalid)).toThrow('供应商/模型 ID');
  expect(() => imageGen.apply(ctx, missing)).toThrow('供应商 missing');
  expect(registrations).toBe(3);
});
