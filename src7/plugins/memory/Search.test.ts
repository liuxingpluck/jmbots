/** 统一查询的来源隔离、原文权限和兼容路由回归。 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type * as cordis from 'cordis';
import fastify from 'fastify';
import type { Session } from '../../Sessions.ts';
import type { ToolSpec } from '../../Tools.ts';
import * as channel from './ChannelIndex.ts';
import type { GraphStore } from './GraphStore.ts';
import type { MemoryService } from './index.ts';
import * as searchModule from './Search.ts';

const passage = {
  id: 7, title: '退款', scope: 'history', source: 'session:s1', bot: '助手', customer: 'demo:me',
  session: 's1', at: 10, start: 1, end: 1, snippet: '周五给退款', text: '约定周五给退款。', via: ['keyword'],
};

/** 每次测试用自己的渠道索引，Rust 返回由测试控制。 */
function fixture(passages = [passage], customers?: string[]) {
  const tools = new Map<string, ToolSpec>();
  const ctx = { tools: { register: (spec: ToolSpec) => tools.set(spec.definition.name, spec) } } as unknown as cordis.Context;
  const queries: Record<string, unknown>[] = [];
  let privateCustomer = 'demo:me';
  const service = {
    search: async (body: Record<string, unknown>) => {
      queries.push(body);
      if (body['scope'] === 'knowledge') throw new Error('知识库连接断开');
      if (customers !== undefined) {
        const hits = passages.filter((doc) => doc.customer === body['customer']);
        return { ok: true, status: 200, json: { hits } };
      }
      return { ok: true, status: 200, json: { hits: passages } };
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
    memoryKey: 'group:feishu:chat-1',
  };
  index.add({ ...row, key: 'before', at: 19, text: '原来的消息' });
  index.add({ ...row, mentionedBots: ['助手'] });
  index.add({ ...row, key: 'after', text: '下一条消息' });
  index.add({ ...row, key: 'hidden', account: 'app-2', text: '退款的另一场聊天' });
  let graph: GraphStore | undefined;
  if (customers !== undefined) {
    graph = { historyCustomers: () => customers } as unknown as GraphStore;
  }
  const search = new searchModule.Search(ctx, service, index, graph);
  search.registerTools();
  return { search, queries, tools, db, index, setCustomer: (customer: string) => { privateCustomer = customer; } };
}

/** 构造拥有同一会话属性、但不同来源快照的模型工具调用场景。 */
function getSession(role: 'owner' | 'guest', chatType = 'p2p', senderId = 'user'): Session {
  const address = { role, chatType };
  const snapshot = {
    channel: 'feishu', accountId: 'app-1', chatId: 'chat-1', chatType, role, senderId, origin: { address },
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
    await expect(world.search.get({ ref: '/api/memory-graph/passage/7' }, session)).rejects.toThrow('当前归属');
  } finally {
    world.db.close();
  }
});

test('受限会话的段落 ref 只认原归属，本人可读该机器人各客户的段落', async () => {
  const world = fixture();
  try {
    const session = getSession('guest');
    const ref = '/api/memory-graph/passage/7';
    world.setCustomer('demo:other');
    await expect(world.search.get({ ref }, session)).rejects.toThrow('当前归属');
    world.setCustomer('person:feishu:user');
    const result = await world.search.get({ ref }, session);
    expect(result).toMatchObject({ passage: { text: passage.text } });
    world.setCustomer('demo:other');
    const owner = getSession('owner');
    const ownerRead = await world.search.get({ ref }, owner);
    expect(ownerRead).toMatchObject({ passage: { customer: 'demo:other' } });
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

test('统一接口按人或群精确查询，排除其他归属与未归属来源', async () => {
  const person = 'person:feishu:user';
  const group = 'group:feishu:chat-1';
  const source = channel.CHANNEL_PARTITION;
  const world = fixture([
    { ...passage, id: 8, source: `${source}private`, customer: person },
    { ...passage, id: 9, customer: 'person:feishu:another' },
    { ...passage, id: 10, customer: group },
  ]);
  const app = fastify();
  const graph = { decorateSearch: (result: searchModule.SearchResult) => result };

  //M 同一人分别在私聊和群里发话；两个归属都不能搜到对方的片段。
  const known = world.index.context('here', { words: [], limit: 1 }).anchor;
  world.index.add({ ...known, key: 'shared', memoryKey: group });
  world.index.add({ ...known, key: 'private', chat: 'dm', chatType: 'p2p', memoryKey: person });
  try {
    world.search.mount(app, graph);
    const base = '/api/memory/search?q=退款';
    const scoped = await app.inject(`${base}&person=${person}&sources=history,channel,knowledge,card`);
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({
      hits: [{ source: 'channel', id: 'private', customer: person }], skipped: ['knowledge', 'card'],
    });
    expect(scoped.json().hits).toHaveLength(1);
    expect(world.queries[0]).toMatchObject({ scope: 'history', customer: person });

    //M 单独查 Rust 时接住已打标的渠道段落，未指定来源时避免重复显示。
    const history = await app.inject(`${base}&person=${person}&source=history`);
    expect(history.json().hits.map((hit: searchModule.SearchHit) => hit.id)).toEqual(['8']);
    const shared = await app.inject(`${base}&group=${group}`);
    expect(shared.json().hits.map((hit: searchModule.SearchHit) => hit.id).sort()).toEqual(['10', 'here', 'hidden', 'shared']);

    //G 不能混用归属条件，模型调用仍受当前聊天的原有授权限制。
    const conflicting = await app.inject(`${base}&person=${person}&group=${group}`);
    expect(conflicting.statusCode).toBe(400);
    const invalid = await app.inject(`${base}&group=${person}`);
    expect(invalid.statusCode).toBe(400);
    const guest = getSession('guest');
    const fromModel = world.search.find({ q: '退款', person }, guest);
    await expect(fromModel).rejects.toThrow('只给网页和内部请求用');
  } finally {
    await app.close();
    world.db.close();
  }
});

test('记忆工具不能跨人或跨群查询，本人可查该机器人全部历史分区', async () => {
  const a = 'person:feishu:user';
  const b = 'person:feishu:user-b';
  const group = 'group:feishu:chat-1';
  const legacy = 'demo:me';
  const customers = [a, b, group, legacy];
  const world = fixture([
    { ...passage, id: 11, customer: a },
    { ...passage, id: 12, customer: b },
    { ...passage, id: 13, customer: group },
    { ...passage, id: 14, customer: legacy },
  ], customers);
  try {
    const query = { q: '退款', sources: 'history' };
    const privateA = getSession('guest');
    const privateB = getSession('guest', 'p2p', 'user-b');
    const shared = getSession('owner', 'group');
    const owner = getSession('owner');
    const ask = async (session: Session): Promise<string[]> => {
      const result = await world.search.find(query, session);
      return result.hits.map((hit) => hit.customer).sort();
    };
    expect(await ask(privateA)).toEqual([a]);
    expect(await ask(privateB)).toEqual([b]);
    expect(await ask(shared)).toEqual([group]);
    expect(await ask(owner)).toEqual([...customers].sort());
    const other = world.search.find({ ...query, customer: b }, privateA);
    await expect(other).rejects.toThrow('当前客户');

    const ref = '/api/memory-graph/passage/7';
    world.setCustomer(a);
    await expect(world.search.get({ ref }, shared)).rejects.toThrow('当前归属');
    await expect(world.search.get({ ref }, privateB)).rejects.toThrow('当前归属');
  } finally {
    world.db.close();
  }
});


test('归属列表用最新人名、保留群号和本人，并对两库的渠道消息去重', async () => {
  const world = fixture();
  const a = 'person:feishu:person-a';
  const b = 'person:feishu:person-b';
  const group = 'group:feishu:chat-1';
  const sample = world.index.context('here', { words: [], limit: 1 }).anchor;
  const dm = { ...sample, chat: 'dm-a', chatType: 'p2p', senderId: 'person-a', memoryKey: a };
  world.index.add({ ...dm, key: 'first-name', senderName: '曾用名', at: 21 });
  world.index.add({ ...dm, key: 'current-name', senderName: '测试甲', at: 22 });
  world.index.add({ ...dm, key: 'old-person', memoryKey: '', senderId: 'person-b', senderName: '测试乙' });
  const graphStore = {
    ownershipRows: () => [
      { key: a, count: 3, channels: 2 },
      { key: b, count: 1, channels: 0 },
      { key: group, count: 2, channels: 2 },
      { key: 'owner', count: 8, channels: 0 },
      { key: 'demo:legacy', count: 5, channels: 0 },
      { key: 'group:fixture:with:colons', count: 1, channels: 0 },
    ],
  } as unknown as GraphStore;
  const search = new searchModule.Search({} as cordis.Context, {} as MemoryService, world.index, graphStore);
  const app = fastify();
  const graph = { decorateSearch: (result: searchModule.SearchResult) => result };
  try {
    search.mount(app, graph);
    const response = await app.inject('/api/memory/owners');
    expect(response.statusCode).toBe(200);
    const found = response.json().owners;
    expect(found).toHaveLength(5);
    expect(found).toContainEqual({ key: a, kind: 'person', name: '测试甲', count: 3 });
    expect(found).toContainEqual({ key: b, kind: 'person', name: '测试乙', count: 1 });
    expect(found).toContainEqual({ key: group, kind: 'group', name: 'chat-1', count: 4 });
    expect(found).toContainEqual({ key: 'owner', kind: 'owner', name: '本人', count: 8 });
    expect(found).toContainEqual({ key: 'group:fixture:with:colons', kind: 'group', name: 'with:colons', count: 1 });
    const result = await app.inject('/api/memory/search?q=退款&source=channel');
    expect(result.statusCode).toBe(200);
    expect(result.json().hits).toContainEqual(expect.objectContaining({ id: 'current-name', customer: a }));
  } finally {
    await app.close();
    world.db.close();
  }
});
