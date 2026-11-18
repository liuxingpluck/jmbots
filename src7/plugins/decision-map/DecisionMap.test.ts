/** 决策图接口、原子写入及点选与确认的离线测试。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { afterEach, expect, test } from 'bun:test';
import * as events from '../../utils/RequestEvent.ts';
import * as plugin from './index.ts';
import * as storeModule from './Store.ts';
import type * as types from './Types.ts';

const PREFIX = '/api/decision-map';
const cleanups: (() => void | Promise<void>)[] = [];
const entries = [
  { id: 'goal', kind: 'goal', title: '上线目标', status: 'working' },
  {
    id: 'release', kind: 'pending', title: '今天发吗', parent: 'goal', status: 'open', main: true,
    options: [{ id: 'a', text: '今天发', recommended: true, cost: '留时间看日志' }, { id: 'b', text: '明天发' }],
  },
];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** 网络接口用 Fastify 注入，运行时目录只包含本用例的数据。 */
async function setup(helper?: string) {
  const root = fs.mkdtempSync(path.join(import.meta.dir, '.map-test-'));
  const ctx = new cordis.Context();
  const app = fastify.default();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(async () => { await app.close(); }, async () => { await ctx.fiber.dispose(); });
  ctx.provide('http', { app });
  ctx.provide('resources', {
    dir(...parts: string[]) {
      const dir = path.join(root, ...parts);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  });
  await ctx.plugin(plugin, { relay_helper: helper });
  const dir = path.join(root, 'data', 'decision-map');
  return { app, ctx, dir };
}

test('批量发布和局部更新，非法结构不修改图或序号', async () => {
  const { app } = await setup();
  const url = `${PREFIX}/nodes`;
  const initial = await app.inject({ method: 'PUT', url, payload: [entries[1], entries[0]] });
  expect(initial.statusCode).toBe(200);
  expect(initial.json<types.DecisionGraph>().nodes).toHaveLength(2);

  const invalid = [{ id: 'release', parent: 'release' }];
  const rejected = await app.inject({ method: 'PUT', url, payload: invalid });
  expect(rejected.statusCode).toBe(400);
  const unchanged = await app.inject(`${PREFIX}/graph`);
  expect(unchanged.json<types.DecisionGraph>()).toEqual(initial.json<types.DecisionGraph>());

  const patch = [{ id: 'release', summary: '只修改摘要' }];
  const changed = await app.inject({ method: 'PUT', url, payload: { nodes: patch } });
  expect(changed.json()).toMatchObject({ revision: 2 });
  expect(changed.json<types.DecisionGraph>().nodes[0]).toMatchObject({
    id: 'release', title: '今天发吗', status: 'open', main: true, summary: '只修改摘要',
  });
});

test('选项先落盘，relay 可重复投递但确认状态只记一次', async () => {
  const { app, ctx } = await setup('中控');
  const calls: string[] = [];
  const notices: string[] = [];
  ctx.on('decision-map/chosen', (notice) => { notices.push(notice.option); });
  events.onRequestEvent(ctx, 'decision-map/relay', 'decision-map/relay-result', (request) => {
    calls.push(request.action);
    expect(request).toMatchObject({ helper: '中控', node: 'release' });
    return { ok: true, id: 18 };
  });
  await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload: entries });
  const payload = { node: 'release', option: 'a' };
  const url = `${PREFIX}/choose`;
  const chosen = await app.inject({ method: 'POST', url, payload });
  expect(chosen.statusCode).toBe(200);
  expect(chosen.json()).toMatchObject({
    node: { id: 'release', kind: 'decided', status: 'decided', chosen: 'a', decidedBy: 'user' },
    delivery: { relayId: 18 },
  });

  const repeated = await app.inject({ method: 'POST', url, payload });
  expect(repeated.statusCode).toBe(200);
  const conflict = await app.inject({ method: 'POST', url, payload: { ...payload, option: 'b' } });
  expect(conflict.statusCode).toBe(409);
  expect(notices).toEqual(['a']);

  const ack = await app.inject({ method: 'POST', url: `${PREFIX}/ack`, payload: { node: 'release', note: '已安排' } });
  expect(ack.json()).toMatchObject({ node: { chosen: 'a', acknowledgedAt: expect.any(Number), note: '已安排' } });
  expect(calls).toEqual(['deliver', 'deliver', 'ack']);
  const changes = await app.inject(`${PREFIX}/changes?since=1`);
  expect(changes.json()).toMatchObject({ last: 3, changes: [{ seq: 2, action: 'choose' }, { seq: 3, action: 'ack' }] });
});

test('relay 缺席仍能轮询用户选择，启动时补记快照里未追加的历史', async () => {
  const { app, dir } = await setup('中控');
  await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload: entries });
  const url = `${PREFIX}/choose`;
  const unknown = await app.inject({ method: 'POST', url, payload: { node: 'release', option: '无效' } });
  expect(unknown.statusCode).toBe(400);
  const picked = await app.inject({ method: 'POST', url, payload: { node: 'release', option: 'a' } });
  expect(picked.json()).toMatchObject({ delivery: { method: 'GET', path: `${PREFIX}/changes` } });

  const history = path.join(dir, 'history.jsonl');
  const data = fs.readFileSync(history, 'utf8');
  const first = data.trim().split('\n')[0]!;
  fs.writeFileSync(history, `${first}\n{"seq":`, 'utf8');
  const restored = new storeModule.Store(dir);
  expect(restored.getGraph()).toMatchObject({ revision: 2 });
  expect(restored.getChanges(1)).toMatchObject({ changes: [{ seq: 2, action: 'choose', option: 'a' }] });
});

test('导入已定节点保留作者、时间和出处，重发数据不会替换当时的选项', async () => {
  const { app } = await setup();
  const createdAt = 1795003200000;
  const decidedAt = 1795003500000;
  const sources = ['docs/记录.md'];
  const release = {
    ...entries[1],
    kind: 'decided',
    status: 'decided',
    chosen: 'a',
    decidedBy: 'central',
    createdAt,
    decidedAt,
    sources,
  };
  const url = `${PREFIX}/nodes`;
  const initial = await app.inject({ method: 'PUT', url, payload: [entries[0], release] });
  expect(initial.statusCode).toBe(200);
  const changed = await app.inject({
    method: 'PUT',
    url,
    payload: [{ id: 'release', decidedBy: 'user', decidedAt: 0, options: [{ id: 'a', text: '另一个文字' }] }],
  });
  expect(changed.json<types.DecisionGraph>().nodes[1]).toMatchObject(release);

  const payload = { node: 'release', option: 'a' };
  const repeated = await app.inject({ method: 'POST', url: `${PREFIX}/choose`, payload });
  expect(repeated.statusCode).toBe(409);
});
