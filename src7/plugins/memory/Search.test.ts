/** 统一查询的来源隔离、原文权限和兼容路由回归。 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type * as cordis from 'cordis';
import fastify from 'fastify';
import type { Session } from '../../Sessions.ts';
import type { ToolSpec } from '../../Tools.ts';
import * as channel from './ChannelIndex.ts';
import type { MemoryService } from './index.ts';
import * as searchModule from './Search.ts';

const passage = {
  id: 7, title: '退款', scope: 'history', source: 'session:s1', bot: '助手', customer: 'demo:me',
  session: 's1', at: 10, start: 1, end: 1, snippet: '周五给退款', text: '约定周五给退款。', via: ['keyword'],
};

/** 每次测试用自己的渠道索引，Rust 返回由测试控制。 */
function fixture() {
  const tools = new Map<string, ToolSpec>();
  const ctx = { tools: { register: (spec: ToolSpec) => tools.set(spec.definition.name, spec) } } as unknown as cordis.Context;
  const queries: Record<string, unknown>[] = [];
  let privateCustomer = 'demo:me';
  const service = {
    search: async (body: Record<string, unknown>) => {
      queries.push(body);
      if (body['scope'] === 'knowledge') throw new Error('知识库连接断开');
      return { ok: true, status: 200, json: { hits: [passage] } };
    },
    readSearchData: async (route: string) => {
      if (route.startsWith('/customers/')) return { ids: ['demo:me', 'demo:merged'] };
      return { passage: { ...passage, customer: privateCustomer } };
    },
  } as unknown as MemoryService;
  const db = new Database(':memory:');
  const index = new channel.ChannelIndex(db);
  const row = {
    key: 'here', channel: 'feishu', account: 'app-1', chat: 'chat-1', chatType: 'group',
    direction: 'user' as const, senderId: 'user', senderName: '小王', bot: '助手', text: '退款到账', at: 20,
  };
  index.add({ ...row, key: 'before', at: 19, text: '原来的消息' });
  index.add({ ...row, mentionedBots: ['助手'] });
  index.add({ ...row, key: 'after', text: '下一条消息' });
  index.add({ ...row, key: 'hidden', account: 'app-2', text: '退款的另一场聊天' });
  const search = new searchModule.Search(ctx, service, index);
  search.registerTools();
  return { search, queries, tools, db, setCustomer: (customer: string) => { privateCustomer = customer; } };
}

/** 构造拥有同一会话属性、但不同来源快照的模型工具调用场景。 */
function getSession(role: 'owner' | 'guest', chatType = 'p2p'): Session {
  const address = { role, chatType };
  const snapshot = {
    channel: 'feishu', accountId: 'app-1', chatId: 'chat-1', chatType, role, origin: { address },
  };
  const row = { id: 's1', bot: '助手', customer: 'demo:me', kind: 'front', address, activeSourceSnapshot: snapshot, messages: [] };
  return { row } as unknown as Session;
}

test('按来源并发检索，失败时保留其他来源，按时间筛选候选', async () => {
  const world = fixture();
  try {
    const session = getSession('owner');
    const params = { q: '退款', sources: 'history,channel,knowledge', mode: 'keyword', range: 'session', since: 10 };
    const result = await world.search.find(params, session);
    expect(result.hits.map((hit) => hit.source)).toEqual(['channel', 'history', 'channel']);
    expect(result.unavailable).toEqual(['knowledge']);
    expect(result.warnings).toContain('知识库连接断开');
    expect(world.queries[0]).toMatchObject({ customer: 'demo:me', bot: '助手', session: 's1', mode: 'fast' });
    const later = await world.search.find({ ...params, since: '15' }, session);
    expect(later.hits.every((hit) => hit.at >= 15)).toBe(true);
    await expect(world.search.find({ ...params, customer: 'demo:other' }, session)).rejects.toThrow('当前客户');
    await expect(world.search.find({ q: '退款', sources: 'history' })).rejects.toThrow('必须带客户号');
  } finally {
    world.db.close();
  }
});

test('群聊只查当前账号和聊天，mentions 只接受明确 @，同毫秒消息的前后文稳定', async () => {
  const world = fixture();
  try {
    const session = getSession('owner', 'group');
    const result = await world.search.find({ q: '退款', mentions: true }, session);
    expect(result.hits.map((item) => item.id)).toEqual(['here']);
    expect(world.queries).toEqual([]);
    const hit = result.hits[0]!;
    const read = await world.search.get({ ref: hit.ref }, session);
    expect(read).toMatchObject({ anchor: { key: 'here' }, before: [{ key: 'before' }], after: [{ key: 'after' }] });
    await expect(world.search.get({ ref: hit.ref.replace('id=here', 'id=hidden') }, session)).rejects.toThrow('找不到');
    await expect(world.search.find({ q: '退款', chat: 'chat-2' }, session)).rejects.toThrow('这个聊天');
    await expect(world.search.get({ ref: '/api/memory-graph/passage/7' }, session)).rejects.toThrow('当前聊天');
  } finally {
    world.db.close();
  }
});

test('段落 ref 不能越过客户授权，合并过的客户号可取原文', async () => {
  const world = fixture();
  try {
    const session = getSession('owner');
    const ref = '/api/memory-graph/passage/7';
    world.setCustomer('demo:other');
    await expect(world.search.get({ ref }, session)).rejects.toThrow('当前客户');
    world.setCustomer('demo:merged');
    const result = await world.search.get({ ref }, session);
    expect(result).toMatchObject({ passage: { text: passage.text } });
  } finally {
    world.db.close();
  }
});

test('前台两种工具共用每轮三次配额', async () => {
  const world = fixture();
  try {
    const session = getSession('owner');
    const signal = new AbortController().signal;
    const search = world.tools.get('memory_search')!;
    const get = world.tools.get('memory_get')!;
    const params = { q: '退款', sources: 'history' };
    await search.run(params, session, signal, 'a');
    await get.run({ ref: '/api/memory-graph/passage/7' }, session, signal, 'b');
    await search.run(params, session, signal, 'c');
    await expect(search.run(params, session, signal, 'd')).rejects.toThrow('本轮记忆工具已调用 3 次');
  } finally {
    world.db.close();
  }
});

test('统一接口登记在 memory 插件，带客户号才能取聊天往来', async () => {
  const world = fixture();
  const app = fastify();
  const graph = { decorateSearch: (result: searchModule.SearchResult) => result };
  const url = '/api/memory/search?q=退款&sources=history&customer=demo:me';
  try {
    world.search.mount(app, graph);
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ hits: [{ source: 'history', id: '7' }], unavailable: [] });

    const unscoped = await app.inject('/api/memory/search?q=退款&sources=history');
    expect(unscoped.statusCode).toBe(400);
  } finally {
    await app.close();
    world.db.close();
  }
});
