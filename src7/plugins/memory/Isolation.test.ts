/**
 * 记忆检索的客户隔离单元测试（2026-11-14 演示隔离题串客户后加）。
 * 跑法：bun test src7/plugins/memory/Isolation.test.ts
 * 查的是：碰聊天记录的检索不带客户号一律拒绝（本地后端、外部后端都一样，外部后端连请求都不发）；
 * 带了客户号只看得到自己的；只搜知识库不用客户号；客户号按渠道推出来的格式（feishu:<open_id>、http:本机）。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as backendModule from './Backend.ts';
import * as storeModule from './Store.ts';

/** 临时运行时目录（知识库同步要用）。 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-mem-iso-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** 两个客户各一段，外加一段知识库。 */
const docs: backendModule.MemoryDoc[] = [
  { source: 'session:xh', scope: 'history', bot: '助手', customer: 'http:本机', session: 'xh', title: '星河', text: '星河科技的合同编号是 HT-2026-118，合同金额 36 万元。', at: 1, start: 0, end: 0 },
  { source: 'session:ls', scope: 'history', bot: '助手', customer: 'feishu:ou_demo_lanshan', session: 'ls', title: '蓝山', text: '蓝山餐饮的合同编号是 HT-2026-205，第二期尾款 6 万元。', at: 2, start: 0, end: 0 },
  { source: 'session:qy', scope: 'history', bot: '助手', customer: 'demo:企业客服', session: 'qy', title: '企业客服', text: '企业客服演示：合同编号 HT-QY-001，售后热线 400-000-0000。', at: 3, start: 0, end: 0 },
  { source: 'kb', scope: 'knowledge', bot: '', customer: '', session: '', title: '知识库', text: '记忆服务的嵌入模型用 bge-m3 合同模板。', at: 3, start: 0, end: 0 },
];

/** 本地后端的记忆库。 */
async function localStore(): Promise<storeModule.Store> {
  const db = new Database(':memory:');
  const store = new storeModule.Store(new backendModule.LocalBackend(db), root, db);
  await store.backend.ingest(docs);
  return store;
}

describe('记忆检索客户隔离', () => {
  test('带客户号只看得到自己的', async () => {
    const store = await localStore();
    const mine = await store.search({ query: '合同编号', scope: 'history', bot: '助手', customer: 'http:本机', limit: 10 });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((hit) => hit.customer === 'http:本机')).toBe(true);
    const asked = await store.search({ query: '蓝山餐饮的合同编号和尾款', scope: 'all', bot: '助手', customer: 'http:本机', limit: 10 });
    expect(asked.map((hit) => hit.snippet).join('\n')).not.toContain('HT-2026-205');
    expect(asked.map((hit) => hit.snippet).join('\n')).not.toContain('HT-QY-001');
  });

  test('演示客户 demo:企业客服 只看得到自己的', async () => {
    const store = await localStore();
    const hits = await store.search({ query: '合同编号 售后热线', scope: 'all', bot: '助手', customer: 'demo:企业客服', limit: 10 });
    expect(hits.some((hit) => hit.snippet.includes('HT-QY-001'))).toBe(true);
    expect(hits.every((hit) => hit.scope === 'knowledge' || hit.customer === 'demo:企业客服')).toBe(true);
  });

  test('搜聊天记录不带客户号就拒绝', async () => {
    const store = await localStore();
    for (const scope of ['history', 'all'] as const) {
      for (const customer of [undefined, '', '  ']) {
        const query: backendModule.MemoryQuery = { query: '合同编号', scope, bot: '助手', limit: 10 };
        if (customer !== undefined) query.customer = customer;
        await expect(store.search(query)).rejects.toThrow(storeModule.NO_CUSTOMER);
      }
    }
  });

  test('只搜知识库不用客户号，也搜不到聊天记录', async () => {
    const store = await localStore();
    const hits = await store.search({ query: '合同', scope: 'knowledge', bot: '助手', limit: 10 });
    expect(hits.every((hit) => hit.scope === 'knowledge')).toBe(true);
  });

  test('外部后端：不带客户号连请求都不发；带了就照传', async () => {
    const seen: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/search') seen.push(await request.json() as Record<string, unknown>);
        return Response.json({ hits: [] });
      },
    });
    try {
      const db = new Database(':memory:');
      const store = new storeModule.Store(new backendModule.HttpBackend(`http://127.0.0.1:${String(server.port)}`, new backendModule.LocalBackend(db)), root, db);
      await expect(store.search({ query: '合同', scope: 'history', bot: '助手', limit: 5 })).rejects.toThrow(storeModule.NO_CUSTOMER);
      expect(seen.length).toBe(0);
      await store.search({ query: '合同', scope: 'history', bot: '助手', customer: 'feishu:ou_a', limit: 5 });
      expect(seen.map((body) => body['customer'])).toEqual(['feishu:ou_a']);
    } finally {
      void server.stop(true);
    }
  });

  test('客户号格式：飞书私聊、飞书群、网页', () => {
    expect(storeModule.customerFrom('feishu', { openId: 'ou_x', chatType: 'p2p' })).toBe('feishu:ou_x');
    expect(storeModule.customerFrom('feishu', { chatId: 'oc_g', chatType: 'group', openId: 'ou_x' })).toBe('feishu:group:oc_g');
    expect(storeModule.customerFrom('http', { messageId: 2 })).toBe('http:本机');
    expect(storeModule.customerFrom(undefined, {})).toBe('');
  });
});
