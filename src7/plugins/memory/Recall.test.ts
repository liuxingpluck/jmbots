/** 基地服务可选、延后挂载和记忆索引降级的行为回归；不访问真实基地。 */
import { describe, expect, test } from 'bun:test';
import type * as cordis from 'cordis';
import type { Base as BaseService } from '../base-bridge/index.ts';
import * as recall from './Recall.ts';
import { Libs } from './Libs.ts';

//M 只替换基地的公共请求接口；Recall 和 Libs 使用真实实现。
type Service = Pick<BaseService, 'getJson' | 'postJson'>;

describe('记忆通过可选基地服务请求', () => {
  test('没挂基地时检索为空、增量刷新没有错误；晚挂服务后同一配置立即可用', async () => {
    let service: Service | undefined;
    const ctx = { get: () => service } as unknown as cordis.Context;
    const base: recall.Base = { ctx, libs: '测试库' };
    const refresh = new Libs(ctx, base, 0);
    expect(await recall.searchLibs(base, '测试', 3)).toEqual([]);
    expect(await refresh.refresh(['测试库'])).toEqual([]);

    //M 先建 memory、后挂 base 也能得到结果，不缓存 apply 时的 undefined。
    service = {
      getJson: async () => ({ status: 200, body: { hits: [{ path: 'a.md', text: '测试结果' }], not_indexed: [] } }),
      postJson: async () => ({ status: 200, body: {} }),
    };
    expect(await recall.searchLibs(base, '测试', 3)).toEqual([{ path: 'a.md', summary: '', snippet: '测试结果' }]);
  });

  test('基地断连时检索和增量刷新静默结束', async () => {
    const service: Service = {
      getJson: async () => { throw new Error('基地没响应'); },
      postJson: async () => { throw new Error('基地没响应'); },
    };
    const ctx = { get: () => service } as unknown as cordis.Context;
    const base: recall.Base = { ctx, libs: '测试库' };
    expect(await recall.libs(base, '测试')).toEqual([]);
    expect(await new Libs(ctx, base, 0).refresh(['测试库'])).toEqual([]);
  });

  test('旧基地没有 RAG 时仍退回老搜索', async () => {
    const paths: string[] = [];
    const service: Service = {
      getJson: async (route) => {
        paths.push(route);
        if (route.startsWith('/rag/')) return { status: 404, body: { error: '没有这个接口' } };
        return { status: 200, body: { results: [{ lib: '测试库', path: 'a.md', text: '旧搜索结果' }] } };
      },
      postJson: async () => ({ status: 200, body: {} }),
    };
    const ctx = { get: () => service } as unknown as cordis.Context;
    expect(await recall.searchLibs({ ctx, libs: '测试库' }, '测试', 3)).toEqual([
      { path: '测试库:a.md', summary: '', snippet: '旧搜索结果' },
    ]);
    expect(paths.map((route) => route.split('?')[0])).toEqual(['/rag/search', '/search']);
  });

  test('摄取 409 等待已有任务，400 老库跳过摄取，随后都继续建 RAG', async () => {
    for (const status of [409, 400]) {
      const calls: string[] = [];
      const service: Service = {
        getJson: async (route) => {
          calls.push(route);
          return { status: 200, body: { job: { running: false } } };
        },
        postJson: async (route) => {
          calls.push(route);
          return { status: route === '/ingest' ? status : 200, body: {} };
        },
      };
      const ctx = { get: () => service } as unknown as cordis.Context;
      expect(await new Libs(ctx, { ctx, libs: 'lib' }, 0).refresh(['lib'])).toEqual([]);
      expect(calls).toEqual(status === 409 ? ['/ingest', '/ingest?lib=lib', '/rag/index'] : ['/ingest', '/rag/index']);
    }
  });

  test('基地在线时明确的业务错误继续报告', async () => {
    const service: Service = {
      getJson: async () => ({ status: 200, body: {} }),
      postJson: async () => ({ status: 500, body: { error: '索引失败' } }),
    };
    const ctx = { get: () => service } as unknown as cordis.Context;
    expect(await new Libs(ctx, { ctx, libs: 'lib' }, 0).refresh(['lib'])).toEqual([
      'lib：摄取没开始（500）',
      'lib：RAG 索引没开始建（500）',
    ]);
  });
});
