/**
 * 多 AI 协同控制面任务面板（Control Plane Task Board）离线单元测试：
 * 覆盖 CRUD、磁盘持久化恢复、占坑互斥锁 409 防撞车、activeLocks 与 dispatchableIds 自动计算、
 * 变更时间线与 lastHeartbeatAt 自动刷新，以及前端零原生浏览器弹窗守卫。
 * 跑法：bun test src7/plugins/work-decision/ControlPlane.test.ts
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
import * as textModule from '../../utils/Text.ts';
import * as dbModule from '../db/index.ts';
import * as plugin from './index.ts';
import type * as types from './Types.ts';


const { afterEach, describe, expect, test } = bunTest;
const PREFIX = '/api/work-decision';
const DECISION_WEB_DIR = path.resolve(import.meta.dirname, '../../../web/src/DecisionMap');
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

async function createHarness(existingRoot?: string) {
  const root = existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jm-ctrl-plane-'));
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
  await ctx.plugin(plugin, {});
  await app.ready();
  return { root, app };
}


describe('Control Plane Task Board：状态流转、占坑锁 409 防冲突与可派发计算', () => {
  test('完整生命周期：创建、占坑锁 409 防撞车、dispatchableIds 优先级排序、释放锁后自动可派发、时间线心跳与持久化', async () => {
    const h = await createHarness();

    //M 1. 新建一条正在 running 的任务，占用 repo:AOBB 与 host:win
    const createRunning = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'task-aobb-vision',
        title: 'AOBB 纯本地 Rust 找图找色引擎',
        summary: '独立 vision-rs 零外部依赖找图找色 CLI',
        status: 'running',
        priority: 'P0',
        lockTags: ['repo:AOBB', 'host:win', 'repo:AOBB'],
        owner: 'coder-carbon',
        doneCriteria: 'cargo test 0 fail & release exe 编译通过',
        by: 'central',
      },
    });
    expect(createRunning.statusCode).toBe(200);
    const t1 = createRunning.json<{ task: types.ControlTask }>().task;
    expect(t1.lockTags).toEqual(['repo:AOBB', 'host:win']);
    expect(typeof t1.lastHeartbeatAt).toBe('number');
    expect(t1.events).toHaveLength(1);
    expect(t1.events[0]?.kind).toBe('created');

    //M 2. 新建三条任务：一条撞锁的 ready、两条不撞锁的 ready（P1 与 P0）、一条 pending_decision
    const rBlockedByLock = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'task-aobb-dock',
        title: 'AOBB 多开舱热覆盖打包',
        status: 'ready',
        priority: 'P0',
        lockTags: ['repo:AOBB'],
        doneCriteria: 'bun test 0 fail',
      },
    });
    expect(rBlockedByLock.statusCode).toBe(200);

    const rFreeP1 = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'task-jev-research',
        title: 'JEV Ultrafast 架构调研',
        status: 'ready',
        priority: 'P1',
        lockTags: ['topic:jev'],
        doneCriteria: '输出架构对比文档入知识库',
      },
    });
    expect(rFreeP1.statusCode).toBe(200);

    const rFreeP0 = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'task-shanghai-auth',
        title: '上海官网授权校验联调',
        status: 'ready',
        priority: 'P0',
        lockTags: ['repo:yucang-ai'],
        doneCriteria: '授权验签单测与冒烟 100% 全绿',
      },
    });
    expect(rFreeP0.statusCode).toBe(200);

    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'task-ins-dual',
        title: 'INS 双账号实测方案待定',
        status: 'pending_decision',
        priority: 'P1',
        lockTags: ['biz:ins'],
      },
    });

    //M 3. GET /tasks 验证 activeLocks 与 dispatchableIds（task-aobb-dock 因 repo:AOBB 被占不进 dispatchableIds；P0 排在 P1 前）
    const boardRes = await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` });
    expect(boardRes.statusCode).toBe(200);
    const board = boardRes.json<types.ControlTaskListResponse>();
    expect(board.counts).toEqual({
      pending_decision: 1,
      ready: 3,
      running: 1,
      blocked: 0,
      done: 0,
      cancelled: 0,
    });
    expect(board.activeLocks['repo:AOBB']).toEqual({
      taskId: 'task-aobb-vision',
      title: 'AOBB 纯本地 Rust 找图找色引擎',
      owner: 'coder-carbon',
    });
    expect(board.dispatchableIds).toEqual(['task-shanghai-auth', 'task-jev-research']);

    //M 4. 尝试把撞锁的 task-aobb-dock 切为 running → 必须返回 409 冲突！
    const conflictPatch = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/task-aobb-dock`,
      payload: { status: 'running', owner: 'coder-opus' },
    });
    expect(conflictPatch.statusCode).toBe(409);
    const conflictBody = conflictPatch.json<{ ok: boolean; error: string; conflicts: types.ControlTaskLockConflict[] }>();
    expect(conflictBody.ok).toBe(false);
    expect(conflictBody.conflicts[0]?.lockTag).toBe('repo:AOBB');
    expect(conflictBody.conflicts[0]?.taskId).toBe('task-aobb-vision');

    //M 直接 POST 创建撞锁 running 任务也返回 409
    const conflictCreate = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { title: '撞车任务', status: 'running', lockTags: ['host:win'] },
    });
    expect(conflictCreate.statusCode).toBe(409);

    //M 5. 追加老板原则更新与心跳事件，验证时间线追加与 lastHeartbeatAt 刷新
    const prevHb = t1.lastHeartbeatAt ?? 0;
    const evRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-aobb-vision/events`,
      payload: {
        kind: 'principle_update',
        by: 'boss',
        text: '严禁引入任何外部 crate，100% 纯 std + Win32 FFI 离线编译',
      },
    });
    expect(evRes.statusCode).toBe(200);
    const afterEvTask = evRes.json<{ task: types.ControlTask }>().task;
    expect(afterEvTask.events.at(-1)?.kind).toBe('principle_update');
    expect((afterEvTask.lastHeartbeatAt ?? 0) >= prevHb).toBe(true);

    //M 6. 原 running 任务完成（done），释放 repo:AOBB 锁 → task-aobb-dock 自动进入 dispatchableIds 且可顺利切为 running！
    const finishRes = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/task-aobb-vision`,
      payload: { status: 'done', by: 'coder-carbon', reason: '17 passed, 0 failed' },
    });
    expect(finishRes.statusCode).toBe(200);
    const finishBody = finishRes.json<{ activeLocks: Record<string, unknown>; dispatchableIds: string[] }>();
    expect(finishBody.activeLocks['repo:AOBB']).toBeUndefined();
    expect(finishBody.dispatchableIds).toContain('task-aobb-dock');

    const nowClaim = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/task-aobb-dock`,
      payload: { status: 'running', owner: 'coder-opus' },
    });
    expect(nowClaim.statusCode).toBe(200);

    //M 7. 按 ?status=running&lockTag=repo:AOBB 过滤，以及 /version 探针返回递增 tasksRev
    const filtered = (
      await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks?status=running&lockTag=repo:AOBB` })
    ).json<types.ControlTaskListResponse>();
    expect(filtered.tasks.map((item) => item.id)).toEqual(['task-aobb-dock']);

    const ver = (await h.app.inject({ method: 'GET', url: `${PREFIX}/version` })).json<{ tasksRev: number }>();
    expect(ver.tasksRev).toBeGreaterThan(0);

    //M 8. 磁盘持久化验证：用同一 root 重启新实例，任务数据原封不动恢复，DELETE 正常移除
    const diskFile = path.join(h.root, 'control-plane-tasks.json');
    expect(fs.existsSync(diskFile)).toBe(true);
    const h2 = await createHarness(h.root);
    const reloaded = (await h2.app.inject({ method: 'GET', url: `${PREFIX}/tasks` })).json<types.ControlTaskListResponse>();
    expect(reloaded.tasks).toHaveLength(5);

    const delRes = await h2.app.inject({ method: 'DELETE', url: `${PREFIX}/tasks/task-ins-dual` });
    expect(delRes.statusCode).toBe(200);
    const afterDel = (await h2.app.inject({ method: 'GET', url: `${PREFIX}/tasks` })).json<types.ControlTaskListResponse>();
    expect(afterDel.tasks).toHaveLength(4);
  });

  test('滴答原子扩展字段创建、入口校验、null 显式清空与默认 status=ready', async () => {
    const h = await createHarness();

    //M 1. 快速新建不传 status，默认 ready；传 status=done 按传入值保存
    const quickRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { title: '买咖啡豆' },
    });
    expect(quickRes.statusCode).toBe(200);
    const quickTask = quickRes.json<{ task: types.ControlTask }>().task;
    expect(quickTask.status).toBe('ready');
    expect(quickTask.priority).toBe('P1');

    const doneRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { title: '已完成记录', status: 'done', list: '收集箱' },
    });
    expect(doneRes.statusCode).toBe(200);
    const doneTask = doneRes.json<{ task: types.ControlTask }>().task;
    expect(doneTask.status).toBe('done');
    expect(doneTask.list).toBe('收集箱');

    //M 2. 创建带全部原子扩展字段的任务，tags / checkIns 自动去重清洗
    const fullRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'td-countdown-1',
        title: '结婚纪念日',
        kind: 'countdown',
        list: '个人备忘',
        parentId: quickTask.id,
        quadrant: 'q2',
        dueDate: '2026-12-31',
        countdownMode: 'down',
        icon: '🎂',
        tags: [' 家庭 ', '重要', '家庭', ''],
        checkIns: ['2026-11-21', '2026-11-21', ' 2026-11-22 '],
        sortOrder: 3,
      },
    });
    expect(fullRes.statusCode).toBe(200);
    const fullTask = fullRes.json<{ task: types.ControlTask }>().task;
    expect(fullTask.kind).toBe('countdown');
    expect(fullTask.list).toBe('个人备忘');
    expect(fullTask.parentId).toBe(quickTask.id);
    expect(fullTask.quadrant).toBe('q2');
    expect(fullTask.dueDate).toBe('2026-12-31');
    expect(fullTask.countdownMode).toBe('down');
    expect(fullTask.icon).toBe('🎂');
    expect(fullTask.tags).toEqual(['家庭', '重要']);
    expect(fullTask.checkIns).toEqual(['2026-11-21', '2026-11-22']);
    expect(fullTask.sortOrder).toBe(3);

    //G 3. 非法扩展字段必须在入口返回 400
    const badInputs: Array<Record<string, unknown>> = [
      { title: '坏日期', dueDate: '2026/12/31' },
      { title: '坏象限', quadrant: 'q9' },
      { title: '坏种类', kind: 'memo' },
      { title: '坏倒数', countdownMode: 'side' },
      { id: 'self-loop', title: '自指父任务', parentId: 'self-loop' },
      { title: '坏删除时间', trashedAt: -1 },
    ];
    for (const payload of badInputs) {
      const badRes = await h.app.inject({ method: 'POST', url: `${PREFIX}/tasks`, payload });
      expect(badRes.statusCode).toBe(400);
    }

    const selfPatch = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/td-countdown-1`,
      payload: { parentId: 'td-countdown-1' },
    });
    expect(selfPatch.statusCode).toBe(400);

    //M 4. PATCH 传 null 显式清空 parentId / quadrant / dueDate / trashedAt 并跨重启持久化
    const clearRes = await h.app.inject({
      method: 'PUT',
      url: `${PREFIX}/tasks/td-countdown-1`,
      payload: {
        parentId: null,
        quadrant: null,
        dueDate: null,
        trashedAt: null,
      },
    });
    expect(clearRes.statusCode).toBe(200);
    const cleared = clearRes.json<{ task: types.ControlTask }>().task;
    expect(cleared.parentId).toBeNull();
    expect(cleared.quadrant).toBeNull();
    expect(cleared.dueDate).toBeNull();
    expect(cleared.trashedAt).toBeNull();

    const h2 = await createHarness(h.root);
    const snap = (await h2.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    const reloaded = snap.tasks.find((item) => item.id === 'td-countdown-1');
    expect(reloaded?.parentId).toBeNull();
    expect(reloaded?.quadrant).toBeNull();
    expect(reloaded?.dueDate).toBeNull();
    expect(reloaded?.trashedAt).toBeNull();
  });

  test('清单 CRUD（默认 7 清单、同名幂等、改名同步任务 list、删 inbox 报 400、删清单任务回收集箱）', async () => {
    const h = await createHarness();

    //M 1. 默认 7 个清单随 GET /tasks 返回
    const initSnap = (await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(initSnap.lists.map((l) => l.id)).toEqual([
      'inbox',
      'work',
      'memo',
      'wish',
      'shopping',
      'study',
      'fitness',
    ]);
    expect(initSnap.lists[0]?.name).toBe('收集箱');

    //M 2. 创建自定义清单，再次同名创建幂等返回不重复
    const createListRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/lists`,
      payload: { id: 'travel', name: '旅行计划', icon: '✈️', color: '#38bdf8' },
    });
    expect(createListRes.statusCode).toBe(200);
    const createdBody = createListRes.json<{
      ok: true;
      revision: number;
      list: types.TaskListDef;
      lists: types.TaskListDef[];
    }>();
    expect(createdBody.list).toEqual({
      id: 'travel',
      name: '旅行计划',
      icon: '✈️',
      color: '#38bdf8',
      sortOrder: 7,
    });
    expect(createdBody.lists).toHaveLength(8);

    const dupListRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/lists`,
      payload: { name: '旅行计划' },
    });
    expect(dupListRes.statusCode).toBe(200);
    expect(dupListRes.json<{ lists: types.TaskListDef[]; revision: number }>().lists).toHaveLength(8);
    expect(dupListRes.json<{ revision: number }>().revision).toBe(createdBody.revision);

    //M 3. 在旅行计划与购物清单各建一条任务，改名旅行计划时仅同步其下任务
    const tTravelRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 't-travel-1', title: '订机票', list: '旅行计划' },
    });
    expect(tTravelRes.statusCode).toBe(200);
    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 't-shop-1', title: '买牛奶', list: '购物清单' },
    });

    const renameRes = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/lists/travel`,
      payload: { name: '2027 出行', icon: '🧳', sortOrder: 2 },
    });
    expect(renameRes.statusCode).toBe(200);
    const renamedBody = renameRes.json<{ list: types.TaskListDef; lists: types.TaskListDef[] }>();
    expect(renamedBody.list.name).toBe('2027 出行');
    expect(renamedBody.list.icon).toBe('🧳');

    const afterRename = (await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(afterRename.tasks.find((t) => t.id === 't-travel-1')?.list).toBe('2027 出行');
    expect(afterRename.tasks.find((t) => t.id === 't-shop-1')?.list).toBe('购物清单');

    //G 4. 禁止删除 inbox
    const delInboxRes = await h.app.inject({ method: 'DELETE', url: `${PREFIX}/lists/inbox` });
    expect(delInboxRes.statusCode).toBe(400);

    //M 5. 删除自定义清单后，旗下任务归回收集箱并持久化
    const delListRes = await h.app.inject({ method: 'DELETE', url: `${PREFIX}/lists/travel` });
    expect(delListRes.statusCode).toBe(200);
    expect(delListRes.json<{ lists: types.TaskListDef[] }>().lists).toHaveLength(7);

    const h2 = await createHarness(h.root);
    const afterDelSnap = (await h2.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(afterDelSnap.lists).toHaveLength(7);
    expect(afterDelSnap.tasks.find((t) => t.id === 't-travel-1')?.list).toBe('收集箱');
    expect(afterDelSnap.tasks.find((t) => t.id === 't-shop-1')?.list).toBe('购物清单');
  });

  test('习惯打卡 toggle（指定日期排序、重复移除、缺省默认当天本地日期、非法日期 400）', async () => {
    const h = await createHarness();
    const createHabit = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 'habit-water', title: '每天喝水 2L', kind: 'habit', list: '锻炼计划' },
    });
    expect(createHabit.statusCode).toBe(200);

    const c1 = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/habit-water/checkin`,
      payload: { date: '2026-11-23' },
    });
    expect(c1.statusCode).toBe(200);
    expect(c1.json<{ task: types.ControlTask }>().task.checkIns).toEqual(['2026-11-23']);

    //M 加入更早日期时保持升序排序
    const c2 = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/habit-water/checkin`,
      payload: { date: '2026-11-20' },
    });
    expect(c2.statusCode).toBe(200);
    expect(c2.json<{ task: types.ControlTask }>().task.checkIns).toEqual([
      '2026-11-20',
      '2026-11-23',
    ]);

    //M 再次打卡同一天会移除该日期
    const c3 = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/habit-water/checkin`,
      payload: { date: '2026-11-23' },
    });
    expect(c3.statusCode).toBe(200);
    expect(c3.json<{ task: types.ControlTask }>().task.checkIns).toEqual(['2026-11-20']);

    //M 不传 date 默认切换当天本地 YYYY-MM-DD
    const todayLocal = textModule.formatLocalTime(Date.now(), 'date').slice(0, 10);
    const cTodayAdd = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/habit-water/checkin`,
      payload: {},
    });
    expect(cTodayAdd.statusCode).toBe(200);
    expect(cTodayAdd.json<{ task: types.ControlTask }>().task.checkIns).toContain(todayLocal);

    const cTodayRemove = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/habit-water/checkin`,
    });
    expect(cTodayRemove.statusCode).toBe(200);
    expect(cTodayRemove.json<{ task: types.ControlTask }>().task.checkIns).not.toContain(todayLocal);

    const badDate = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/habit-water/checkin`,
      payload: { date: '20261123' },
    });
    expect(badDate.statusCode).toBe(400);
  });

  test('垃圾桶软删除释放 409 占坑互斥锁，还原时若坑位已被占仍回 409', async () => {
    const h = await createHarness();

    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'trash-t1',
        title: '占用任务 A',
        status: 'running',
        lockTags: ['repo:trash-lock'],
        owner: 'coder-a',
      },
    });
    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'trash-t2',
        title: '等待任务 B',
        status: 'ready',
        lockTags: ['repo:trash-lock'],
      },
    });

    //M 1. 未进垃圾桶时任务 B 抢锁返回 409
    const blockedRes = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/trash-t2`,
      payload: { status: 'running', owner: 'coder-b' },
    });
    expect(blockedRes.statusCode).toBe(409);

    //M 2. 软删除 running 中的任务 A 后，activeLocks 清空、counts.running 归零、任务 B 自动可派发
    const trashRes = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/trash-t1`,
      payload: { trashedAt: Date.now() },
    });
    expect(trashRes.statusCode).toBe(200);
    const trashBody = trashRes.json<{
      task: types.ControlTask;
      activeLocks: Record<string, unknown>;
      dispatchableIds: string[];
    }>();
    expect(typeof trashBody.task.trashedAt).toBe('number');
    expect(trashBody.activeLocks['repo:trash-lock']).toBeUndefined();
    expect(trashBody.dispatchableIds).toContain('trash-t2');

    const snapWhileTrashed = (await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(snapWhileTrashed.counts.running).toBe(0);
    expect(snapWhileTrashed.tasks.some((t) => t.id === 'trash-t1')).toBe(true);

    //M 3. 任务 B 顺利占锁进入 running；此时还原任务 A 因仍为 running 且撞锁被 409 拦截
    const claimB = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/trash-t2`,
      payload: { status: 'running', owner: 'coder-b' },
    });
    expect(claimB.statusCode).toBe(200);

    const restoreConflict = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/trash-t1`,
      payload: { trashedAt: null },
    });
    expect(restoreConflict.statusCode).toBe(409);

    //M 4. 任务 B 完成后，任务 A 传 trashedAt: null 顺利还原并重新持锁
    await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/trash-t2`,
      payload: { status: 'done' },
    });
    const restoreOk = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/tasks/trash-t1`,
      payload: { trashedAt: null },
    });
    expect(restoreOk.statusCode).toBe(200);
    const restoredBody = restoreOk.json<{
      task: types.ControlTask;
      activeLocks: Record<string, types.ActiveLockHolder>;
    }>();
    expect(restoredBody.task.trashedAt).toBeNull();
    expect(restoredBody.activeLocks['repo:trash-lock']?.taskId).toBe('trash-t1');
  });

  test('老版本 control-plane-tasks.json（无 lists 与新字段）向后兼容并首次写盘补全 lists', async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-ctrl-legacy-'));
    cleanups.push(() => fs.rmSync(legacyRoot, { recursive: true, force: true }));

    const legacyTask: types.ControlTask = {
      id: 'legacy-ai-01',
      title: '老控制面任务',
      summary: '不带任何滴答新字段',
      status: 'running',
      priority: 'P0',
      lockTags: ['repo:legacy'],
      owner: 'central',
      doneCriteria: '0 fail',
      lastHeartbeatAt: 1760000000000,
      events: [{ at: 1760000000000, by: 'central', kind: 'created', text: '旧记录' }],
      createdAt: 1760000000000,
      updatedAt: 1760000000000,
    };
    const diskPath = path.join(legacyRoot, 'control-plane-tasks.json');
    fs.writeFileSync(
      diskPath,
      `${JSON.stringify({ version: 1, revision: 12, tasks: [legacyTask] }, null, 2)}\n`,
      'utf8',
    );

    const h = await createHarness(legacyRoot);
    const snap = (await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(snap.revision).toBe(12);
    expect(snap.lists).toHaveLength(7);
    expect(snap.tasks).toEqual([legacyTask]);
    expect(snap.activeLocks['repo:legacy']?.taskId).toBe('legacy-ai-01');

    //M 触发一次写盘后，磁盘文件应保留老任务且一并持久化 lists
    const addNew = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { title: '新增伴随任务' },
    });
    expect(addNew.statusCode).toBe(200);
    const savedRaw = JSON.parse(fs.readFileSync(diskPath, 'utf8')) as types.ControlPlaneFile;
    expect(savedRaw.lists).toHaveLength(7);
    expect(savedRaw.tasks.find((t) => t.id === 'legacy-ai-01')).toEqual(legacyTask);
  });

  test('前端 DecisionMap 目录零原生 window.alert / prompt / confirm 守卫', () => {
    const files = fs.readdirSync(DECISION_WEB_DIR).filter((name) => /\.(ts|tsx)$/u.test(name));
    expect(files.length).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const file of files) {
      const raw = fs.readFileSync(path.join(DECISION_WEB_DIR, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/(^|[^:])\/\/.*$/gmu, '$1');
      if (/\bwindow\.(alert|prompt|confirm)\s*\(/u.test(raw)) {
        bad.push(file);
      }
    }
    expect(bad).toEqual([]);
  });
});
