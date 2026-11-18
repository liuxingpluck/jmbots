/**
 * memory 插件改事件第一阶段（11-18）：
 *   1. 请求事件 memory/request（record-history、search-history、embed）有人答，回 memory/result；记忆服务不通时 record-history 回 ok: false；没挂 memory 走无人接单退路；
 *   2. 前台“先查记忆”的提示（MEMORY_HINT，原在 bots/FrontDesk.ts）由 memory 在 session/request 里自己加：有 memory 工具、本人才加。
 * 假记忆服务用 Fastify 监听 127.0.0.1 的随机端口，不碰真服务；数据放临时目录。
 * 跑法：bun test ./src7/plugins/memory
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import fastify from 'fastify';
import type { ChatRequest } from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as events from '../../utils/RequestEvent.ts';
import type * as backendModule from './Backend.ts';
import * as graphPolicy from './GraphPolicy.ts';
import * as memoryPlugin from './index.ts';
import * as storeModule from './Store.ts';


//M 每个用例收拾自己的 ctx、假服务和临时目录。
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 调用方的退回：requestId 写成退回原因，ok: false。 */
const memoryOptions = {
  timeoutMs: 1000,
  onFallback: (reason: events.FallbackReason, detail?: string) => ({ requestId: reason, ok: false, error: detail ?? reason }),
};


/** 什么也不收的检索后端：只给 Store 建起来用。 */
class EmptyBackend implements backendModule.MemoryBackend {
  readonly name = 'empty';
  async ingest(): Promise<void> {}
  async remove(): Promise<void> {}
  async search(): Promise<backendModule.Citation[]> { return []; }
  async health(): Promise<Record<string, unknown>> { return { ok: true }; }
}


/**
 * 起一个假记忆服务：/remove、/ingest 记下收到的正文；/search 交回一条命中；/embed 每段交回 [1, 0]。
 * @returns 地址和收到的请求（路径 → 正文）。
 */
async function fakeService(): Promise<{ url: string; got: { route: string; body: unknown }[] }> {
  const app = fastify();
  closers.push(() => app.close());
  const got: { route: string; body: unknown }[] = [];
  app.post('/remove', (request) => {
    got.push({ route: '/remove', body: request.body });
    return { ok: true };
  });
  app.post('/ingest', (request) => {
    got.push({ route: '/ingest', body: request.body });
    return { ok: true };
  });
  app.post('/search', (request) => {
    got.push({ route: '/search', body: request.body });
    return { hits: [{ start: 7, score: 0.9, text: '以前说过' }] };
  });
  app.post<{ Body: { texts: string[] } }>('/embed', (request) => {
    const vectors = request.body.texts.map(() => [1, 0]);
    return { ok: true, vectors };
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return { url, got };
}


/**
 * 只挂 MemoryService（ctx.memory）：包成一个小插件挂上，和 apply 里一样在插件的 ctx 上建；记忆服务地址由参数给。
 * @param address 记忆服务的地址；'' 是没有服务。
 */
async function serviceWorld(address: string): Promise<cordis.Context> {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  const policy = graphPolicy.readGraphPolicy({});
  const plugin = {
    name: 'memory-service',
    apply: (sub: cordis.Context) => {
      new memoryPlugin.MemoryService(sub, () => address, policy);
    },
  };
  await ctx.plugin(plugin);
  return ctx;
}


test('memory/request 有人答：记往来、搜聊天记录、算向量都回 memory/result', async () => {
  const { url, got } = await fakeService();
  const ctx = await serviceWorld(url);

  //M record-history：先删同 source 再收；没有客户号的段不收。
  const doc = {
    source: 'bot-log:s1',
    scope: 'history' as const,
    bot: '助手',
    customer: 'test:u1',
    session: 's1',
    title: '用户',
    text: '今晚吃什么',
    at: 1,
    start: 7,
    end: 7,
  };
  const record = { action: 'record-history' as const, source: 'bot-log:s1', docs: [doc, { ...doc, customer: '' }] };
  const recorded = await events.requestEvent(ctx, 'memory/request', 'memory/result', record, memoryOptions);
  expect(recorded.ok).toBe(true);
  expect(recorded.requestId).toStartWith('req_');
  expect(got.map((item) => item.route)).toEqual(['/remove', '/ingest']);
  expect((got[1]?.body as { docs: unknown[] }).docs).toHaveLength(1);

  //M search-history：命中原样交回。
  const search = { action: 'search-history', query: '吃什么', bot: '助手', customer: 'test:u1', limit: 5 } as const;
  const searched = await events.requestEvent(ctx, 'memory/request', 'memory/result', search, memoryOptions);
  expect(searched).toMatchObject({ ok: true, hits: [{ start: 7, score: 0.9, text: '以前说过' }] });

  //M embed：每段一个向量。
  const embed = { action: 'embed' as const, texts: ['甲', '乙'] };
  const embedded = await events.requestEvent(ctx, 'memory/request', 'memory/result', embed, memoryOptions);
  expect(embedded).toMatchObject({ ok: true, vectors: [[1, 0], [1, 0]] });
});


test('memory/request 出错：没有记忆服务时记往来回 ok: false，搜和算向量交回空的', async () => {
  const ctx = await serviceWorld('');
  const doc = {
    source: 'bot-log:s1',
    scope: 'history' as const,
    bot: '助手',
    customer: 'test:u1',
    session: 's1',
    title: '用户',
    text: '你好',
    at: 1,
    start: 1,
    end: 1,
  };

  //M recordHistory 抛 remove failed，onError 转成 { ok: false, error }，不等超时。
  const record = { action: 'record-history' as const, source: 'bot-log:s1', docs: [doc] };
  const recorded = await events.requestEvent(ctx, 'memory/request', 'memory/result', record, memoryOptions);
  expect(recorded.requestId).toStartWith('req_');
  expect(recorded).toMatchObject({ ok: false, error: 'remove failed' });

  const search = { action: 'search-history', query: '你好', bot: '助手', customer: 'test:u1', limit: 5 } as const;
  const searched = await events.requestEvent(ctx, 'memory/request', 'memory/result', search, memoryOptions);
  expect(searched).toMatchObject({ ok: true, hits: [] });

  const embed = { action: 'embed' as const, texts: ['甲'] };
  const embedded = await events.requestEvent(ctx, 'memory/request', 'memory/result', embed, memoryOptions);
  expect(embedded.ok).toBe(true);
  expect(embedded.vectors).toBeUndefined();
});


test('没挂 memory：memory/request 立刻走无人接单退路', async () => {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  const embed = { action: 'embed' as const, texts: ['甲'] };
  const result = await events.requestEvent(ctx, 'memory/request', 'memory/result', embed, memoryOptions);
  expect(result).toEqual({ requestId: 'unhandled', ok: false, error: 'unhandled' });
});


test('前台“先查记忆”的提示：有 memory 工具、本人才加；外人、没有工具、干活的会话不加', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hint-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(toolsModule.Tools);
  const store = new storeModule.Store(new EmptyBackend(), root, new Database(':memory:'));
  new memoryPlugin.Memory(ctx, undefined, store, { history: false, recallHistory: 0, recallKnowledge: 0 });

  /**
   * 拼一步请求，过一遍 session/request，交回加进 system 的段落。
   * @param kind 会话种类。
   * @param address 回话地址。
   * @param toolNames 这一步的工具名。
   */
  const ask = async (kind: string, address: unknown, toolNames: string[]): Promise<string[]> => {
    const request = {
      session: { id: 's1', row: { id: 's1', kind, bot: '助手', address, recall: '' }, save: () => undefined },
      system: [] as string[],
      tools: toolNames.map((name) => ({ name })),
      messages: [],
    } as unknown as ChatRequest;
    await ctx.serial('session/request', request);
    return request.system;
  };

  const own = await ask('front', { customer: 'test:u1' }, ['memory', 'history_search']);
  expect(own).toHaveLength(1);
  expect(own[0]).toContain('先调 memory 工具查记忆');

  const guest = await ask('front', { customer: 'test:u2', role: 'guest' }, ['memory']);
  expect(guest).toEqual([]);

  const noTool = await ask('front', { customer: 'test:u1' }, ['history_search']);
  expect(noTool).toEqual([]);

  //M 干活的会话 recall 已经是 ''（搜过没搜到）：不加提示，也不再搜。
  const work = await ask('work', { customer: 'test:u1' }, ['memory']);
  expect(work).toEqual([]);
});
