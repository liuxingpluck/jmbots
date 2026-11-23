/**
 * exec 插件（Exec 执行器与 Runs 命令窗口）防回归与安全边界离线单元测试：
 *   1. Exec.run 边界：不存在 cwd、预中止 signal、超时强杀进程树、运行中中止、PATH/环境变量注入；
 *   2. report() 输出格式化：退出码/超时/被停/错误/空输出/CRLF 归一/超长尾截断；
 *   3. Exec.onTool 权限隔离：外人（非本人）必须写入 confined 工作区约束，本人不设 confined；reject/asked/pass 全分支；
 *   4. Exec.onDecided 异步续跑：approved 执行并入队、rejected 拒绝不执行、ended 卡片与非 exec 类型静默忽略；
 *   5. Runs 持久化与健壮性：重启恢复清理残留 running/无审批 pending、保留等用户项、入参边界校验、UTF-8 尾部安全截断、apply 校验。
 * 全程隔离临时目录与内存 SQLite，零外网依赖，双平台确定通过。
 * 跑法：bun test ./src7/tests/Audit_Exec.test.ts --timeout 60000
 */
import * as bunTest from 'bun:test';
import * as sqlite from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import type * as piAi from '@earendil-works/pi-ai';
import type { Session } from '../Sessions.ts';
import * as toolsModule from '../Tools.ts';
import * as requestEvents from '../utils/RequestEvent.ts';
import * as execPlugin from '../plugins/exec/index.ts';
import * as runsModule from '../plugins/exec/Runs.ts';
import * as httpPlugin from '../plugins/http/index.ts';


/** 审核请求与回执类型别名。 */
type ApprovalAsk = requestEvents.EventArg<'approval/request'>;
type ApprovalReply = requestEvents.StripResultId<requestEvents.EventArg<'approval/result'>>;

/** 每个用例结束后按逆序清理的资源队列。 */
const closers: Array<() => Promise<unknown> | void> = [];

bunTest.afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 构造跨平台安全的 Bun 单行脚本命令。 */
function bunEvalCommand(code: string): string {
  return `"${process.execPath}" -e "${code}"`;
}


/** 创建隔离的临时运行时目录并登记自动清理。 */
function makeTempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  closers.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}


/** 假资源服务配置。 */
interface FakeResourcesOptions {
  /** 隔离临时根目录。 */
  root: string;
  /** 内存 SQLite 实例。 */
  db: sqlite.Database;
  /** 顶层原始配置。 */
  raw: Record<string, unknown>;
}

/** 假资源服务，持有内存 SQLite 与隔离临时目录。 */
class FakeResources extends cordis.Service {
  readonly root: string;
  readonly db: sqlite.Database;
  readonly raw: Record<string, unknown>;

  constructor(ctx: cordis.Context, options: FakeResourcesOptions) {
    super(ctx, 'resources');
    this.root = options.root;
    this.db = options.db;
    this.raw = options.raw;
  }
}


/** 假会话服务，记录 onDecided 入队消息与触发次数。 */
class FakeSessions extends cordis.Service {
  readonly queued: Array<{ sessionId: string; text: string }> = [];
  readonly runs: string[] = [];

  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
  }

  open(id: string): Session {
    const queued = this.queued;
    const runs = this.runs;
    const fake = {
      id,
      row: { id, kind: 'work', bot: '测试机', state: 'idle', reply: '', messages: [] },
      queueUserMessage: (text: string): void => {
        queued.push({ sessionId: id, text });
      },
      run: (): Promise<void> => {
        runs.push(id);
        return Promise.resolve();
      },
    };
    return fake as unknown as Session;
  }
}


/**
 * 构建完整挂载 tools + sessions + exec 的测试世界。
 * @param rawResources 顶层 raw 配置（含 bots/paths）。
 * @param pluginConfig 传给 exec.apply 的插件配置。
 */
async function setupExecWorld(
  rawResources?: Record<string, unknown>,
  pluginConfig?: Record<string, unknown>,
): Promise<{
  ctx: cordis.Context;
  root: string;
  workspace: string;
  db: sqlite.Database;
  sessions: FakeSessions;
}> {
  const root = makeTempRoot('audit-exec-');
  const workspace = path.join(root, 'bots', '测试机', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const db = new sqlite.Database(':memory:');
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  closers.push(() => db.close());

  const raw = rawResources ?? { bots: [{ name: '测试机' }] };
  await ctx.plugin(FakeResources, { root, db, raw });
  await ctx.plugin(toolsModule.Tools);
  const sessions = new FakeSessions(ctx);
  await ctx.plugin(execPlugin, pluginConfig);
  return { ctx, root, workspace, db, sessions };
}


/** 构造工作会话替身对象，供 exec 工具调用使用。 */
function makeWorkSession(channel: string, address?: Record<string, unknown>): Session {
  const row = {
    id: 's_exec_work',
    kind: 'work',
    bot: '测试机',
    channel,
    address,
    model: 'fake/m',
    state: 'running',
    reply: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { id: row.id, row } as unknown as Session;
}


/** 构造最小合法 approval/decided 待确认载荷。 */
function makeDecidedPending(overrides: Record<string, unknown>): runsModule.Pending {
  const base = {
    id: 101,
    kind: 'exec',
    session: 's_exec_work',
    state: 'approved',
    by: '审计员',
    payload: { command: '', cwd: '', timeoutMs: 5000 },
    card: { state: 'approved', title: '执行命令', fields: [], buttons: [] },
  };
  return { ...base, ...overrides } as unknown as runsModule.Pending;
}


bunTest.describe('Audit_Exec：命令执行器与命令窗口防回归', () => {
  bunTest.test('1. Exec.run 入口守卫：目录不存在直接报 error，预中止 signal 立即返回 stopped', async () => {
    const { ctx, root } = await setupExecWorld();
    const missingDir = path.join(root, 'does-not-exist');
    const missing = await ctx.exec.run({ command: 'echo hi', cwd: missingDir, timeoutMs: 3000 });
    bunTest.expect(missing.code).toBeNull();
    bunTest.expect(missing.error).toContain('目录不存在');
    bunTest.expect(missing.stopped).toBe(false);

    const controller = new AbortController();
    controller.abort();
    const aborted = await ctx.exec.run({
      command: 'echo should-not-run',
      cwd: root,
      timeoutMs: 3000,
      signal: controller.signal,
    });
    bunTest.expect(aborted.stopped).toBe(true);
    bunTest.expect(aborted.code).toBeNull();
    bunTest.expect(aborted.output).toBe('');
  });

  bunTest.test('2. Exec.run 真实超时会强杀子进程并标记 timedOut=true，report() 准确输出状态头', async () => {
    const { ctx, workspace } = await setupExecWorld();
    const cmd = bunEvalCommand('setTimeout(() => {}, 10000)');
    const result = await ctx.exec.run({ command: cmd, cwd: workspace, timeoutMs: 250 });

    bunTest.expect(result.timedOut).toBe(true);
    bunTest.expect(result.stopped).toBe(false);
    const formatted = execPlugin.report(result);
    bunTest.expect(formatted).toContain('超时，已结束');
    bunTest.expect(formatted).toContain('（没有输出）');
  });

  bunTest.test('3. Exec.run 运行中收到 AbortSignal 立即停止子进程并标记 stopped=true', async () => {
    const { ctx, workspace } = await setupExecWorld();
    const controller = new AbortController();
    const cmd = bunEvalCommand('console.log(123); setTimeout(() => {}, 10000)');
    const timer = setTimeout(() => {
      controller.abort();
    }, 200);
    const result = await ctx.exec.run({
      command: cmd,
      cwd: workspace,
      timeoutMs: 8000,
      signal: controller.signal,
    });
    clearTimeout(timer);

    bunTest.expect(result.stopped).toBe(true);
    bunTest.expect(result.timedOut).toBe(false);
  });

  bunTest.test('4. Exec.run 注入 JMBOTS_* 环境变量，并将 runtimes/program 的 bin 目录按顺序前置到 PATH', async () => {
    const root = makeTempRoot('audit-exec-env-');
    const workspace = path.join(root, 'bots', '测试机', 'workspace');
    const alphaBin = path.join(root, 'runtimes', 'alpha', 'bin');
    const betaDir = path.join(root, 'program', 'beta');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(alphaBin, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });

    const db = new sqlite.Database(':memory:');
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    closers.push(() => db.close());

    await ctx.plugin(FakeResources, { root, db, raw: { bots: [{ name: '测试机' }] } });
    await ctx.plugin(toolsModule.Tools);
    new FakeSessions(ctx);
    await ctx.plugin(execPlugin, { runs: false });

    const script = 'console.log(JSON.stringify({'
      + 's:process.env.JMBOTS_SESSION_ID,'
      + 'r:process.env.JMBOTS_RUNTIMES,'
      + 'p:process.env.JMBOTS_PROGRAM,'
      + 'path:process.env.PATH||process.env.Path}))';
    const result = await ctx.exec.run({
      command: bunEvalCommand(script),
      cwd: workspace,
      timeoutMs: 5000,
      session: 'sess-env-99',
    });

    bunTest.expect(result.code).toBe(0);
    const parsed = JSON.parse(result.output.trim()) as { s: string; r: string; p: string; path: string };
    bunTest.expect(parsed.s).toBe('sess-env-99');
    bunTest.expect(parsed.r).toBe(path.join(root, 'runtimes'));
    bunTest.expect(parsed.p).toBe(path.join(root, 'program'));
    bunTest.expect(parsed.path.startsWith(`${alphaBin}${path.delimiter}${betaDir}`)).toBe(true);
  });

  bunTest.test('5. report() 规范化 CRLF、处理错误/非零退出码并对超长输出只保留末尾片段', () => {
    const normal = execPlugin.report({
      code: 2,
      timedOut: false,
      stopped: true,
      error: '异常退出',
      output: 'lineA\r\nlineB\r\n',
      ms: 1500,
    });
    bunTest.expect(normal).toContain('退出码 2（被停下了），用时 1.5 秒，出错：异常退出');
    bunTest.expect(normal).toContain('lineA\nlineB');
    bunTest.expect(normal).not.toContain('\r');

    const manyLines = Array.from({ length: 2500 }, (_unused, idx) => `L${String(idx + 1)}`).join('\n');
    const clipped = execPlugin.report({
      code: 0,
      timedOut: false,
      stopped: false,
      output: manyLines,
      ms: 200,
    });
    bunTest.expect(clipped).toContain('输出太长，只留最后');
    bunTest.expect(clipped).toContain('L2500');
    bunTest.expect(clipped).not.toContain('\nL1\n');
  });

  bunTest.test('6. exec 工具权限边界：外人（builder）自动附加 confined 目录约束，本人不附加 confined', async () => {
    const { ctx, root } = await setupExecWorld();
    const builderDir = path.join(root, 'builder-ws');
    fs.mkdirSync(builderDir, { recursive: true });
    const captured: Array<{ confined?: string; cwd: string }> = [];

    requestEvents.onRequestEvent(ctx, 'approval/request', 'approval/result', (req: ApprovalAsk): ApprovalReply => {
      if (req.action !== 'review') return {};

      captured.push({ confined: req.input.confined, cwd: req.input.cwd });
      return { verdict: { result: 'reject', by: 'rule', reason: '仅验证入参' } };
    });

    const call: piAi.ToolCall = {
      type: 'toolCall',
      id: 'call_conf_1',
      name: 'exec',
      arguments: { command: 'echo test' },
    };
    const guestSession = makeWorkSession('feishu', { role: 'builder', owner: false, workspace: builderDir });
    const ownerSession = makeWorkSession('cli', { customer: 'cli:本机' });
    const signal = new AbortController().signal;

    const r1 = await ctx.tools.execute(call, guestSession, signal);
    const r2 = await ctx.tools.execute(call, ownerSession, signal);
    bunTest.expect(r1.text).toContain('未执行：仅验证入参');
    bunTest.expect(r2.text).toContain('未执行：仅验证入参');
    bunTest.expect(captured[0]?.confined).toBe(builderDir);
    bunTest.expect(captured[1]?.confined).toBeUndefined();
  });

  bunTest.test('7. exec 工具全分支裁决：asked 返回待确认提示不执行，pass 真实执行并交回报告', async () => {
    const { ctx } = await setupExecWorld();
    let mode: 'asked' | 'pass' = 'asked';

    requestEvents.onRequestEvent(ctx, 'approval/request', 'approval/result', (req: ApprovalAsk): ApprovalReply => {
      if (req.action !== 'review') return {};
      if (mode === 'asked') return { verdict: { result: 'asked', id: 88, reason: '需要确认' } };

      return { verdict: { result: 'pass', by: 'rule', reason: '测试放行' } };
    });

    const session = makeWorkSession('cli', { customer: 'cli:本机' });
    const signal = new AbortController().signal;
    const call: piAi.ToolCall = {
      type: 'toolCall',
      id: 'call_verdict',
      name: 'exec',
      arguments: { command: bunEvalCommand('console.log(42)') },
    };

    const asked = await ctx.tools.execute(call, session, signal);
    bunTest.expect(asked.isError).toBe(false);
    bunTest.expect(asked.text).toContain('待确认 #88');

    mode = 'pass';
    const passed = await ctx.tools.execute(call, session, signal);
    bunTest.expect(passed.isError).toBe(false);
    bunTest.expect(passed.text).toContain('退出码 0');
    bunTest.expect(passed.text).toContain('42');
  });

  bunTest.test('8. approval/decided：同意后执行命令并回灌会话，拒绝与 ended 卡片均不执行命令', async () => {
    const { ctx, workspace, sessions } = await setupExecWorld();
    const markerFile = path.join(workspace, 'approved-marker.txt');
    const writeCmd = bunEvalCommand(
      `require('node:fs').writeFileSync(${JSON.stringify(markerFile).replaceAll('"', "'")}, 'ok')`,
    );

    //G 已作废卡片与非 exec 类型必须被静默忽略。
    ctx.emit('approval/decided', makeDecidedPending({
      id: 1,
      kind: 'other',
      payload: { command: writeCmd, cwd: workspace, timeoutMs: 5000 },
    }));
    ctx.emit('approval/decided', makeDecidedPending({
      id: 2,
      card: { state: 'ended', title: '作废', fields: [], buttons: [] },
      payload: { command: writeCmd, cwd: workspace, timeoutMs: 5000 },
    }));
    await Bun.sleep(40);
    bunTest.expect(fs.existsSync(markerFile)).toBe(false);
    bunTest.expect(sessions.queued).toHaveLength(0);

    //M 拒绝分支仅入队拒绝说明，不执行命令。
    ctx.emit('approval/decided', makeDecidedPending({
      id: 3,
      state: 'rejected',
      payload: { command: writeCmd, cwd: workspace, timeoutMs: 5000 },
    }));
    await Bun.sleep(40);
    bunTest.expect(fs.existsSync(markerFile)).toBe(false);
    bunTest.expect(sessions.queued[0]?.text).toContain('用户拒绝了');

    //M 同意分支执行命令并把退出码与结果推进会话。
    ctx.emit('approval/decided', makeDecidedPending({
      id: 4,
      state: 'approved',
      payload: { command: writeCmd, cwd: workspace, timeoutMs: 5000 },
    }));
    for (let i = 0; i < 60; i += 1) {
      if (sessions.queued.length >= 2) {
        break;
      }
      await Bun.sleep(50);
    }
    bunTest.expect(fs.existsSync(markerFile)).toBe(true);
    bunTest.expect(sessions.queued[1]?.text).toContain('用户同意了');
    bunTest.expect(sessions.queued[1]?.text).toContain('退出码 0');
  });

  bunTest.test('9. Runs 重启恢复：仅将残留 running 与无审批 pending 标为 failed，保留等待用户审批项', async () => {
    const db = new sqlite.Database(':memory:');
    const ctx = new cordis.Context();
    const root = makeTempRoot('audit-runs-recover-');
    closers.push(() => ctx.fiber.dispose());
    closers.push(() => db.close());

    await ctx.plugin(FakeResources, { root, db, raw: {} });
    const first = new runsModule.Runs(ctx, {
      run: () => Promise.resolve({ code: 0, timedOut: false, stopped: false, output: '', ms: 1 }),
    });
    bunTest.expect(first.list(10)).toHaveLength(0);

    const insertSql = 'INSERT INTO runs (id, command, cwd, why, source, timeout_sec, status, review,'
      + ' approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const reviewJson = JSON.stringify({ by: 'rule', reason: '审核中', ms: 0 });
    db.query(insertSql).run('r_running', 'echo 1', root, '', 'test', 60, 'running', reviewJson, null, 1);
    db.query(insertSql).run('r_pend_null', 'echo 2', root, '', 'test', 60, 'pending', reviewJson, null, 2);
    db.query(insertSql).run('r_pend_user', 'echo 3', root, '', 'test', 60, 'pending', reviewJson, 99, 3);

    //M 模拟服务重启后重新构造 Runs，检查三类记录的恢复状态。
    const restarted = new runsModule.Runs(ctx, {
      run: () => Promise.resolve({ code: 0, timedOut: false, stopped: false, output: '', ms: 1 }),
    });
    bunTest.expect(restarted.read('r_running')?.status).toBe('failed');
    bunTest.expect(restarted.read('r_running')?.error).toContain('程序重启了');
    bunTest.expect(restarted.read('r_pend_null')?.status).toBe('failed');
    bunTest.expect(restarted.read('r_pend_user')?.status).toBe('pending');
    bunTest.expect(restarted.read('r_pend_user')?.approvalId).toBe(99);
  });

  bunTest.test('10. Runs 路由校验：拒绝非法 cwd/why/from/timeout/ask_user，并截顶 timeoutSec 与返回 404', async () => {
    const db = new sqlite.Database(':memory:');
    const app = fastify.default();
    httpPlugin.registerHttpErrorHandler(app);
    const root = makeTempRoot('audit-runs-val-');
    const ctx = new cordis.Context();
    closers.push(() => app.close());
    closers.push(() => ctx.fiber.dispose());
    closers.push(() => db.close());

    await ctx.plugin(FakeResources, { root, db, raw: {} });
    requestEvents.onRequestEvent(ctx, 'approval/request', 'approval/result', (req: ApprovalAsk): ApprovalReply => {
      if (req.action !== 'review') return {};

      return { verdict: { result: 'reject', by: 'rule', reason: '只测校验' } };
    });
    const runs = new runsModule.Runs(ctx, {
      run: () => Promise.resolve({ code: 0, timedOut: false, stopped: false, output: '', ms: 1 }),
    });
    runsModule.mountRunsRoutes(app, runs);

    const badPayloads: Record<string, unknown>[] = [
      { command: '' },
      { command: 'echo ok', cwd: 123 },
      { command: 'echo ok', why: {} },
      { command: 'echo ok', from: [] },
      { command: 'echo ok', timeout: 0 },
      { command: 'echo ok', ask_user: 'yes' },
    ];
    for (const payload of badPayloads) {
      const res = await app.inject({ method: 'POST', url: '/api/run', payload });
      bunTest.expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }

    //M 超大 timeout 被安全钳制到 MAX_TIMEOUT_SEC (3600)。
    const clamped = await app.inject({
      method: 'POST',
      url: '/api/run',
      payload: { command: 'echo hi', timeout: 99999 },
    });
    bunTest.expect(clamped.statusCode).toBe(200);
    bunTest.expect(clamped.json<runsModule.RunRecord>().timeoutSec).toBe(3600);

    //G 未知 runId 的查询、日志与停止均返回 404。
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/runs/missing' })).statusCode).toBe(404);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/runs/missing/log' })).statusCode).toBe(404);
    bunTest.expect((await app.inject({ method: 'POST', url: '/api/runs/missing/stop' })).statusCode).toBe(404);
  });

  bunTest.test('11. Runs.tail 对超 200 行与超 20KB 多字节中文输出安全截断且不产生头部乱码字符', async () => {
    const db = new sqlite.Database(':memory:');
    const root = makeTempRoot('audit-runs-tail-');
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    closers.push(() => db.close());

    await ctx.plugin(FakeResources, { root, db, raw: {} });
    const runs = new runsModule.Runs(ctx, {
      run: () => Promise.resolve({ code: 0, timedOut: false, stopped: false, output: '', ms: 1 }),
    });

    const reviewJson = JSON.stringify({ by: 'rule', reason: 'ok', ms: 1 });
    const insertSql = 'INSERT INTO runs (id, command, cwd, why, source, timeout_sec, status, review,'
      + ' created_at, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const manyLines = Array.from({ length: 260 }, (_unused, idx) => `row-${String(idx + 1)}`).join('\n');
    db.query(insertSql).run('r_lines', 'echo', root, '', 'test', 60, 'done', reviewJson, 1, manyLines);

    //M 构造超 20KB 的纯中文单行，专门验证按字节切片后不会在开头留下 UTF-8 替换字符 U+FFFD。
    const hugeUtf8 = '中'.repeat(9000);
    db.query(insertSql).run('r_bytes', 'echo', root, '', 'test', 60, 'done', reviewJson, 2, hugeUtf8);

    const tailLines = runs.tail('r_lines');
    bunTest.expect(tailLines).toContain('[只留了最后一段，全部输出用 /api/runs/r_lines/log 看]');
    bunTest.expect(tailLines).toContain('row-260');
    bunTest.expect(tailLines).not.toContain('row-1\n');

    const tailBytes = runs.tail('r_bytes');
    bunTest.expect(tailBytes).toContain('[只留了最后一段，全部输出用 /api/runs/r_bytes/log 看]');
    const bodyAfterBanner = tailBytes.split('\n')[1] ?? '';
    bunTest.expect(bodyAfterBanner.includes('\uFFFD')).toBe(false);
    bunTest.expect(Buffer.byteLength(bodyAfterBanner, 'utf8')).toBeLessThanOrEqual(20_000);
  });

  bunTest.test('12. Runs.onDecided 同意触发执行、已停止记录不被迟到审批覆写，且 apply 校验非法 paths 配置', async () => {
    const db = new sqlite.Database(':memory:');
    const root = makeTempRoot('audit-runs-decided-');
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    closers.push(() => db.close());

    await ctx.plugin(FakeResources, { root, db, raw: {} });
    requestEvents.onRequestEvent(ctx, 'approval/request', 'approval/result', (req: ApprovalAsk): ApprovalReply => {
      if (req.action !== 'review') return {};

      return { verdict: { result: 'asked', id: 501, reason: '等用户' } };
    });

    const ranCommands: string[] = [];
    const runs = new runsModule.Runs(ctx, {
      run: (input) => {
        ranCommands.push(input.command);
        return Promise.resolve({ code: 0, timedOut: false, stopped: false, output: 'done-ok', ms: 5 });
      },
    });

    const first = await runs.start({ command: 'echo approve-me', ask_user: true });
    bunTest.expect(first.status).toBe('pending');
    ctx.emit('approval/decided', makeDecidedPending({
      id: 501,
      kind: 'run',
      state: 'approved',
      payload: { runId: first.id },
    }));
    const waited = await runs.wait(first.id, 2000);
    bunTest.expect(waited?.status).toBe('done');
    bunTest.expect(ranCommands).toEqual(['echo approve-me']);

    //G 已经 stop 的命令收到迟到的 approved 通知也不得再启动或改写状态。
    const second = await runs.start({ command: 'echo stop-me', ask_user: true });
    runs.stop(second.id);
    ctx.emit('approval/decided', makeDecidedPending({
      id: 501,
      kind: 'run',
      state: 'approved',
      payload: { runId: second.id },
    }));
    await Bun.sleep(30);
    bunTest.expect(runs.read(second.id)?.status).toBe('stopped');
    bunTest.expect(ranCommands).toEqual(['echo approve-me']);

    //G apply() 拒绝非字符串 paths.runtimes / paths.program。
    const badCtx = new cordis.Context();
    closers.push(() => badCtx.fiber.dispose());
    await badCtx.plugin(FakeResources, { root, db, raw: { paths: { runtimes: 123 } } });
    await badCtx.plugin(toolsModule.Tools);
    new FakeSessions(badCtx);
    bunTest.expect(() => execPlugin.apply(badCtx)).toThrow('paths.runtimes');
  });
});
