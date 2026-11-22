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
