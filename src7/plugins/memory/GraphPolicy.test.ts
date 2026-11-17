/**
 * 聊天记录不进关系图的开关（history_graph / no_graph_customers）单元测试。
 * 跑法：bun test src7/plugins/memory/GraphPolicy.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRow } from '../../Sessions.ts';
import type * as backendModule from './Backend.ts';
import * as graphPolicy from './GraphPolicy.ts';
import * as storeModule from './Store.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-mem-graph-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** 只记下收到什么的后端。 */
class Capture implements backendModule.MemoryBackend {
  readonly name = 'capture';
  docs: backendModule.MemoryDoc[] = [];
  async ingest(docs: backendModule.MemoryDoc[]): Promise<void> { this.docs.push(...docs); }
  async remove(): Promise<void> {}
  async search(): Promise<backendModule.Citation[]> { return []; }
  async health(): Promise<Record<string, unknown>> { return { ok: true }; }
}

/** 一场网页会话，两条消息。 */
function row(id: string, channel: string, customer: string): SessionRow {
  return {
    id, bot: '助手', channel, address: { customer },
    messages: [
      { role: 'user', content: '星河科技的合同金额是多少？', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '合同金额 36 万元。' }], timestamp: 2 },
    ],
  } as unknown as SessionRow;
}

describe('读配置', () => {
  test('不写 = 都进图', () => {
    expect(graphPolicy.readGraphPolicy({})).toEqual({ historyGraph: true, noGraphCustomers: [] });
  });
  test('写错类型抛错', () => {
    expect(() => graphPolicy.readGraphPolicy({ history_graph: 'no' })).toThrow();
    expect(() => graphPolicy.readGraphPolicy({ no_graph_customers: 'demo:*' })).toThrow();
  });
  test('从插件列表找 memory 的配置', () => {
    const cfg = graphPolicy.memoryPluginConfig([{ name: 'http', config: {} }, { name: './plugins/memory', config: { history_graph: false } }]);
    expect(graphPolicy.readGraphPolicy(cfg).historyGraph).toBe(false);
  });
});

describe('要不要进图', () => {
  test('history_graph: false 谁都不进', () => {
    const p = graphPolicy.readGraphPolicy({ history_graph: false });
    expect(graphPolicy.wantsGraph(p, 'http:本机')).toBe(false);
    expect(graphPolicy.wantsGraph(p, 'feishu:ou_x')).toBe(false);
  });
  test('no_graph_customers 精确和前缀', () => {
    const p = graphPolicy.readGraphPolicy({ no_graph_customers: ['http:本机', 'demo:*'] });
    expect(graphPolicy.wantsGraph(p, 'http:本机')).toBe(false);
    expect(graphPolicy.wantsGraph(p, 'demo:企业客服')).toBe(false);
    expect(graphPolicy.wantsGraph(p, 'feishu:ou_x')).toBe(true);
    expect(graphPolicy.wantsGraph(p, 'http:本机2')).toBe(true);
  });
  test('markGraph 只在不进图时加 graph:false', () => {
    const p = graphPolicy.readGraphPolicy({ no_graph_customers: ['http:本机'] });
    const doc: { customer: string; text: string; graph?: boolean } = { customer: 'http:本机', text: 'a' };
    expect(graphPolicy.markGraph(p, doc).graph).toBe(false);
    expect('graph' in graphPolicy.markGraph(p, { customer: 'feishu:ou_x', text: 'a' })).toBe(false);
  });
});

describe('Store 收聊天记录时带标记', () => {
  test('不进图的客户：每段都带 graph:false，照样送去收', async () => {
    const capture = new Capture();
    const db = new Database(':memory:');
    const store = new storeModule.Store(capture, root, db, graphPolicy.readGraphPolicy({ history_graph: false }));
    expect(await store.ingestSession(row('s1', 'http', 'http:本机'))).toBe(2);
    expect(capture.docs.length).toBe(2);
    expect(capture.docs.every((doc) => doc.graph === false && doc.customer === 'http:本机')).toBe(true);
  });
  test('不配置：和以前一样，不带 graph 字段', async () => {
    const capture = new Capture();
    const db = new Database(':memory:');
    const store = new storeModule.Store(capture, root, db);
    await store.ingestSession(row('s2', 'http', 'http:本机'));
    expect(capture.docs.length).toBe(2);
    expect(capture.docs.some((doc) => 'graph' in doc)).toBe(false);
  });
  test('只列了别的客户：这个客户照样进图', async () => {
    const capture = new Capture();
    const db = new Database(':memory:');
    const store = new storeModule.Store(capture, root, db, graphPolicy.readGraphPolicy({ no_graph_customers: ['demo:*'] }));
    await store.ingestSession(row('s3', 'feishu', 'feishu:ou_x'));
    expect(capture.docs.some((doc) => doc.graph === false)).toBe(false);
  });
});
