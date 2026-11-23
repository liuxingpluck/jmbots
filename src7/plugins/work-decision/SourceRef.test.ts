/**
 * 控制面任务来源引用（sourceRef）离线单测：入口校验 400 与 null 清空、持久化与老 JSON 兼容、
 * GET 来源 6 维筛选、POST /tasks 来源重复 409、POST /tasks/upsert 幂等命中与补齐、垃圾桶不误判、
 * done/cancelled 默认不重开、新建 running 撞锁 409，以及 work-decision/task-upsert 事件回执。
 * 跑法：bun test src7/plugins/work-decision/SourceRef.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqlite from 'bun:sqlite';
import * as bunTest from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import type { ToolSpec } from '../../Tools.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as channel from '../channels/Reply.ts';
import * as dbModule from '../db/index.ts';
import * as plugin from './index.ts';
import type * as routesModule from './Routes.ts';
import * as sourceRefModule from './SourceRef.ts';
import type * as types from './Types.ts';


const { afterEach, describe, expect, test } = bunTest;
const PREFIX = '/api/work-decision';
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});


/** 挂真实 work-decision 插件，数据写进临时运行时目录；给了 existingRoot 就复用（测重启恢复）。 */
async function createHarness(existingRoot?: string, pluginConfig: Record<string, unknown> = {}) {
  const root = existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jm-source-ref-'));
  if (existingRoot === undefined) {
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  }
  const ctx = new cordis.Context();
  const app = fastify.default({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let status = 500;
    if (error instanceof failureModule.Failure) {
      status = error.status;
    }
    return reply.code(status).send({ error: textModule.getErrorMessage(error) });
  });
  const db = new sqlite.Database(':memory:');
  const tools = new Map<string, ToolSpec>();
  cleanups.push(() => db.close());
  cleanups.push(async () => {
    await app.close();
  });
  cleanups.push(async () => {
    await ctx.fiber.dispose();
  });

  ctx.provide('http', { app });
  ctx.provide('resources', { db, root, raw: {} });
  ctx.provide('tools', { register: (tool: ToolSpec) => tools.set(tool.definition.name, tool) });
  ctx.provide('db', new dbModule.Db(new cordis.Context(), db));
  await ctx.plugin(plugin, pluginConfig);
  await app.ready();
  return { root, app, ctx };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/** 发一个 JSON 请求，交回状态码和解析后的正文。 */
async function call(h: Harness, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const response = await h.app.inject({ method, url: `${PREFIX}${url}`, payload: payload as object });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

/** 列任务并交回 ID（按 ID 排好，方便比）。 */
async function listIds(h: Harness, query: string): Promise<string[]> {
  const listed = await call(h, 'GET', `/tasks${query}`);
  expect(listed.status).toBe(200);
  const tasks = listed.body['tasks'] as types.ControlTask[];
  return tasks.map((task) => task.id).sort();
}


describe('SourceRefHelper：规范化、去重键、补齐与筛选', () => {
  test('normalize 去空白、空串省略；deriveDedupeKey 优先级；mergeMissing 不覆盖已有字段并钉住原去重键', () => {
    const helper = new sourceRefModule.SourceRefHelper();
    const ref = helper.normalize({ channel: ' feishu ', bot: ' 周小灵 ', chatName: '  ', relayId: 7 });
    expect(ref).toEqual({ channel: 'feishu', bot: '周小灵', relayId: 7 });

    expect(helper.deriveDedupeKey({ channel: 'feishu', dedupeKey: 'k1', relayId: 7 })).toBe('k1');
    expect(helper.deriveDedupeKey({ channel: 'feishu', relayId: 7, messageId: 'm1' })).toBe('relay:feishu:7');
    expect(helper.deriveDedupeKey({ channel: 'feishu', messageId: 'm1' })).toBe('msg:feishu:m1');
    expect(helper.deriveDedupeKey({ channel: 'feishu', bot: '周小灵' })).toBeUndefined();

    //M 原来只有 messageId，新来的带了 relayId：补上 relayId，同时把原来的键钉成 dedupeKey。
    const existing = { channel: 'feishu', bot: '周小灵', messageId: 'm1' };
    const merged = helper.mergeMissing(existing, { channel: 'feishu', bot: '韩信', relayId: 9, chatName: '群' });
    expect(merged).toEqual({
      channel: 'feishu',
      bot: '周小灵',
      messageId: 'm1',
      relayId: 9,
      chatName: '群',
      dedupeKey: 'msg:feishu:m1',
    });
    expect(existing).toEqual({ channel: 'feishu', bot: '周小灵', messageId: 'm1' });
    expect(helper.clone(undefined)).toBeUndefined();
  });

  test('deriveDedupeKey 纯空白 dedupeKey 降级；normalize 与 parseQuery 拒收不安全整数 relayId', () => {
    const helper = new sourceRefModule.SourceRefHelper();

    //M 纯空白 dedupeKey 降级走 relayId 或 messageId；带前后空白的显式键会 trim。
    expect(helper.deriveDedupeKey({ channel: 'feishu', dedupeKey: '   ', relayId: 7 })).toBe('relay:feishu:7');
    expect(helper.deriveDedupeKey({ channel: 'feishu', dedupeKey: ' \t ', messageId: 'm1' })).toBe('msg:feishu:m1');
    expect(helper.deriveDedupeKey({ channel: 'feishu', dedupeKey: '  k2  ', relayId: 7 })).toBe('k2');
    expect(helper.deriveDedupeKey({ channel: 'feishu', dedupeKey: '   ' })).toBeUndefined();

    //G normalize 拒收超出安全整数上限或 Infinity 的 relayId，接受最大安全整数。
    const unsafeNumber = Number.MAX_SAFE_INTEGER + 1;
    expect(() => helper.normalize({ channel: 'feishu', relayId: unsafeNumber })).toThrow('安全整数');
    expect(() => helper.normalize({ channel: 'feishu', relayId: Number.POSITIVE_INFINITY })).toThrow('安全整数');
    expect(() => helper.normalize({ channel: 'feishu', relayId: 1e30 })).toThrow('安全整数');
    expect(helper.normalize({ channel: 'feishu', relayId: Number.MAX_SAFE_INTEGER }).relayId)
      .toBe(Number.MAX_SAFE_INTEGER);

    //G parseQuery 拒收超长数字串（变 Infinity 或失精度），接受最大安全整数。
    expect(() => helper.parseQuery({ relayId: '9007199254740992' })).toThrow('安全整数');
    expect(() => helper.parseQuery({ relayId: '9'.repeat(400) })).toThrow('安全整数');
    expect(helper.parseQuery({ relayId: String(Number.MAX_SAFE_INTEGER) })).toEqual({
      relayId: Number.MAX_SAFE_INTEGER,
    });
  });
});


describe('控制面任务 sourceRef：HTTP 入口、筛选、去重与幂等入池', () => {
  test('1. 非法 sourceRef 一律 400 且不写盘；upsert 不带 sourceRef 400；PATCH sourceRef: null 清空', async () => {
    const h = await createHarness();
    const bad: unknown[] = [
      'feishu',
      {},
      { channel: '' },
      { channel: '   ' },
      { channel: 3 },
      { channel: 'feishu', chatType: 'room' },
      { channel: 'feishu', relayId: 0 },
      { channel: 'feishu', relayId: 1.5 },
      { channel: 'feishu', relayId: '3' },
      { channel: 'feishu', relayId: Number.MAX_SAFE_INTEGER + 1 },
      { channel: 'feishu', relayId: 1e30 },
      { channel: 'feishu', bot: 5 },
    ];
    for (const sourceRef of bad) {
      const denied = await call(h, 'POST', '/tasks', { title: '坏来源', sourceRef });
      expect(denied.status).toBe(400);
    }
    expect(await listIds(h, '')).toEqual([]);

    const noRef = await call(h, 'POST', '/tasks/upsert', { title: '没来源' });
    expect(noRef.status).toBe(400);
    const nullRef = await call(h, 'POST', '/tasks/upsert', { sourceRef: null });
    expect(nullRef.status).toBe(400);

    //M 建一张带来源的，再用 PATCH null 清空。
    const created = await call(h, 'POST', '/tasks', {
      id: 'src-clear',
      title: '带来源',
      sourceRef: { channel: 'feishu', bot: '周小灵', chatType: 'group', relayId: 3 },
    });
    expect(created.status).toBe(200);
    expect((created.body['task'] as types.ControlTask).sourceRef?.chatType).toBe('group');
    const cleared = await call(h, 'PATCH', '/tasks/src-clear', { sourceRef: null, by: '132' });
    expect(cleared.status).toBe(200);
    const clearedTask = cleared.body['task'] as types.ControlTask;
    expect('sourceRef' in clearedTask).toBe(false);
    expect(clearedTask.events.at(-1)?.text).toContain('清空来源关联');
  });

  test('2. sourceRef 持久化重启恢复，老版本无 sourceRef 的 JSON 照常加载', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-source-ref-old-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const now = Date.now();
    const oldTask = {
      id: 'old-1',
      title: '老任务',
      summary: '',
      status: 'ready',
      priority: 'P1',
      lockTags: [],
      owner: '',
      doneCriteria: '',
      lastHeartbeatAt: null,
      events: [{ at: now, by: 'central', kind: 'created', text: '创建任务' }],
      createdAt: now,
      updatedAt: now,
    };
    const oldFile = { version: 1, revision: 5, tasks: [oldTask] };
    fs.writeFileSync(path.join(root, 'control-plane-tasks.json'), JSON.stringify(oldFile), 'utf8');

    const first = await createHarness(root);
    expect(await listIds(first, '?hasSource=false')).toEqual(['old-1']);
    const sourceRef = { channel: 'wechat', bot: '韩信', chatId: 'wx-1', messageId: 'm-9', sender: '客户甲' };
    const created = await call(first, 'POST', '/tasks', { id: 'new-1', title: '新任务', sourceRef });
    expect(created.status).toBe(200);

    //M 换一个进程（新 harness 读同一目录）：来源原样恢复，老任务仍没有来源键。
    const second = await createHarness(root);
    const listed = await call(second, 'GET', '/tasks');
    const tasks = listed.body['tasks'] as types.ControlTask[];
    expect(tasks.find((task) => task.id === 'new-1')?.sourceRef).toEqual(sourceRef);
    expect('sourceRef' in tasks.find((task) => task.id === 'old-1')!).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'control-plane-tasks.json'), 'utf8')) as {
      tasks: Record<string, unknown>[];
    };
    expect('sourceRef' in saved.tasks.find((task) => task['id'] === 'old-1')!).toBe(false);
  });

  test('3. GET /tasks 来源 6 维筛选，非法 relayId、hasSource 回 400', async () => {
    const h = await createHarness();
    const feishuRef = {
      channel: 'feishu',
      bot: '周小灵',
      chatId: 'oc-1',
      sessionId: 'sess-1',
      relayId: 11,
    };
    const wechatRef = { channel: 'wechat', bot: '韩信', chatId: 'oc-2', relayId: 12 };
    await call(h, 'POST', '/tasks', { id: 'a', title: 'A', sourceRef: feishuRef });
    await call(h, 'POST', '/tasks', { id: 'b', title: 'B', sourceRef: wechatRef });
    await call(h, 'POST', '/tasks', { id: 'c', title: 'C' });

    expect(await listIds(h, '?channel=feishu')).toEqual(['a']);
    expect(await listIds(h, `?bot=${encodeURIComponent('韩信')}`)).toEqual(['b']);
    expect(await listIds(h, '?chatId=oc-1')).toEqual(['a']);
    expect(await listIds(h, '?sessionId=sess-1')).toEqual(['a']);
    expect(await listIds(h, '?relayId=12')).toEqual(['b']);
    expect(await listIds(h, '?hasSource=true')).toEqual(['a', 'b']);
    expect(await listIds(h, '?hasSource=false')).toEqual(['c']);
    expect(await listIds(h, '?channel=feishu&relayId=12')).toEqual([]);
    expect(await listIds(h, '?channel=')).toEqual(['a', 'b', 'c']);

    const badQueries = [
      '?relayId=abc',
      '?relayId=0',
      '?relayId=1.5',
      '?relayId=9007199254740992',
      `?relayId=${'9'.repeat(400)}`,
      '?hasSource=yes',
    ];
    for (const query of badQueries) {
      const denied = await call(h, 'GET', `/tasks${query}`);
      expect(denied.status).toBe(400);
    }
  });

  test('4. POST /tasks 来源重复 409 带 taskId；upsert 按 relayId、messageId、dedupeKey 命中，只补缺的子字段并追加事件', async () => {
    const h = await createHarness();
    const first = await call(h, 'POST', '/tasks', {
      id: 'relay-task',
      title: '原标题',
      owner: '132',
      priority: 'P0',
      sourceRef: { channel: 'feishu', bot: '周小灵', relayId: 31 },
    });
    expect(first.status).toBe(200);

    //M POST /tasks 同一来源：409 并带已有任务 ID，不悄悄复用。
    const dup = await call(h, 'POST', '/tasks', {
      title: '重复',
      sourceRef: { channel: 'feishu', relayId: 31 },
    });
    expect(dup.status).toBe(409);
    expect(dup.body['taskId']).toBe('relay-task');

    //M upsert 按 relayId 命中：补 chatName，不改 bot 和主字段，追加 note。
    const byRelay = await call(h, 'POST', '/tasks/upsert', {
      title: '不该改标题',
      priority: 'P2',
      sourceRef: { channel: 'feishu', bot: '韩信', relayId: 31, chatName: '作战室' },
      eventText: '客户又追问了一次',
      by: 'relay',
    });
    expect(byRelay.status).toBe(200);
    expect(byRelay.body['created']).toBe(false);
    expect(byRelay.body['deduplicated']).toBe(true);
    const relayTask = byRelay.body['task'] as types.ControlTask;
    expect(relayTask.id).toBe('relay-task');
    expect(relayTask.title).toBe('原标题');
    expect(relayTask.priority).toBe('P0');
    expect(relayTask.owner).toBe('132');
    expect(relayTask.sourceRef).toEqual({ channel: 'feishu', bot: '周小灵', relayId: 31, chatName: '作战室' });
    expect(relayTask.events.at(-1)).toMatchObject({ kind: 'note', text: '客户又追问了一次', by: 'relay' });

    //M 什么都没变的重复入池：不写盘，修订号不涨。
    const revision = byRelay.body['revision'];
    const again = await call(h, 'POST', '/tasks/upsert', { sourceRef: { channel: 'feishu', relayId: 31 } });
    expect(again.body['deduplicated']).toBe(true);
    expect(again.body['revision']).toBe(revision);

    //M 按 messageId 命中（新建后再来一次，用 note 别名追加）。
    const msgCreated = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'wechat', messageId: 'wx-m-1' },
      eventText: '第一行当标题\n后面是细节',
    });
    expect(msgCreated.body['created']).toBe(true);
    const msgTask = msgCreated.body['task'] as types.ControlTask;
    expect(msgTask.title).toBe('第一行当标题');
    expect(msgTask.summary).toBe('第一行当标题\n后面是细节');
    expect(msgTask.list).toBe('收集箱');
    expect(msgTask.status).toBe('ready');
    const msgHit = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'wechat', messageId: 'wx-m-1', sender: '客户乙' },
      note: '补充一句',
    });
    expect(msgHit.body['deduplicated']).toBe(true);
    const msgHitTask = msgHit.body['task'] as types.ControlTask;
    expect(msgHitTask.id).toBe(msgTask.id);
    expect(msgHitTask.sourceRef?.sender).toBe('客户乙');
    expect(msgHitTask.events.at(-1)?.text).toBe('补充一句');

    //M 按显式 dedupeKey 命中（不同渠道写法也认同一个键）。
    const keyCreated = await call(h, 'POST', '/tasks/upsert', {
      title: '网页留言',
      sourceRef: { channel: 'web', dedupeKey: 'web-form-77' },
    });
    expect(keyCreated.body['created']).toBe(true);
    const keyHit = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'web', dedupeKey: 'web-form-77', bot: '周小灵' },
    });
    expect(keyHit.body['deduplicated']).toBe(true);
    expect((keyHit.body['task'] as types.ControlTask).id).toBe((keyCreated.body['task'] as types.ControlTask).id);
    expect(await listIds(h, '?hasSource=true')).toHaveLength(3);
  });

  test('5. 垃圾桶里的任务不会让 POST /tasks 误判 409，也不会被 upsert 误命中', async () => {
    const h = await createHarness();
    const sourceRef = { channel: 'feishu', relayId: 41 };
    await call(h, 'POST', '/tasks', { id: 'trashed', title: '扔掉的', sourceRef });
    const trashed = await call(h, 'PATCH', '/tasks/trashed', { trashedAt: Date.now() });
    expect(trashed.status).toBe(200);

    const recreated = await call(h, 'POST', '/tasks', { id: 'fresh', title: '新建的', sourceRef });
    expect(recreated.status).toBe(200);
    await call(h, 'PATCH', '/tasks/fresh', { trashedAt: Date.now() });

    const upserted = await call(h, 'POST', '/tasks/upsert', { sourceRef, eventText: '又来了' });
    expect(upserted.body['created']).toBe(true);
    const upsertedId = (upserted.body['task'] as types.ControlTask).id;
    expect(['trashed', 'fresh']).not.toContain(upsertedId);

    //M 反证：从垃圾桶还原撞上活着的同来源任务时回 409。
    const restore = await call(h, 'PATCH', '/tasks/trashed', { trashedAt: null });
    expect(restore.status).toBe(409);
    expect(restore.body['taskId']).toBe(upsertedId);
  });

  test('6. done / cancelled 的任务 upsert 默认保持原状态，reopen: true 才回到 ready 并记状态事件', async () => {
    const h = await createHarness();
    for (const status of ['done', 'cancelled'] as const) {
      const sourceRef = { channel: 'feishu', messageId: `closed-${status}` };
      const created = await call(h, 'POST', '/tasks', { id: `t-${status}`, title: status, status, sourceRef });
      expect(created.status).toBe(200);

      const kept = await call(h, 'POST', '/tasks/upsert', { sourceRef, eventText: '又提了一次' });
      const keptTask = kept.body['task'] as types.ControlTask;
      expect(keptTask.status).toBe(status);
      expect(keptTask.events.at(-1)?.kind).toBe('note');

      const reopened = await call(h, 'POST', '/tasks/upsert', { sourceRef, reopen: true });
      const reopenedTask = reopened.body['task'] as types.ControlTask;
      expect(reopenedTask.status).toBe('ready');
      expect(reopenedTask.events.at(-1)?.kind).toBe('status');
      expect(reopenedTask.events.at(-1)?.text).toContain('重新入池');
    }
    const badFlag = await call(h, 'POST', '/tasks/upsert', { sourceRef: { channel: 'x' }, reopen: 'yes' });
    expect(badFlag.status).toBe(400);
  });

  test('7. upsert 新建直接 running 仍遵守 lockTags 互斥，撞锁回 409 且不写盘', async () => {
    const h = await createHarness();
    const holder = await call(h, 'POST', '/tasks', {
      id: 'holder',
      title: '占着坑',
      status: 'running',
      owner: '131',
      lockTags: ['plugin:relay'],
    });
    expect(holder.status).toBe(200);

    const conflict = await call(h, 'POST', '/tasks/upsert', {
      title: '也想改 relay',
      status: 'running',
      lockTags: ['plugin:relay'],
      sourceRef: { channel: 'feishu', relayId: 71 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body['conflicts']).toBeDefined();
    expect(await listIds(h, '?hasSource=true')).toEqual([]);

    const free = await call(h, 'POST', '/tasks/upsert', {
      title: '不撞锁',
      status: 'running',
      lockTags: ['plugin:feishu'],
      sourceRef: { channel: 'feishu', relayId: 71 },
    });
    expect(free.status).toBe(200);
    expect((free.body['task'] as types.ControlTask).status).toBe('running');
  });

  test('8. work-decision/task-upsert 事件端到端：新建、去重命中与失败都收到 task-upsert-result 回执', async () => {
    const h = await createHarness();
    const payload = {
      sourceRef: { channel: 'feishu', bot: '周小灵', relayId: 81 },
      eventText: '经事件总线入池',
    };
    const first = await events.requestEvent(
      h.ctx,
      'work-decision/task-upsert',
      'work-decision/task-upsert-result',
      payload,
    );
    expect(first.reply?.ok).toBe(true);
    expect(first.reply?.created).toBe(true);
    const taskId = first.reply?.task?.id;
    expect(taskId).toBeDefined();

    const second = await events.requestEvent(h.ctx, 'work-decision/task-upsert', 'work-decision/task-upsert-result', {
      sourceRef: { channel: 'feishu', relayId: 81, chatName: '作战室' },
    });
    expect(second.reply?.deduplicated).toBe(true);
    expect(second.reply?.task?.id).toBe(taskId);
    expect(second.reply?.task?.sourceRef?.chatName).toBe('作战室');

    //M 失败也有回执：参数不对回 ok: false 和 400。
    const badPayload = { sourceRef: { channel: '' } } as types.ControlTaskUpsertInput;
    const failed = await events.requestEvent(
      h.ctx,
      'work-decision/task-upsert',
      'work-decision/task-upsert-result',
      badPayload,
    );
    expect(failed.reply?.ok).toBe(false);
    expect(failed.reply?.statusCode).toBe(400);
    expect(failed.reply?.error).toContain('sourceRef.channel');
  });

  test('9. 超长 chatName + sender 缺省标题自动截断不超 200 字，不误报 400', async () => {
    const h = await createHarness();
    const longRef: types.TaskSourceRef = {
      channel: 'feishu',
      bot: '周小灵助手'.repeat(20),
      chatName: '超长作战群名称'.repeat(25),
      sender: '超长发送人名称'.repeat(25),
      messageId: 'long-label-msg-1',
    };
    const res = await call(h, 'POST', '/tasks/upsert', { sourceRef: longRef });
    expect(res.status).toBe(200);
    expect(res.body['created']).toBe(true);
    const task = res.body['task'] as types.ControlTask;
    expect(task.title.length).toBeLessThanOrEqual(200);
    expect(task.title.startsWith('来自 ')).toBe(true);
    expect(task.title.endsWith(' 的任务')).toBe(true);
  });

  test('10. 同 messageId 不同显式 dedupeKey 不误合并，支持同消息拆多张任务', async () => {
    const h = await createHarness();
    const first = await call(h, 'POST', '/tasks/upsert', {
      title: '拆单 A',
      sourceRef: { channel: 'feishu', messageId: 'shared-msg-1', dedupeKey: 'split-a' },
    });
    expect(first.status).toBe(200);
    expect(first.body['created']).toBe(true);
    const firstId = (first.body['task'] as types.ControlTask).id;

    //M 同一条 messageId 但显式 dedupeKey 不同：新建第二张任务，不触发 isSameMessage 退化合并。
    const second = await call(h, 'POST', '/tasks/upsert', {
      title: '拆单 B',
      sourceRef: { channel: 'feishu', messageId: 'shared-msg-1', dedupeKey: 'split-b' },
    });
    expect(second.status).toBe(200);
    expect(second.body['created']).toBe(true);
    const secondId = (second.body['task'] as types.ControlTask).id;
    expect(secondId).not.toBe(firstId);

    //M POST /tasks 同样允许同 messageId 配不同显式 dedupeKey。
    const third = await call(h, 'POST', '/tasks', {
      title: '拆单 C',
      sourceRef: { channel: 'feishu', messageId: 'shared-msg-1', dedupeKey: 'split-c' },
    });
    expect(third.status).toBe(200);

    //M 再次用相同显式 dedupeKey 入池仍正常命中原任务。
    const hitA = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'feishu', messageId: 'shared-msg-1', dedupeKey: 'split-a' },
      eventText: '补充 A 的进展',
    });
    expect(hitA.status).toBe(200);
    expect(hitA.body['deduplicated']).toBe(true);
    expect((hitA.body['task'] as types.ControlTask).id).toBe(firstId);

    //M 双方未同时显式写不同 dedupeKey 时，同 messageId 仍走退化合并并钉住原去重键。
    const fallbackFirst = await call(h, 'POST', '/tasks/upsert', {
      title: '无显式键',
      sourceRef: { channel: 'feishu', messageId: 'fallback-msg-1' },
    });
    expect(fallbackFirst.body['created']).toBe(true);
    const fallbackHit = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'feishu', relayId: 501, messageId: 'fallback-msg-1' },
      eventText: '补齐 relayId',
    });
    expect(fallbackHit.body['deduplicated']).toBe(true);
    const fallbackTask = fallbackHit.body['task'] as types.ControlTask;
    expect(fallbackTask.id).toBe((fallbackFirst.body['task'] as types.ControlTask).id);
    expect(fallbackTask.sourceRef?.relayId).toBe(501);
    expect(fallbackTask.sourceRef?.dedupeKey).toBe('msg:feishu:fallback-msg-1');
  });

  test('11. POST /tasks/upsert 携带 notifyHelper 与 broadcast 走通新建、去重命中与非法参数 400', async () => {
    const h = await createHarness(undefined, {
      broadcast_target: { channel: 'feishu', bot: 'BotWar', chat_id: 'oc_war_upsert' },
      helper_bots: { HanXin: 'BotHanXin' },
    });

    const delivered: routesModule.DecisionRelayRequest[] = [];
    events.onRequestEvent(h.ctx, 'work-decision/note', 'work-decision/note-result', (request) => {
      if (request.action === 'reply') return { ok: false };

      delivered.push(request);
      return { ok: true, id: 200 + delivered.length };
    });

    const sentReplies: channel.ChannelReplyRequest[] = [];
    h.ctx.on('channel/reply', (request) => {
      request.handled = true;
      sentReplies.push(request);
      channel.emitReplied(h.ctx, request, channel.getReceipt(request, 'sent', ''));
    });

    //M 新建入池同时携带 notifyHelper 与 broadcast。
    const created = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'feishu', bot: 'BotWar', relayId: 91 },
      eventText: '客户反馈登录超时',
      by: 'relay',
      notifyHelper: 'HanXin',
      broadcast: true,
    });
    expect(created.status).toBe(200);
    expect(created.body['created']).toBe(true);
    const createdNotice = created.body['notifications'] as types.ControlTaskNotifications;
    expect(createdNotice.wakeup).toEqual({
      ok: true,
      helper: 'HanXin',
      bot: 'BotHanXin',
      relayId: 201,
    });
    expect(createdNotice.broadcast).toEqual({
      ok: true,
      channel: 'feishu',
      bot: 'BotWar',
      chatId: 'oc_war_upsert',
      status: 'sent',
    });
    expect(delivered).toHaveLength(1);
    expect(sentReplies).toHaveLength(1);
    expect(sentReplies[0]?.parts[0]?.text).toContain('客户反馈登录超时');

    //M 去重命中同样携带 notifyHelper 与 broadcast，追加备注并投递通知。
    const hit = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'feishu', relayId: 91 },
      eventText: '客户再次催促处理',
      by: 'relay',
      notifyHelper: 'HanXin',
      broadcast: true,
    });
    expect(hit.status).toBe(200);
    expect(hit.body['deduplicated']).toBe(true);
    const hitNotice = hit.body['notifications'] as types.ControlTaskNotifications;
    expect(hitNotice.wakeup?.ok).toBe(true);
    expect(hitNotice.wakeup?.relayId).toBe(202);
    expect(hitNotice.broadcast?.ok).toBe(true);
    expect(delivered).toHaveLength(2);
    expect(sentReplies).toHaveLength(2);
    expect(sentReplies[1]?.parts[0]?.text).toContain('客户再次催促处理');

    //G 入口非法 notifyHelper / broadcast 回 400 且不新建任务。
    const badHelper = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'feishu', relayId: 92 },
      notifyHelper: '   ',
    });
    expect(badHelper.status).toBe(400);
    const badBroadcast = await call(h, 'POST', '/tasks/upsert', {
      sourceRef: { channel: 'feishu', relayId: 92 },
      broadcast: 'yes',
    });
    expect(badBroadcast.status).toBe(400);
    expect(await listIds(h, '?relayId=92')).toEqual([]);
  });
});
