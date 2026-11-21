/** 决策图接口、原子写入及点选与确认的离线测试。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import type { Session } from '../../Sessions.ts';
import type { ToolSpec } from '../../Tools.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as channel from '../channels/Reply.ts';
import * as dbModule from '../db/index.ts';
import * as plugin from './index.ts';
import type * as routesModule from './Routes.ts';
import * as sqliteModule from './Sqlite.ts';
import * as storeModule from './Store.ts';
import type * as types from './Types.ts';

const PREFIX = '/api/work-decision';
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

/** 和正式 db 插件一样的迁移服务，包同一个连接（建表、加列走它的账本）。 */
function getMigrations(db: Database): dbModule.Db {
  return new dbModule.Db(new cordis.Context(), db);
}

/** 网络接口用 Fastify 注入，运行时目录只包含本用例的数据。 */
async function setup(helper?: string, config: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(import.meta.dir, '.map-test-'));
  const ctx = new cordis.Context();
  const app = fastify.default();
  const db = new Database(':memory:');
  const tools = new Map<string, ToolSpec>();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  cleanups.push(async () => { await app.close(); }, async () => { await ctx.fiber.dispose(); });
  ctx.provide('http', { app });
  ctx.provide('resources', { db, root, raw: {} });
  ctx.provide('tools', { register: (tool: ToolSpec) => tools.set(tool.definition.name, tool) });
  ctx.provide('db', getMigrations(db));
  await ctx.plugin(plugin, { ...config, relay_helper: helper });
  const dir = path.join(root, 'data', 'decision-map');
  return { app, ctx, db, dir, tools };
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
  events.onRequestEvent(ctx, 'work-decision/note', 'work-decision/note-result', async (request) => {
    if (request.action === 'reply') return { ok: false };

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
  await ctx.serial('work-decision/ask', { nodes: [{ id, body: '**附件已核对**' }] });
  expect(inbox).toHaveLength(2);

  const nested = { id: 'subtask', parent: id, title: '核对附件首页', kind: 'work', status: 'open' } as const;
  await ctx.serial('work-decision/ask', { nodes: [nested] });
  await ctx.serial('work-decision/ask', { nodes: [{ id, status: 'done' }] });
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
    action: 'put', actor: 'plugin', tasks: [{ node: id, title: child.title, status: 'done', previousStatus: 'working' }],
  }));
});

test('选项先落盘，relay 可重复投递但确认状态只记一次', async () => {
  const { app, ctx } = await setup('中控');
  const calls: string[] = [];
  const notices: string[] = [];
  events.onRequestEvent(ctx, 'work-decision/decided', 'work-decision/decided-result', (notice) => {
    expect(notice.asker).toEqual({ kind: 'helper', name: '中控' });
    expect(notice.key).toBe('release');
    notices.push(notice.option);
    calls.push('deliver');
    return { ok: true, id: 18 };
  });
  events.onRequestEvent(ctx, 'work-decision/note', 'work-decision/note-result', (request) => {
    if (request.action === 'reply') return { ok: false };

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
  expect(notices).toEqual(['a', 'a']);

  const ack = await app.inject({ method: 'POST', url: `${PREFIX}/ack`, payload: { node: 'release', note: '已安排' } });
  expect(ack.json()).toMatchObject({ node: { chosen: 'a', acknowledgedAt: expect.any(Number), note: '已安排' } });
  expect(calls).toEqual(['deliver', 'deliver', 'ack']);
  const changes = await app.inject(`${PREFIX}/changes?since=1`);
  expect(changes.json()).toMatchObject({ last: 3, changes: [{ seq: 2, action: 'choose' }, { seq: 3, action: 'ack' }] });
});

test('relay 缺席仍能通过变化接口轮询用户选择', async () => {
  const { app } = await setup('中控');
  await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload: entries });
  const url = `${PREFIX}/choose`;
  const unknown = await app.inject({ method: 'POST', url, payload: { node: 'release', option: '无效' } });
  expect(unknown.statusCode).toBe(400);
  const picked = await app.inject({ method: 'POST', url, payload: { node: 'release', option: 'a' } });
  expect(picked.json()).toMatchObject({ delivery: { method: 'GET', path: `${PREFIX}/changes` } });
  const changes = await app.inject(`${PREFIX}/changes?since=1`);
  expect(changes.json()).toMatchObject({ last: 2, changes: [{ seq: 2, action: 'choose', option: 'a' }] });
});

test('旧图和留言只导入一次，快照补齐残缺的历史并保留版本', async () => {
  const { dir } = await setup();
  fs.mkdirSync(dir, { recursive: true });
  const decision = {
    ...entries[1], kind: 'decided', status: 'decided', chosen: 'a', decidedBy: 'user',
    createdAt: 100, summary: '', notes: [{ id: 'n1', author: 'user', at: 200, text: '看日志' }],
  };
  const goal = { ...entries[0], parent: null, createdAt: 50, summary: '' };
  const head = { seq: 2, at: 200, actor: 'user', action: 'choose', nodes: ['release'], option: 'a' };
  const encoded = JSON.stringify({ revision: 2, nodes: [goal, decision], head });
  const graph = path.join(dir, 'graph.json');
  const history = path.join(dir, 'history.jsonl');
  const first = JSON.stringify({ seq: 1, at: 100, actor: 'central', action: 'put', nodes: ['goal', 'release'] });
  fs.writeFileSync(graph, encoded);
  fs.writeFileSync(history, `${first}\n{"seq":`, 'utf8');
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const project = { bot: '开发', workspaceId: 'repo' };
  db.exec("CREATE TABLE workspaces (id, bot, name, scope_key); INSERT INTO workspaces VALUES ('repo', '开发', '仓库', 'private')");
  const migrations = getMigrations(db);
  const restored = new storeModule.Store(db, migrations, dir, project.workspaceId);
  //M 选择、作者、留言和版本一起恢复，后续写入从原序号继续。
  const restoredGraph = restored.getGraph();
  const restoredNode = restoredGraph.nodes.find((node) => node.id === 'release');
  expect(restoredGraph.revision).toBe(2);
  expect(restoredNode).toMatchObject({ ...project, chosen: 'a', decidedBy: 'user', notes: decision.notes });
  expect(restored.getChanges(1)).toMatchObject({ changes: [{ seq: 2, action: 'choose', option: 'a' }] });
  restored.ack('release');
  const reopened = new storeModule.Store(db, migrations, dir, project.workspaceId);
  expect(reopened.getGraph().revision).toBe(3);
  expect(reopened.getChanges(0).changes.map((change) => change.seq)).toEqual([1, 2, 3]);
  expect(fs.readFileSync(graph, 'utf8')).toBe(encoded);
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
  events.onRequestEvent(ctx, 'work-decision/decided', 'work-decision/decided-result', (notice) => {
    notices.push(notice.option);
    calls.push({ action: 'deliver', helper: '中控', node: notice.key, text: notice.text });
    return { ok: true, id: 30 + calls.length };
  });
  events.onRequestEvent(ctx, 'work-decision/note', 'work-decision/note-result', (request) => {
    if (request.action === 'reply') return { ok: false };

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
  expect(calls[0]?.text).toContain('工作决策「今天发吗」节点 release：用户写了：等我看完日志再说');

  const working = await app.inject({ method: 'POST', url, payload: { node: 'scope', text: '先做手机上的' } });
  expect(working.json()).toMatchObject({ node: { status: 'working', notes: [{ id: 'n1' }] } });

  const withOption = await app.inject({ method: 'POST', url, payload: { node: 'release', option: 'b', text: '周五别发' } });
  expect(withOption.json()).toMatchObject({
    node: { kind: 'decided', chosen: 'b', decidedBy: 'user', notes: [{ id: 'n1' }, { id: 'n2', option: 'b' }] },
  });
  expect(notices).toEqual(['b']);
  expect(calls[2]?.node).toBe('release#n2');
  expect(calls[2]?.text).toContain('主人选了「明天发」（b）');
  expect(calls[2]?.text).toContain('备注：周五别发');

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

test('留言在 relay 无人接单或处理抛错时仍存盘并返回轮询入口', async () => {
  const { app, ctx } = await setup('中控');
  await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload: entries });
  const url = `${PREFIX}/note`;
  const retry = { method: 'GET', path: `${PREFIX}/changes` };

  //M relay 无人接单时保留已写入的留言，可从变化接口补查。
  const absent = { node: 'release', text: '没人接时留下的话' };
  const unhandled = await app.inject({ method: 'POST', url, payload: absent });
  expect(unhandled.statusCode).toBe(200);
  expect(unhandled.json()).toMatchObject({ note: { id: 'n1', text: absent.text }, delivery: retry });

  //M 接单后出错仍返回保存的留言，并说明收件是否成功未知。
  events.onRequestEvent(ctx, 'work-decision/note', 'work-decision/note-result', () => {
    throw new Error('模拟收件抛错');
  });
  const failed = { node: 'release', text: '接单抛错时留下的话' };
  const error = await app.inject({ method: 'POST', url, payload: failed });
  expect(error.statusCode).toBe(200);
  expect(error.json()).toMatchObject({
    node: { notes: [{ id: 'n1', text: absent.text }, { id: 'n2', text: failed.text }] },
    delivery: { ...retry, error: '中控收件操作结果不确定' },
  });
});

test('ask_owner 按会话工作区分组，重复调用不加节点，点选后只唤醒原会话一次', async () => {
  const { app, ctx, db, tools } = await setup();
  db.exec("CREATE TABLE workspaces (id, bot, name, scope_key); INSERT INTO workspaces VALUES ('ws-a', '开发', '仓库 A', 'private')");
  const tool = tools.get('ask_owner')!;
  expect(tool.sessionKinds).toEqual(['work']);
  const row = { id: 'work-1', bot: '开发', kind: 'work', workspaceId: 'ws-a' };
  const session = { row } as Session;
  const signal = new AbortController().signal;
  const args = { title: '何时发布', summary: '发布窗口', options: entries[1]!.options };
  const first = await tool.run(args, session, signal, 'same-call');
  const repeated = await tool.run(args, session, signal, 'same-call');
  expect(repeated).toBe(first);
  const receipt = JSON.parse(String(first)) as { id: string; url: string };
  expect(receipt.url).toBe(`/work-decision/?focus=${receipt.id}`);
  const graph = await app.inject(`${PREFIX}/graph`);
  expect(graph.json()).toMatchObject({
    projects: [{ name: '仓库 A' }],
    nodes: [{ workspaceId: 'ws-a', kind: 'goal' }, { id: receipt.id, workspaceId: 'ws-a', kind: 'pending' }],
  });

  const deliveries: string[] = [];
  events.onRequestEvent(ctx, 'bot/request', 'bot/result', (request) => {
    if (request.action !== 'accept-result') return { ok: false };

    expect(request.input.sessionId).toBe(row.id);
    deliveries.push(request.input.payload.text);
    return { ok: true, receipt: { status: 'queued', key: request.input.key } } as const;
  });
  const payload = { node: receipt.id, option: 'a' };
  const choose = { method: 'POST', url: `${PREFIX}/choose`, payload } as const;
  expect((await app.inject(choose)).json()).toMatchObject({ delivery: { queued: true } });
  expect((await app.inject(choose)).json()).toMatchObject({ delivery: { queued: true } });
  expect(deliveries).toEqual([expect.stringContaining('主人选了「今天发」')]);

  const old = await app.inject('/decision-map/?focus=release&lang=fr');
  expect(old.statusCode).toBe(301);
  expect(old.headers.location).toBe('/work-decision/?focus=release&lang=fr');
});

test('外部助手提问通知配置中的主人，选择不发给默认中控', async () => {
  const config = {
    public_url: 'http://127.0.0.1:30086/work-decision/',
    owner_target: { bot: '开发', channel: 'feishu', chat: 'ou_owner' },
  };
  const { app, ctx } = await setup('中控', config);
  const notices: channel.ChannelReplyRequest[] = [];
  ctx.on('channel/reply', (request) => {
    request.handled = true;
    notices.push(request);
    const receipt = channel.getReceipt(request, 'sent', '');
    channel.emitReplied(ctx, request, receipt);
  });
  const decisions: string[] = [];
  events.onRequestEvent(ctx, 'work-decision/decided', 'work-decision/decided-result', (notice) => {
    if (notice.asker.kind !== 'helper') return { ok: false };

    decisions.push(notice.asker.name);
    return { ok: true, id: 21 };
  });
  const payload = { id: 'external-ask', bot: '开发', helper: '外部助手', title: '什么时候上线',
    summary: '决定发布时间', options: entries[1]!.options };
  const ask = { method: 'POST', url: `${PREFIX}/ask`, payload } as const;
  const created = await app.inject(ask);
  const ticket = created.json<{ id: string; url: string }>();
  expect(ticket).toEqual({ id: payload.id, url: `/work-decision/?focus=${payload.id}` });
  await app.inject(ask);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ bot: '开发', target: { channel: 'feishu', chat: 'ou_owner' } });
  expect(notices[0]?.parts[0]).toMatchObject({ text: expect.stringContaining('工作决策有 1 件等你定') });
  const body = { node: payload.id, option: 'b' };
  const selected = await app.inject({ method: 'POST', url: `${PREFIX}/choose`, payload: body });
  expect(selected.json()).toMatchObject({ delivery: { relayId: 21 } });
  expect(decisions).toEqual(['外部助手']);
});

test('version 轻量探针稳定返回进程启动时刻与递增数据序号', async () => {
  const { app } = await setup('中控');
  const before = Date.now();
  const v0Res = await app.inject(`${PREFIX}/version`);
  expect(v0Res.statusCode).toBe(200);
  const v0 = v0Res.json<{ appStartedAt: number; dataRev: number }>();
  expect(v0.appStartedAt).toBeGreaterThanOrEqual(before - 5000);
  expect(v0.dataRev).toBe(0);

  await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload: entries });
  const v1 = (await app.inject(`${PREFIX}/version`)).json<{ appStartedAt: number; dataRev: number }>();
  expect(v1.appStartedAt).toBe(v0.appStartedAt);
  expect(v1.dataRev).toBe(1);

  await app.inject({ method: 'POST', url: `${PREFIX}/note`, payload: { node: 'release', text: '先核一下监控' } });
  const v2 = (await app.inject(`${PREFIX}/version`)).json<{ appStartedAt: number; dataRev: number }>();
  expect(v2.appStartedAt).toBe(v0.appStartedAt);
  expect(v2.dataRev).toBe(2);

  await app.inject({ method: 'POST', url: `${PREFIX}/reply`, payload: { node: 'release', note: 'n1', text: '已核' } });
  const v3 = (await app.inject(`${PREFIX}/version`)).json<{ appStartedAt: number; dataRev: number }>();
  expect(v3.appStartedAt).toBe(v0.appStartedAt);
  expect(v3.dataRev).toBe(3);
});

test('前端按节点持久化输入草稿，切换与空白清理不互串', async () => {
  const store = new Map<string, string>();
  const prevWindow = (globalThis as { window?: unknown }).window;
  cleanups.push(() => {
    (globalThis as { window?: unknown }).window = prevWindow;
  });
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => { store.set(key, val); },
      removeItem: (key: string) => { store.delete(key); },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const drafts = await import('../../../web/src/DecisionMap/Drafts.ts');
  expect(drafts.hasAnyDraft()).toBe(false);

  drafts.writeDraft('topic-aobb', '先把手机竖屏截一张');
  drafts.writeDraft('topic-wechat', '   ');
  expect(drafts.readDraft('topic-aobb')).toBe('先把手机竖屏截一张');
  expect(drafts.hasAnyDraft()).toBe(true);

  drafts.writeDraft('topic-aobb', '');
  expect(drafts.readDraft('topic-aobb')).toBe('');
  expect(drafts.hasAnyDraft()).toBe(false);
});

test('节点四象限可选字段读写、平滑补列、POST/PUT 调整及 null 清空恢复自动', async () => {
  //M 模拟尚未包含 quadrant 列的旧库表结构，验证挂载时自动补列且不丢历史行。
  const legacyDb = new Database(':memory:');
  cleanups.push(() => legacyDb.close());
  legacyDb.exec(`
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT, bot TEXT, parent TEXT,
      kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      body TEXT, options TEXT, chosen TEXT, asker TEXT, main TEXT, needs TEXT,
      sources TEXT, links TEXT, detail_path TEXT, created_at INTEGER NOT NULL,
      decided_at INTEGER, decided_by TEXT, acknowledged_at INTEGER, note TEXT
    );
    INSERT INTO decisions (id, parent, kind, status, title, summary, created_at)
    VALUES ('goal', NULL, 'goal', 'working', '旧库根目标', '', 1700000000000);
  `);
  const legacyDir = path.join(import.meta.dir, '.non-existent');
  const migratedStore = new storeModule.Store(legacyDb, getMigrations(legacyDb), legacyDir);
  expect(migratedStore.getGraph().nodes[0]?.id).toBe('goal');
  expect(migratedStore.getGraph().nodes[0]?.quadrant).toBeUndefined();
  //M 迁移账本记下两版，quadrant 是第 2 版真加出来的。
  const columns = legacyDb.query<{ name: string }, []>('PRAGMA table_info(decisions)').all();
  expect(columns.some((column) => column.name === 'quadrant')).toBe(true);
  const ledger = "SELECT version FROM db_migrations WHERE plugin = 'work-decision' ORDER BY version";
  expect(legacyDb.query<{ version: number }, []>(ledger).all()).toEqual([{ version: 1 }, { version: 2 }]);

  const { app } = await setup();
  const initial = await app.inject({
    method: 'PUT',
    url: `${PREFIX}/nodes`,
    payload: [entries[0], { ...entries[1], quadrant: 'q1' }],
  });
  expect(initial.statusCode).toBe(200);
  const loaded = (await app.inject(`${PREFIX}/graph`)).json<types.DecisionGraph>();
  expect(loaded.nodes.find((node) => node.id === 'release')?.quadrant).toBe('q1');

  //M 非法象限值拒绝入库，保持原值不变。
  const bad = await app.inject({
    method: 'POST',
    url: `${PREFIX}/quadrant`,
    payload: { id: 'release', quadrant: 'q9' },
  });
  expect(bad.statusCode).toBe(400);

  //M 网页手动切到 q3 落盘并写入变化流水。
  const moved = await app.inject({
    method: 'POST',
    url: `${PREFIX}/quadrant`,
    payload: { id: 'release', quadrant: 'q3' },
  });
  expect(moved.statusCode).toBe(200);
  expect(moved.json<{ node: types.DecisionNode }>().node.quadrant).toBe('q3');

  //M 传 null 清除手动覆盖，公开快照省略 quadrant 字段，不破坏节点其余内容。
  const cleared = await app.inject({
    method: 'PUT',
    url: `${PREFIX}/quadrant`,
    payload: { id: 'release', quadrant: null },
  });
  expect(cleared.statusCode).toBe(200);
  const afterClear = (await app.inject(`${PREFIX}/graph`)).json<types.DecisionGraph>();
  const finalNode = afterClear.nodes.find((node) => node.id === 'release');
  expect(finalNode?.quadrant).toBeUndefined();
  expect(finalNode?.title).toBe('今天发吗');
});

test('前端四象限自动归类与手动覆盖规则合理分布于 Q1~Q4 且过滤目录壳', async () => {
  const quadrants = await import('../../../web/src/DecisionMap/Quadrants.ts');
  const sample: types.DecisionNode[] = [
    { id: 'goal', parent: null, kind: 'goal', status: 'working', title: '总目标', summary: '', createdAt: 1 },
    { id: 'topic-a', parent: 'goal', kind: 'fork', status: 'working', title: '渠道专题', summary: '', createdAt: 2 },
    {
      id: 'p-core', parent: 'topic-a', kind: 'pending', status: 'open',
      title: 'AOBB 默认定法何时开工', summary: '核心架构拍板', createdAt: 3,
      options: [{ id: 'a', text: '开工' }],
    },
    {
      id: 'p-clean', parent: 'topic-a', kind: 'pending', status: 'open',
      title: '删掉废弃的 Go 目录吗', summary: '无人使用', createdAt: 4,
      options: [{ id: 'a', text: '删' }],
    },
    {
      id: 'w-core', parent: 'topic-a', kind: 'feature', status: 'working',
      title: '统一记忆搜索推进', summary: '', createdAt: 5,
    },
    {
      id: 'w-done', parent: 'topic-a', kind: 'work', status: 'done',
      title: '历史收尾项', summary: '', createdAt: 6,
    },
    {
      id: 'w-manual', parent: 'topic-a', kind: 'work', status: 'done', quadrant: 'q2',
      title: '手动钉在 Q2 的事项', summary: '', createdAt: 7,
    },
  ];
  const built = quadrants.buildQuadrantEntries(sample);
  //M 根目标 goal 与带子项的纯目录壳 topic-a 不重复作为卡片混入四象限。
  expect(built.map((item) => item.node.id)).toEqual(['p-core', 'p-clean', 'w-core', 'w-done', 'w-manual']);
  expect(built.find((item) => item.node.id === 'p-core')?.quadrant).toBe('q1');
  expect(built.find((item) => item.node.id === 'p-clean')?.quadrant).toBe('q3');
  expect(built.find((item) => item.node.id === 'w-core')?.quadrant).toBe('q2');
  expect(built.find((item) => item.node.id === 'w-done')?.quadrant).toBe('q4');
  expect(built.find((item) => item.node.id === 'w-manual')?.quadrant).toBe('q2');

  const activeOnly = quadrants.filterQuadrantEntries(built, 'active');
  expect(activeOnly.map((item) => item.node.id)).toEqual(['p-core', 'p-clean', 'w-core']);
});


test('work_topics 前后台本人可查：概览、按状态和关键词筛、看详情、limit，外人会话被拒', async () => {
  const { app, tools } = await setup();
  //M 合成四个节点：目标进行中、待定带选项、已完成带英文关键词、已放弃。
  const done = { id: 'docs', kind: 'feature', title: '补说明', parent: 'goal', status: 'done', summary: '写 Alpha 说明' };
  const dropped = { id: 'old', kind: 'feature', title: '旧方案', parent: 'goal', status: 'dropped' };
  const payload = [entries[0], entries[1], done, dropped];
  const seeded = await app.inject({ method: 'PUT', url: `${PREFIX}/nodes`, payload });
  expect(seeded.statusCode).toBe(200);

  const tool = tools.get('work_topics')!;
  expect(tool.sessionKinds).toEqual(['front', 'work']);
  const signal = new AbortController().signal;
  const owner = { row: { id: 'front-1', bot: '开发', kind: 'front' } } as Session;
  const run = async (args: Record<string, unknown>) => String(await tool.run(args, owner, signal, 'call'));

  //T 无参数：各状态计数，待定排在进行中前面，末尾带知识库提示。
  const overview = await run({});
  expect(overview).toContain('决策图共 4 个节点：待定 1，进行中 1，已定 0，已完成 1，已放弃 1。');
  expect(overview.indexOf('[topicId=release]')).toBeLessThan(overview.indexOf('[topicId=goal]'));
  expect(overview).toContain('kb_search');

  //T 按状态、按关键词（大小写不敏感）、没有命中。
  const byStatus = await run({ status: 'done' });
  expect(byStatus).toContain('- [topicId=docs]〔已完成〕补说明 — 写 Alpha 说明');
  expect(byStatus).not.toContain('[topicId=goal]');
  expect(await run({ query: 'ALPHA' })).toContain('[topicId=docs]');
  expect(await run({ query: '不存在的词' })).toContain('没有符合条件的节点。');

  //T limit 截断时提示还有几个。
  expect(await run({ limit: 1 })).toContain('还有 3 个没列');

  //T 看详情：选项带推荐标记、上级带 topicId；目标节点列出下级；不存在的给提示。
  const detail = await run({ nodeId: 'release' });
  expect(detail).toContain('## [topicId=release] 今天发吗');
  expect(detail).toContain('- 选项 a★：今天发（代价：留时间看日志）');
  expect(detail).toContain('- 上级：[topicId=goal] 上线目标');
  expect(await run({ nodeId: 'goal' })).toContain('  - [topicId=docs]〔已完成〕补说明');
  expect(await run({ nodeId: 'nope' })).toContain('没有节点 nope');

  //T 后台本人会话同样能查。
  const work = { row: { id: 'work-1', bot: '开发', kind: 'work', channel: 'web' } } as Session;
  expect(String(await tool.run({ nodeId: 'docs' }, work, signal, 'call'))).toContain('[topicId=docs]');

  //T 飞书群里的外人会话：拒绝，不吐任何节点。
  const guestRow = { id: 'front-2', bot: '开发', kind: 'front', channel: 'feishu', address: { role: 'guest' } };
  const guest = { row: guestRow } as unknown as Session;
  expect(() => tool.run({}, guest, signal, 'call')).toThrow('只有本人会话可以查看工作决策');
});


test('旧代码已手动补过 quadrant 的库：迁移第 2 版只登记不重加，数据和四象限原样保留；重启只核对账本', () => {
  //M 模拟 1.3.11 跑过的用户库：三张表都在，decisions 已有 quadrant 列和数据，账本里没有 work-decision。
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const createDecisions = sqliteModule.decisionMigrations.migrations[0]!.sql.split('--> statement-breakpoint')[0]!;
  db.exec(createDecisions);
  db.exec('ALTER TABLE decisions ADD COLUMN quadrant TEXT');
  db.exec(`INSERT INTO decisions (id, parent, kind, status, title, summary, created_at, quadrant)
    VALUES ('goal', NULL, 'goal', 'working', '老库目标', '', 1700000000000, 'q2')`);

  const legacyDir = path.join(import.meta.dir, '.non-existent');
  const store = new storeModule.Store(db, getMigrations(db), legacyDir);
  expect(store.getGraph().nodes).toMatchObject([{ id: 'goal', title: '老库目标', quadrant: 'q2' }]);

  //M 第 1 版补齐了缺的两张表；第 2 版接管已有的列，没有再 ALTER（再加一次会报 duplicate column）。
  const tables = "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'decision%' ORDER BY name";
  const names = db.query<{ name: string }, []>(tables).all().map((row) => row.name);
  expect(names).toEqual(['decision_changes', 'decision_notes', 'decisions']);
  const ledger = "SELECT version FROM db_migrations WHERE plugin = 'work-decision' ORDER BY version";
  expect(db.query<{ version: number }, []>(ledger).all()).toEqual([{ version: 1 }, { version: 2 }]);

  //M 重启再挂一次：账本已有，只核对摘要，不重跑、不报错。
  const again = new storeModule.Store(db, getMigrations(db), legacyDir);
  expect(again.getGraph().nodes[0]?.quadrant).toBe('q2');
});

