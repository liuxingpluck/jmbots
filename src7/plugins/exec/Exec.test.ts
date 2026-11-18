/**
 * exec v1.1.0（含并入的 Runs 命令窗口）离线单元测试：
 *   1. `/api/run`、`/api/runs/:id?wait=`、`/api/runs/:id/log`、`/api/runs`、`/api/runs/:id/stop` 协议与 `isProjectCheck` 放行；
 *   2. 非白名单命令按 `ask_user` 走拒绝或 pending + stop；
 *   3. `Exec.run` 执行短命令与 `report` 格式化、`readRunsEnabled` 开关校验。
 * 跑法：bun test ./src7/plugins/exec
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as os from 'node:os';
import * as cordis from 'cordis';
import fastify, { type FastifyInstance } from 'fastify';
import { isProjectCheck } from '../approval/Rules.ts';
import * as execPlugin from './index.ts';


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 构建挂好 runs 表、审批假实现与 Fastify 的测试环境。 */
async function runsWorld(onRun: (command: string) => Promise<{ code: number; output: string }>): Promise<{
  app: FastifyInstance;
  db: Database;
  decidedCalls: { id: number; approve: boolean; by: string }[];
}> {
  const db = new Database(':memory:');
  const app = fastify();
  const decidedCalls: { id: number; approve: boolean; by: string }[] = [];
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
  closers.push(() => app.close());
  closers.push(() => db.close());

  const fakeCtx = {
    resources: { db, root: os.tmpdir(), raw: {} },
    approval: {
      review: async (input: { command: string; ask?: boolean }) => {
        if (isProjectCheck(input.command)) {
          return { result: 'pass', by: 'rule', reason: '项目检查命令直接放行' };
        }
        if (input.ask === true) {
          return { result: 'asked', id: 77, reason: '等待用户确认' };
        }
        return { result: 'reject', by: 'rule', reason: '需要审批且未设置 ask_user' };
      },
      decide: (id: number, approve: boolean, by: string) => {
        decidedCalls.push({ id, approve, by });
        return undefined;
      },
    },
    on: (name: string, fn: (...args: unknown[]) => unknown) => {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
    },
  } as unknown as cordis.Context;

  const runs = new execPlugin.Runs(fakeCtx, {
    run: async (input) => {
      const done = await onRun(input.command);
      input.onOutput?.(done.output);
      return { code: done.code, timedOut: false, stopped: false, output: done.output, ms: 12 };
    },
  });
  execPlugin.mountRunsRoutes(app, runs);
  return { app, db, decidedCalls };
}


describe('exec 与 Runs 命令窗口合并回归', () => {
  test('POST /api/run 白名单放行、GET /api/runs/:id?wait= 取尾、/log 取全文、/api/runs 不带 output', async () => {
    const { app } = await runsWorld(async () => ({ code: 0, output: 'check ok\nline2\n' }));
    const createdRes = await app.inject({
      method: 'POST',
      url: '/api/run',
      payload: { command: 'bun run typecheck:src7', why: '测试白名单', from: 'test' },
    });
    expect(createdRes.statusCode).toBe(200);
    const created = createdRes.json<execPlugin.RunRecord>();
    expect(created.status).toBe('running');
    expect(created.review.by).toBe('rule');

    const waitedRes = await app.inject({ method: 'GET', url: `/api/runs/${created.id}?wait=5` });
    expect(waitedRes.statusCode).toBe(200);
    const waited = waitedRes.json<execPlugin.RunRecord & { tail: string; output?: string }>();
    expect(waited.status).toBe('done');
    expect(waited.code).toBe(0);
    expect(waited.tail).toContain('check ok');
    expect(waited.output).toBeUndefined();

    const logRes = await app.inject({ method: 'GET', url: `/api/runs/${created.id}/log` });
    expect(logRes.statusCode).toBe(200);
    expect(logRes.headers['content-type']).toContain('text/plain');
    expect(logRes.body).toBe('check ok\nline2\n');

    const listRes = await app.inject({ method: 'GET', url: '/api/runs?limit=5' });
    expect(listRes.statusCode).toBe(200);
    const items = listRes.json<(execPlugin.RunRecord & { output?: string })[]>();
    expect(items).toHaveLength(1);
    expect(items[0]?.output).toBeUndefined();
  });

  test('非白名单按 ask_user 拒绝或待确认，stop 会撤销待确认并标 stopped', async () => {
    const { app, decidedCalls } = await runsWorld(async () => ({ code: 0, output: '' }));

    const rejRes = await app.inject({ method: 'POST', url: '/api/run', payload: { command: 'echo hi' } });
    expect(rejRes.statusCode).toBe(200);
    expect(rejRes.json<execPlugin.RunRecord>().status).toBe('rejected');

    const askRes = await app.inject({ method: 'POST', url: '/api/run', payload: { command: 'echo hi', ask_user: true } });
    expect(askRes.statusCode).toBe(200);
    const pending = askRes.json<execPlugin.RunRecord>();
    expect(pending.status).toBe('pending');
    expect(pending.approvalId).toBe(77);

    const stopRes = await app.inject({ method: 'POST', url: `/api/runs/${pending.id}/stop` });
    expect(stopRes.statusCode).toBe(200);
    expect(stopRes.json<execPlugin.RunRecord>().status).toBe('stopped');
    expect(decidedCalls).toEqual([{ id: 77, approve: false, by: '命令窗口：发命令的停下了' }]);
  });

  test('Exec.run、report 与 readRunsEnabled 正常且无 http 也能挂 exec', async () => {
    expect(execPlugin.readRunsEnabled(undefined)).toBe(true);
    expect(execPlugin.readRunsEnabled(false)).toBe(false);
    expect(() => execPlugin.readRunsEnabled('bad')).toThrow();

    const db = new Database(':memory:');
    closers.push(() => db.close());
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());

    class FakeResources extends cordis.Service {
      readonly db = db;
      readonly root = os.tmpdir();
      readonly raw = {};
      constructor(c: cordis.Context) { super(c, 'resources'); }
    }
    class FakeTools extends cordis.Service {
      register(): void {}
      constructor(c: cordis.Context) { super(c, 'tools'); }
    }
    class FakeBots extends cordis.Service {
      get(): undefined { return undefined; }
      constructor(c: cordis.Context) { super(c, 'bots'); }
    }
    class FakeSessions extends cordis.Service {
      constructor(c: cordis.Context) { super(c, 'sessions'); }
    }
    class FakeApproval extends cordis.Service {
      constructor(c: cordis.Context) { super(c, 'approval'); }
    }

    await ctx.plugin(FakeResources);
    await ctx.plugin(FakeTools);
    await ctx.plugin(FakeBots);
    await ctx.plugin(FakeSessions);
    await ctx.plugin(FakeApproval);
    await ctx.plugin(execPlugin);

    const result = await ctx.exec.run({ command: 'echo exec-ok', cwd: os.tmpdir(), timeoutMs: 5000 });
    expect(result.code).toBe(0);
    expect(result.output).toContain('exec-ok');
    expect(execPlugin.report(result)).toContain('退出码 0');
  });
});
