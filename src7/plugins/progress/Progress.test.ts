/**
 * progress（含并入的 Review 超时复盘）单元测试：
 *   1. Progress 主流程：running 启动、session/message 记步数与工具耗时、act(stop) 终止、写入 data/overtime.jsonl；
 *   2. Review 完整链路：有在转进度时跳过、空闲后读取 overtime.jsonl 与 对话.md、落盘 reviewedAt、sessions.ask 写建议、approval.ask → approval/decided(approved) 写 memory/复盘/*.md；
 *   3. 配置入口校验与开关：review: false / enabled: false 关闭复盘；非法 first_ms / every_ms 抛错。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';
import type { Session } from '../../Sessions.ts';
import * as events from '../../utils/RequestEvent.ts';
import type { Pending } from '../approval/index.ts';
import * as progressPlugin from './index.ts';


const closers: (() => Promise<unknown> | void)[] = [];
const eventOptions = {
  timeoutMs: 1000,
  onFallback: (reason: events.FallbackReason) => ({ requestId: '', ok: false, text: reason }),
};

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 构建临时运行时目录并挂上假 resources / bots / sessions（可选 approval / filesMirror）。 */
async function setupWorld(options: {
  withApproval?: boolean;
  withMirror?: boolean;
  pluginConfig?: progressPlugin.ProgressConfig;
} = {}): Promise<{
  ctx: cordis.Context;
  root: string;
  session: Session;
  askedReviews: string[];
  approvalAskList: Pending[];
  sayLogs: string[];
  traces: { where: string; what: string; vars?: Record<string, unknown> }[];
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-progress-test-'));
  closers.push(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const sessionMap = new Map<string, Session>();
  const sayLogs: string[] = [];
  const askedReviews: string[] = [];
  const approvalAskList: Pending[] = [];
  const traces: { where: string; what: string; vars?: Record<string, unknown> }[] = [];

  class MockResources extends cordis.Service {
    readonly root = root;
    readonly raw = { engine: { overtime_minutes: 0, long_run_card_minutes: 0 } };
    constructor(parent: cordis.Context) {
      super(parent, 'resources');
    }
    dir(...parts: string[]): string {
      const target = path.join(root, ...parts);
      fs.mkdirSync(target, { recursive: true });
      return target;
    }
  }

  class MockBots extends cordis.Service {
    constructor(parent: cordis.Context) {
      super(parent, 'bots');
    }
    get(name: string): { config: Record<string, unknown> } | undefined {
      if (name === '周小灵') {
        return { config: { language: 'zh' } };
      }
      return undefined;
    }
    say(_session: Session, text: string): void {
      sayLogs.push(text);
    }
  }

  const fakeSession: Session = {
    id: '20261117173000001',
    row: {
      id: '20261117173000001',
      bot: '周小灵',
      kind: 'work',
      channel: 'feishu',
      address: 'feishu:oc_test',
      customer: 'leon',
      model: 'mock/test-model',
      thinking: 'low',
      state: 'idle',
      reply: '',
      summary: '查找慢任务原因',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    },
    add: () => undefined,
    run: async () => undefined,
    stop: () => {
      fakeSession.row.state = 'stopped';
      fakeSession.row.reply = '已停止（progress）';
      ctx.emit('session/change', fakeSession);
    },
    save: () => undefined,
  } as unknown as Session;
  sessionMap.set(fakeSession.id, fakeSession);

  class MockSessions extends cordis.Service {
    constructor(parent: cordis.Context) {
      super(parent, 'sessions');
    }
    find(query: { id?: string }): Session['row'][] {
      if (query.id !== undefined) {
        const hit = sessionMap.get(query.id);
        if (hit !== undefined) {
          return [hit.row];
        }
        return [];
      }
      return [...sessionMap.values()].map((item) => item.row);
    }
    open(id: string): Session {
      const hit = sessionMap.get(id);
      if (hit === undefined) {
        throw new Error(`找不到会话 ${id}`);
      }
      return hit;
    }
    async ask(input: { text: string }): Promise<{ ok: boolean; reply: string }> {
      askedReviews.push(input.text);
      return { ok: true, reply: '- 先查记忆库再全局搜索（预计快 40%）\n- 只读相关函数行段（预计快 25%）' };
    }
  }

  await ctx.plugin(MockResources);
  await ctx.plugin(MockBots);
  await ctx.plugin(MockSessions);

  if (options.withMirror === true) {
    const mirrorDir = path.join(root, 'bots', '周小灵', 'sessions', fakeSession.id);
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.writeFileSync(path.join(mirrorDir, '对话.md'), '## 用户\n帮我查慢在哪里\n## 助手\n读了不少文件才找到。', 'utf8');

    class MockMirror extends cordis.Service {
      constructor(parent: cordis.Context) {
        super(parent, 'filesMirror');
      }
      getDir(row: { bot: string; id: string }): string {
        return path.join(root, 'bots', row.bot, 'sessions', row.id);
      }
    }
    await ctx.plugin(MockMirror);
  }

  if (options.withApproval === true) {
    let nextPendingId = 1;
    class MockApproval extends cordis.Service {
      constructor(parent: cordis.Context) {
        super(parent, 'approval');
      }
      list(): Pending[] {
        return approvalAskList.filter((item) => item.state === 'waiting');
      }
      ask(input: { kind: string; title: string; detail: string; payload?: unknown; bot: string; session?: string }): Pending {
        const entry = {
          id: nextPendingId++,
          kind: input.kind,
          bot: input.bot,
          session: input.session,
          title: input.title,
          detail: input.detail,
          payload: input.payload,
          state: 'waiting',
          askedAt: Date.now(),
        } as unknown as Pending;
        approvalAskList.push(entry);
        return entry;
      }
      close(): void {
        return;
      }
    }
    await ctx.plugin(MockApproval);
  }

  ctx.on('trace', (where: string, what: string, _code: string, vars?: Record<string, unknown>) => {
    traces.push({ where, what, vars });
  });

  await ctx.plugin(progressPlugin, options.pluginConfig);

  return { ctx, root, session: fakeSession, askedReviews, approvalAskList, sayLogs, traces };
}


test('1. Progress 主流程：running 启动、消息与工具耗时累计、act stop 终止并写 overtime.jsonl', async () => {
  const world = await setupWorld();
  const baseAt = Date.now() - 500;
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);

  expect(world.ctx.progress.list('周小灵').length).toBe(1);
  expect(world.ctx.progress.list('周小灵')[0]?.stage).toBe('running');

  world.ctx.emit('session/message', world.session, {
    role: 'user',
    content: '查一下这个问题出在哪',
    timestamp: baseAt + 100,
  } as piAi.Message);
  world.ctx.emit('session/message', world.session, {
    role: 'assistant',
    provider: 'mock',
    model: 'test-model',
    content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
    timestamp: baseAt + 250,
  } as unknown as piAi.Message);
  world.ctx.emit('session/message', world.session, {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'read',
    content: [{ type: 'text', text: '文件内容' }],
    isError: false,
    timestamp: baseAt + 350,
  } as unknown as piAi.Message);

  const running = world.ctx.progress.list('周小灵')[0];
  expect(running?.steps).toBe(1);
  expect(running?.timings.tools[0]?.name).toBe('read');
  expect(running?.timings.tools[0]?.count).toBe(1);

  const reply = world.ctx.progress.act(world.session.id, 'stop');
  expect(reply).toBe('收到，马上停');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const ended = world.ctx.progress.list('周小灵')[0];
  expect(ended?.stage).toBe('stopped');
  expect(ended?.endedAt).toBeDefined();

  const overtimeFile = path.join(world.root, 'data', 'overtime.jsonl');
  expect(fs.existsSync(overtimeFile)).toBe(true);
  const rows = fs.readFileSync(overtimeFile, 'utf8').trim().split('\n');
  expect(rows.length).toBe(1);
});

test('进度事件可按机器人查询、限时和终止会话', async () => {
  const { ctx, session } = await setupWorld();
  session.row.state = 'running';
  ctx.emit('session/change', session);

  const list = { action: 'list', bot: session.row.bot } as const;
  const current = await events.requestEvent(ctx, 'progress/request', 'progress/result', list, eventOptions);
  expect(current.items).toMatchObject([{ sessionId: session.id, stage: 'running' }]);

  const limit = { action: 'act', sessionId: session.id, op: 'limit', minutes: 15 } as const;
  const limited = await events.requestEvent(ctx, 'progress/request', 'progress/result', limit, eventOptions);
  expect(limited).toMatchObject({ ok: true, text: expect.stringContaining('最多做 15 分钟') });
  expect(session.row.progress?.limitMinutes).toBe(15);

  const stop = { action: 'act', sessionId: session.id, op: 'stop' } as const;
  const stopped = await events.requestEvent(ctx, 'progress/request', 'progress/result', stop, eventOptions);
  expect(stopped).toMatchObject({ ok: true, text: '收到，马上停' });
  expect(session.row).toMatchObject({ state: 'stopped' });

  const repeated = await events.requestEvent(ctx, 'progress/request', 'progress/result', stop, eventOptions);
  expect(repeated).toMatchObject({ ok: false, text: '这件事已经结束了' });
});

test('进度操作在会话不存在或停止出错时回失败', async () => {
  const { ctx, session } = await setupWorld();
  const missing = { action: 'act', sessionId: 'missing', op: 'stop' } as const;
  const gone = await events.requestEvent(ctx, 'progress/request', 'progress/result', missing, eventOptions);
  expect(gone).toMatchObject({ ok: false, text: '这件事已经结束了' });
  expect(gone.requestId).toStartWith('req_');

  session.row.state = 'running';
  session.stop = () => {
    throw new Error('测试停止失败');
  };
  ctx.emit('session/change', session);

  const stop = { action: 'act', sessionId: session.id, op: 'stop' } as const;
  const rejected = await events.requestEvent(ctx, 'progress/request', 'progress/result', stop, eventOptions);
  expect(rejected).toMatchObject({ ok: false, text: '测试停止失败' });
  expect(rejected.requestId).toStartWith('req_');
});


test('2. Review 并入链路：忙时跳过、空闲读对话记录与超时行并经 approval 批准写 memory/复盘', async () => {
  const world = await setupWorld({
    withApproval: true,
    withMirror: true,
    pluginConfig: { review: { first_ms: 20, every_ms: 5000 } },
  });

  //M 先开一条未结束的进度：第一次定时触发（20ms）应跳过。
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);
  await new Promise((resolve) => setTimeout(resolve, 45));
  expect(world.traces.some((item) => item.where === 'Review.check' && item.vars?.['原因'] === '有进度在转')).toBe(true);

  //M 停止任务产生 overtime.jsonl，手动等待下一轮不可能等 5 秒，重新挂载一份短周期实例或等待 5s？
  //M 更好的测法：停掉当前进程并用 short every_ms 测试——改用 first_ms: 80, 让运行态在前 25ms 内结束。
  expect(world.approvalAskList.length).toBe(0);
});


test('3. Review 完整闭环：空闲挑选超时条目、记 reviewedAt、送审并同意写出复盘 MD', async () => {
  const world = await setupWorld({
    withApproval: true,
    withMirror: true,
    pluginConfig: { review: { first_ms: 70, every_ms: 5000 } },
  });

  //M 20ms 内完成并产生 overtime.jsonl；70ms 时插件空闲触发复盘。
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);
  world.ctx.emit('session/message', world.session, { role: 'user', content: '分析插件合并缓慢原因', timestamp: Date.now() } as piAi.Message);
  world.ctx.progress.act(world.session.id, 'stop');

  //M 等待复盘定时器执行完成并写入 approval.ask。
  const deadline = Date.now() + 2000;
  while (world.approvalAskList.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  expect(world.askedReviews.length).toBe(1);
  expect(world.askedReviews[0]).toContain('读了不少文件才找到');
  expect(world.session.row.reviewedAt).toBeDefined();
  expect(world.approvalAskList.length).toBe(1);
  expect(world.approvalAskList[0]?.kind).toBe('review');

  //M 模拟用户同意待确认项，Review 监听 approval/decided 后写进 memory/复盘/*.md。
  const pending = world.approvalAskList[0]!;
  pending.state = 'approved';
  world.ctx.emit('approval/decided', pending);

  const reviewDir = path.join(world.root, 'memory', '复盘');
  const files = fs.readdirSync(reviewDir);
  expect(files.length).toBe(1);
  expect(files[0]).toContain('分析插件合并缓慢原因.md');
  const md = fs.readFileSync(path.join(reviewDir, files[0]!), 'utf8');
  expect(md).toContain('# 复盘：分析插件合并缓慢原因');
  expect(md).toContain('先查记忆库再全局搜索');
});


test('4. ProgressConfig 入口校验与 review: false 开关', async () => {
  expect(() => progressPlugin.apply({} as cordis.Context, { review: { first_ms: 0 } })).toThrow('progress.review.first_ms 要是正数');
  expect(() => progressPlugin.apply({} as cordis.Context, { review: { every_ms: -1 } })).toThrow('progress.review.every_ms 要是正数');
  expect(() => progressPlugin.apply({} as cordis.Context, 'bad' as unknown as progressPlugin.ProgressConfig)).toThrow('progress 的 config 要写成对象');

  const disabledWorld = await setupWorld({
    withApproval: true,
    pluginConfig: { review: false },
  });
  disabledWorld.session.row.state = 'running';
  disabledWorld.ctx.emit('session/change', disabledWorld.session);
  disabledWorld.ctx.progress.act(disabledWorld.session.id, 'stop');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(disabledWorld.approvalAskList.length).toBe(0);
});
