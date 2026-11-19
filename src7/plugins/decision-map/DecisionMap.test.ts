/** 决策图接口、原子写入及点选与确认的离线测试。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { afterEach, expect, test } from 'bun:test';
import * as events from '../../utils/RequestEvent.ts';
import * as plugin from './index.ts';
import type * as routesModule from './Routes.ts';
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

test('只带 id 和 parent 的补丁重挂旧节点并保留其他字段', async () => {
  const { app } = await setup();
  const url = `${PREFIX}/nodes`;
  //M 合成现有待定节点及同图的另一个父项，带 Markdown 和原选项。
  const branch = { id: 'branch', kind: 'feature', title: '发布计划', parent: 'goal', status: 'working' };
  const existing = {
    ...entries[1], main: false, summary: '原摘要', body: '## 原正文\n  缩进\n', detailPath: 'docs/合成出处.md',
  };
  const payload = [entries[0], branch, existing];
  const initial = await app.inject({ method: 'PUT', url, payload });
  expect(initial.statusCode).toBe(200);
  const before = initial.json<types.DecisionGraph>().nodes.find((node) => node.id === 'release');
  if (before === undefined) {
    throw new Error('合成图缺少待重挂节点');
  }
  expect(before).toMatchObject({ ...existing, parent: 'goal' });

  //M 模拟挂树请求，特意省略正文、类型、状态和选项。
  const patch = [{ id: 'release', parent: 'branch' }];
  const changed = await app.inject({ method: 'PUT', url, payload: patch });
  expect(changed.statusCode).toBe(200);

  //M 从正常 GET 路径查询最终快照，逐字段确认只换了父项。
  const graphUrl = `${PREFIX}/graph`;
  const result = await app.inject(graphUrl);
  expect(result.statusCode).toBe(200);
  const after = result.json<types.DecisionGraph>().nodes.find((node) => node.id === 'release');
  expect(after).toEqual({ ...before, parent: 'branch' });
});

test('任务正文、网页子项和插件状态保存后才进中控收件，中控改动保持静默', async () => {
  const { app, ctx } = await setup('中控');
  const inbox: routesModule.DecisionRelayRequest[] = [];
  events.onRequestEvent(ctx, 'decision-map/relay', 'decision-map/relay-result', async (request) => {
    const stored = await app.inject(`${PREFIX}/graph`);
    const nodes = stored.json<types.DecisionGraph>().nodes;
    expect(nodes.some((node) => node.id === request.target?.node)).toBe(true);
    inbox.push(request);
    return { ok: true, id: inbox.length };
  });

  const root = { ...entries[0], body: '    原样保留首行缩进\n\n## 说明\n', detailPath: 'docs/示例.md' };
  const initial = await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload: [root] });
  expect(initial.json().nodes[0]).toMatchObject({ body: root.body, detailPath: root.detailPath });
  expect(inbox).toHaveLength(0);

  const child = { parent: 'goal', title: '核对附件' };
  const created = await app.inject({ method: 'POST', url: `${PREFIX}/child`, payload: child });
  expect(created.statusCode).toBe(200);
  const id = created.json<{ id: string }>().id;
  expect(inbox[0]).toMatchObject({ action: 'deliver', helper: '中控', target: { node: id } });
  expect(inbox[0]?.text).toContain('新建，状态 open');

  const update = { id, status: 'working' } as const;
  const changed = await app.inject({ method: 'POST', url: `${PREFIX}/status`, payload: update });
  expect(changed.json()).toMatchObject({ node: { id, status: 'working' }, delivery: [{ relayId: 2 }] });
  expect(inbox[1]?.text).toContain('状态从 open 改为 working');

  //M 重复更新和只补正文都不再发送状态通知。
  await app.inject({ method: 'POST', url: `${PREFIX}/status`, payload: update });
  await ctx.serial('decision-map/upsert', { id, body: '**附件已核对**' });
  expect(inbox).toHaveLength(2);

  const nested = { id: 'subtask', parent: id, title: '核对附件首页', kind: 'work', status: 'open' } as const;
  await ctx.serial('decision-map/upsert', [nested]);
  await ctx.serial('decision-map/status', { id, status: 'done' });
  expect(inbox).toHaveLength(4);
  expect(inbox[2]?.target?.node).toBe(nested.id);
  expect(inbox[3]?.text).toContain('状态从 working 改为 done');
  expect(new Set(inbox.map((item) => item.node)).size).toBe(inbox.length);

  const central = { id, status: 'dropped' };
  const saved = await app.inject({ method: 'PUT', url: `${PREFIX}/status`, payload: central });
  expect(saved.json().node).toMatchObject({ id, status: 'dropped', body: '**附件已核对**' });
  expect(inbox).toHaveLength(4);

  const invalid = { parent: 'unknown', title: '无法挂载' };
  const rejected = await app.inject({ method: 'POST', url: `${PREFIX}/child`, payload: invalid });
  expect(rejected.statusCode).toBe(400);
  expect(inbox).toHaveLength(4);
  const history = await app.inject(`${PREFIX}/changes?since=0`);
  expect(history.json().changes).toContainEqual(expect.objectContaining({
    action: 'status', actor: 'plugin', tasks: [{ node: id, title: child.title, status: 'done', previousStatus: 'working' }],
  }));
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

test('写话入口校验一次，只写话不改待定，带选项照点选落盘，中控回话归档收件', async () => {
  const { app, ctx } = await setup('中控');
  const calls: events.StripEnvelope<routesModule.DecisionRelayRequest>[] = [];
  const notices: string[] = [];
  ctx.on('decision-map/chosen', (notice) => { notices.push(notice.option); });
  events.onRequestEvent(ctx, 'decision-map/relay', 'decision-map/relay-result', (request) => {
    calls.push({ action: request.action, helper: request.helper, node: request.node, text: request.text });
    return { ok: true, id: 30 + calls.length };
  });
  const third = { id: 'scope', kind: 'feature', title: '先做哪块', parent: 'goal', status: 'working' };
  await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload: [...entries, third] });
  const url = `${PREFIX}/note`;

  const empty = await app.inject({ method: 'POST', url, payload: { node: 'release', text: '  ' } });
  expect(empty.statusCode).toBe(400);
  const long = await app.inject({ method: 'POST', url, payload: { node: 'release', text: '长'.repeat(2001) } });
  expect(long.statusCode).toBe(400);
  const missing = await app.inject({ method: 'POST', url, payload: { node: '没有', text: '你好' } });
  expect(missing.statusCode).toBe(404);

  const plain = await app.inject({ method: 'POST', url, payload: { node: 'release', text: '等我看完日志再说' } });
  expect(plain.statusCode).toBe(200);
  expect(plain.json()).toMatchObject({
    node: { id: 'release', kind: 'pending', status: 'open', notes: [{ id: 'n1', author: 'user', text: '等我看完日志再说' }] },
    delivery: { relayId: 31 },
  });
  expect(calls[0]).toMatchObject({ action: 'deliver', helper: '中控', node: 'release#n1' });
  expect(calls[0]?.text).toContain('决策图「今天发吗」节点 release：用户写了：等我看完日志再说');

  const working = await app.inject({ method: 'POST', url, payload: { node: 'scope', text: '先做手机上的' } });
  expect(working.json()).toMatchObject({ node: { status: 'working', notes: [{ id: 'n1' }] } });

  const withOption = await app.inject({ method: 'POST', url, payload: { node: 'release', option: 'b', text: '周五别发' } });
  expect(withOption.json()).toMatchObject({
    node: { kind: 'decided', chosen: 'b', decidedBy: 'user', notes: [{ id: 'n1' }, { id: 'n2', option: 'b' }] },
  });
  expect(notices).toEqual(['b']);
  expect(calls[2]?.node).toBe('release#n2');
  expect(calls[2]?.text).toContain('同时选了「明天发」（选项 b）');

  const wrong = await app.inject({ method: 'POST', url: `${PREFIX}/reply`, payload: { node: 'release', note: 'n9', text: '收到' } });
  expect(wrong.statusCode).toBe(404);
  const reply = await app.inject({ method: 'POST', url: `${PREFIX}/reply`, payload: { node: 'release', note: 'n1', text: '好，等你' } });
  expect(reply.json()).toMatchObject({
    node: { notes: [{ id: 'n1', repliedAt: expect.any(Number) }, { id: 'n2' }, { id: 'n3', author: 'central', replyTo: 'n1' }] },
    notified: true,
  });
  expect(calls[3]).toMatchObject({ action: 'ack', node: 'release#n1' });

  const kept = await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload: [{ id: 'scope', summary: '改一句', notes: [] }] });
  const scope = kept.json<types.DecisionGraph>().nodes.find((node) => node.id === 'scope');
  expect(scope?.notes).toHaveLength(1);
  const changes = await app.inject(`${PREFIX}/changes?since=1`);
  const actions = changes.json<{ changes: types.DecisionChange[] }>().changes.map((change) => change.action);
  expect(actions).toEqual(['note', 'note', 'choose', 'note', 'reply', 'put']);
});
