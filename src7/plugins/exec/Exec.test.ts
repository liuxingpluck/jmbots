/**
 * exec（含并入的 Runs 命令窗口）离线单元测试：
 *   1. `/api/run`、`/api/runs/:id?wait=`、`/api/runs/:id/log`、`/api/runs`、`/api/runs/:id/stop` 协议与 `isProjectCheck` 放行；
 *   2. 非白名单命令按 `ask_user` 走拒绝或 pending + stop（stop 经 approval/request 的 decide 作废待确认）；
 *   3. 没挂 approval：审核请求没人答，命令一律拒绝；
 *   4. `Exec.run` 执行短命令与 `report` 格式化、`readRunsEnabled` 开关校验，没挂 approval 也能挂 exec。
 * 审核走事件 approval/request：这里挂一个假的听方，不挂真的 approval。
 * 跑法：bun test ./src7/plugins/exec
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as os from 'node:os';
import * as cordis from 'cordis';
import fastify, { type FastifyInstance } from 'fastify';
import * as requestEvents from '../../utils/RequestEvent.ts';
import { isProjectCheck } from '../approval/Rules.ts';
import * as execPlugin from './index.ts';


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假审核的回执正文。 */
type ApprovalAnswer = requestEvents.StripResultId<requestEvents.EventArg<'approval/result'>>;

/** 假审核收到的请求。 */
type ApprovalAsk = requestEvents.EventArg<'approval/request'>;


/**
 * 构建挂好 runs 表、假审核与 Fastify 的测试环境。
 * @param onRun 假 exec.run：拿命令交回退出码和输出。
 * @param withApproval 挂不挂假审核（听 approval/request）；false 时审核请求没人答。
 */
async function runsWorld(
  onRun: (command: string) => Promise<{ code: number; output: string }>,
  withApproval = true,
): Promise<{
  app: FastifyInstance;
  db: Database;
  decidedCalls: { id: number; approve: boolean; by: string }[];
}> {
  const db = new Database(':memory:');
  const app = fastify();
  const decidedCalls: { id: number; approve: boolean; by: string }[] = [];
  const ctx = new cordis.Context();
  closers.push(() => app.close());
  closers.push(() => db.close());
  closers.push(() => ctx.fiber.dispose());

  class FakeResources extends cordis.Service {
    readonly db = db;
    readonly root = os.tmpdir();
    readonly raw = {};
    constructor(c: cordis.Context) { super(c, 'resources'); }
  }
  await ctx.plugin(FakeResources);

  //M 假审核：项目检查放行、写了 ask_user 的去问（号 77）、别的拒绝；decide 记下来。写明返回类型，verdict 里才是字面量。
  const answer = (request: ApprovalAsk): ApprovalAnswer => {
    if (request.action === 'decide') {
      decidedCalls.push({ id: request.id, approve: request.approve, by: request.by });
      return {};
    }
    if (request.action !== 'review') return {};

    if (isProjectCheck(request.input.command)) return { verdict: { result: 'pass', by: 'rule', reason: '项目检查命令直接放行' } };

    if (request.input.ask === true) return { verdict: { result: 'asked', id: 77, reason: '等待用户确认' } };

    return { verdict: { result: 'reject', by: 'rule', reason: '需要审批且未设置 ask_user' } };
  };
  if (withApproval) {
    requestEvents.onRequestEvent(ctx, 'approval/request', 'approval/result', answer);
  }

  const runs = new execPlugin.Runs(ctx, {
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

    //M 作废待确认是发完就走的事件：等一拍让 serial 跑到假审核。
    await Bun.sleep(10);
    expect(decidedCalls).toEqual([{ id: 77, approve: false, by: '命令窗口：发命令的停下了' }]);
  });

  test('没挂 approval：审核请求没人答，项目检查、写了 ask_user 的也一律拒绝，不跑命令', async () => {
    let ran = 0;
    const { app } = await runsWorld(async () => {
      ran += 1;
      return { code: 0, output: '' };
    }, false);

    for (const payload of [{ command: 'bun run typecheck:src7' }, { command: 'echo hi', ask_user: true }]) {
      const res = await app.inject({ method: 'POST', url: '/api/run', payload });
      expect(res.statusCode).toBe(200);
      const record = res.json<execPlugin.RunRecord>();
      expect(record.status).toBe('rejected');
      expect(record.review.by).toBe('rule');
      expect(record.review.reason).toContain('审核未就绪或超时');
    }
    expect(ran).toBe(0);
  });

  test('Exec.run、report 与 readRunsEnabled 正常且无 http、无 approval 也能挂 exec', async () => {
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

    //M 不挂 approval：exec 不再硬等它，照样开工。
    await ctx.plugin(FakeResources);
    await ctx.plugin(FakeTools);
    await ctx.plugin(FakeBots);
    await ctx.plugin(FakeSessions);
    await ctx.plugin(execPlugin);

    const result = await ctx.exec.run({ command: 'echo exec-ok', cwd: os.tmpdir(), timeoutMs: 5000 });
    expect(result.code).toBe(0);
    expect(result.output).toContain('exec-ok');
    expect(execPlugin.report(result)).toContain('退出码 0');
  });
});
