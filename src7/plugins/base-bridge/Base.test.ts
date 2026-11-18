/**
 * 基地服务的行为回归：真实 Cordis、Fastify inject 和临时假基地，不接生产服务。
 * 跑法：bun test ./src7/plugins/base-bridge/Base.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import fastify, { type FastifyInstance } from 'fastify';
import { requestEvent } from '../../utils/RequestEvent.ts';
import * as bridge from './index.ts';

//M 每个用例关闭自己的插件和临时 HTTP 服务，不改全局 fetch。
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

//M 假配置只提供入口需要的 raw；不读运行时配置文件。
class FakeResources extends cordis.Service {
  constructor(ctx: cordis.Context, readonly raw: Record<string, unknown>) {
    super(ctx, 'resources');
  }
}

//M 网页接口使用 Fastify inject，只有假基地会监听随机端口。
class FakeHttp extends cordis.Service {
  constructor(ctx: cordis.Context, readonly app: FastifyInstance) {
    super(ctx, 'http');
  }
}

//M 挂真实插件，返回共享服务和网页 HTTP 实例。
async function world(indexUrl?: unknown, withHttp = true): Promise<{
  ctx: cordis.Context;
  app: FastifyInstance;
  raw: { engine: { index_url: unknown } };
  base: bridge.Base;
}> {
  const ctx = new cordis.Context();
  const app = fastify();
  const raw = { engine: { index_url: indexUrl } };
  closers.push(() => app.close());
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources, raw);
  if (withHttp) await ctx.plugin(FakeHttp, app);
  await ctx.plugin(bridge);
  const base = ctx.get('base') as bridge.Base | undefined;
  if (base === undefined) throw new Error('基地服务没有挂上');
  return { ctx, app, raw, base };
}

//M 假基地统一在测试结束后关闭；地址由操作系统分配，不使用生产端口。
function upstream(): FastifyInstance {
  const app = fastify();
  closers.push(() => app.close());
  return app;
}

describe('base-bridge 基地服务', () => {
  //M 八条基地专属接口都说明未配置，GET 不再用空结果当作成功。
  test('没配地址时，全部转发回 503，服务请求也说明原因', async () => {
    const { app, base } = await world();
    const routes = [
      ['GET', '/api/update'],
      ['POST', '/api/update/apply'],
      ['GET', '/api/autostart'],
      ['POST', '/api/autostart'],
      ['GET', '/api/memory/health'],
      ['GET', '/api/memory/search?q=test'],
      ['GET', '/api/rag/search?q=test'],
      ['POST', '/api/rag/index'],
    ] as const;
    for (const [method, url] of routes) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: string }>()).toEqual({ error: '没配 engine.index_url' });
    }
    await expect(base.getJson('/health', 100)).rejects.toThrow('没配 engine.index_url');
    await expect(base.postJson('/notify', {}, 100)).rejects.toThrow('没配 engine.index_url');
  });

  //M 服务不依赖 HTTP；入口去掉两端空白和末尾斜杠，之后不重读配置。
  test('没挂 http 仍提供服务，基地地址只在入口读取一次', async () => {
    const { ctx, raw, base } = await world('  http://127.0.0.1:32123/root///  ', false);
    expect(base.url).toBe('http://127.0.0.1:32123/root');
    expect(ctx.get('http')).toBeUndefined();
    raw.engine.index_url = 'http://127.0.0.1:32124';
    expect(base.url).toBe('http://127.0.0.1:32123/root');
  });

  //M 非法外部配置在入口拒绝，不等到每次发请求时才报错。
  test('拒绝错误类型、相对地址、非 HTTP 协议和带查询串的地址', async () => {
    for (const value of [123, {}, '/relative', 'file:///tmp/base', 'http://localhost/?q=1', 'http://localhost/#part']) {
      const ctx = new cordis.Context();
      closers.push(() => ctx.fiber.dispose());
      await ctx.plugin(FakeResources, { engine: { index_url: value } });
      expect(() => bridge.apply(ctx)).toThrow('engine.index_url');
      expect(ctx.get('base')).toBeUndefined();
    }
  });

  //M 共享请求保留 GET 参数、POST JSON 和上游业务状态，409 不当作断连。
  test('getJson 和 postJson 交回真实状态和解析后的正文', async () => {
    const remote = upstream();
    remote.get('/search', async (request) => ({ url: request.url }));
    remote.post('/ingest', async (request, reply) => reply.code(409).send({ received: request.body }));
    const address = await remote.listen({ host: '127.0.0.1', port: 0 });
    const { base } = await world(address, false);
    const query = '/search?q=a%2Fb+two&lib=x&lib=y';
    expect(await base.getJson(query, 1000)).toEqual({ status: 200, body: { url: query } });
    expect(await base.postJson('/ingest', { lib: '测试库', ai: false }, 1000)).toEqual({
      status: 409,
      body: { received: { lib: '测试库', ai: false } },
    });
  });

  //M HTTP 转发不能重新编码查询串，也不能把上游错误和纯文本包装成另一个响应。
  test('网页转发保留查询串、POST 体、状态码和正文类型', async () => {
    const remote = upstream();
    remote.get('/search', async (request, reply) => reply.code(418).type('text/plain').send(request.url));
    remote.post('/update/apply', async (request, reply) => reply.code(202).send({ received: request.body }));
    remote.post('/rag/index', async (_request, reply) => reply.code(409).send({ error: '正在建索引' }));
    const address = await remote.listen({ host: '127.0.0.1', port: 0 });
    const { app } = await world(address);
    //M 显式 text/plain 的假上游不会自动加 charset；转发应与它实际发出的头一致。
    const direct = await remote.inject({ method: 'GET', url: '/search?q=a%2Fb+two&lib=x&lib=y' });
    expect(direct.headers['content-type']).toBe('text/plain');
    const search = await app.inject({ method: 'GET', url: '/api/memory/search?q=a%2Fb+two&lib=x&lib=y' });
    expect(search.statusCode).toBe(418);
    expect(search.headers['content-type']).toBe(direct.headers['content-type']);
    expect(search.body).toBe('/search?q=a%2Fb+two&lib=x&lib=y');
    const update = await app.inject({ method: 'POST', url: '/api/update/apply', payload: { version: 'test' } });
    expect(update.statusCode).toBe(202);
    expect(update.json<{ received: { version: string } }>()).toEqual({ received: { version: 'test' } });
    const rag = await app.inject({ method: 'POST', url: '/api/rag/index', payload: { lib: 'x' } });
    expect(rag.statusCode).toBe(409);
    expect(rag.json<{ error: string }>()).toEqual({ error: '正在建索引' });
  });

  //M 关闭刚申请的临时端口，验证配置存在但基地没开的情况。
  test('基地没开时，服务报没响应，网页转发回 503', async () => {
    const remote = upstream();
    const address = await remote.listen({ host: '127.0.0.1', port: 0 });
    await remote.close();
    const { app, base } = await world(address);
    await expect(base.getJson('/health', 1000)).rejects.toThrow('基地没响应');
    const response = await app.inject({ method: 'GET', url: '/api/update' });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>()).toEqual({ error: '基地没响应' });
  });

  //M 超时既覆盖响应头，也覆盖已经收到响应头但正文没有发完的情况。
  test('请求和读取正文超时都归为基地没响应', async () => {
    const remote = upstream();
    remote.get('/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true };
    });
    remote.get('/slow-body', async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/json' });
      reply.raw.write('{"ok":');
      await new Promise((resolve) => setTimeout(resolve, 250));
      reply.raw.end('true}');
    });
    const address = await remote.listen({ host: '127.0.0.1', port: 0 });
    const { base } = await world(address, false);
    await expect(base.getJson('/slow', 75)).rejects.toThrow('基地没响应');
    await expect(base.getJson('/slow-body', 75)).rejects.toThrow('基地没响应');
  });

  //M 单独指定 notify.url 的用户即使没有 engine.index_url，也能发送通知。
  test('未配基地时仍可 POST 到完整通知地址', async () => {
    const remote = upstream();
    remote.post('/notify', async (request) => ({ received: request.body }));
    const address = await remote.listen({ host: '127.0.0.1', port: 0 });
    const { base } = await world(undefined, false);
    const notice = { title: '测试通知', body: '只发到临时假基地' };
    expect(await base.postJson(`${address}/notify`, notice, 1000)).toEqual({
      status: 200,
      body: { received: notice },
    });
  });
});
