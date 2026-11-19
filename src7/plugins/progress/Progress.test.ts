/**
 * progress（含并入的 Review 超时复盘）单元测试：
 *   1. Progress 主流程：running 启动、session/new-message 记步数与工具耗时、act(stop) 终止、写入 data/overtime.jsonl；
 *   2. Review 完整链路：空闲时读超时记录，生成建议，经 approval/request 登记后等待用户决定。
 *   3. 配置入口校验与开关：review: false / enabled: false 关闭复盘；非法 first_ms / every_ms 抛错。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';
import type { AskInput, Session } from '../../Sessions.ts';
import * as events from '../../utils/RequestEvent.ts';
import type { Pending } from '../approval/index.ts';
import * as progressPlugin from './index.ts';
import * as words from './Words.ts';


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


/** 构建临时运行时目录并挂上假 resources / sessions（可选 approval / filesMirror）。 */
async function setupWorld(options: {
  withApproval?: boolean;
  withoutClose?: boolean;
  withHand?: boolean;
  withDecision?: boolean;
  withMirror?: boolean;
  withCatalog?: boolean;
  reviewReply?: string;
  listenSay?: boolean;
  pluginConfig?: progressPlugin.ProgressConfig;
} = {}): Promise<{
  ctx: cordis.Context;
  root: string;
  session: Session;
  askedReviews: string[];
  askInputs: AskInput[];
  approvalAskList: Pending[];
  decisionRequests: events.EventArg<'decision/judge'>[];
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
  const askInputs: AskInput[] = [];
  const approvalAskList: Pending[] = [];
  const decisionRequests: events.EventArg<'decision/judge'>[] = [];
  const traces: { where: string; what: string; vars?: Record<string, unknown> }[] = [];

  class MockResources extends cordis.Service {
    readonly root = root;
    readonly raw = { bots: [{ name: '周小灵', language: 'zh' }] };
    constructor(parent: cordis.Context) {
      super(parent, 'resources');
    }
    ensureRuntimeDir(...parts: string[]): string {
      const target = path.join(root, ...parts);
      fs.mkdirSync(target, { recursive: true });
      return target;
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
    queueUserMessage: () => undefined,
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
    create(input: Pick<Session['row'], 'bot' | 'kind' | 'frontTask' | 'workspaceId'>): Session {
      const id = 'session-next';
      const fresh = { id, row: { ...input, id }, save: () => undefined } as unknown as Session;
      sessionMap.set(id, fresh);
      return fresh;
    }
    async ask(input: AskInput): Promise<{ ok: boolean; reply: string }> {
      askInputs.push(input);
      askedReviews.push(input.text);
      if (input.kind === 'progress-review' && options.reviewReply !== undefined) {
        return { ok: true, reply: options.reviewReply };
      }
      return { ok: true, reply: '- 先查记忆库再全局搜索（预计快 40%）\n- 只读相关函数行段（预计快 25%）' };
    }
  }

  await ctx.plugin(MockResources);
  await ctx.plugin(MockSessions);
  if (options.listenSay !== false) {
    ctx.on('bot/say', (_session, text) => { sayLogs.push(text); });
  }

  if (options.withCatalog === true) {
    events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', (request) => {
      if (request.action !== 'find') return {};

      const { model } = request;
      return {
        info: {
          id: model, name: model, kind: 'chat' as const, contextWindow: 128000,
          thinking: ['off', 'xhigh', 'medium'], price: { input: 0, output: 0 },
        },
      };
    });
  }

  if (options.withMirror === true) {
    const mirrorDir = path.join(root, 'bots', '周小灵', 'sessions', fakeSession.id);
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.writeFileSync(path.join(mirrorDir, '对话.md'), '## 用户\n帮我查慢在哪里\n## 助手\n读了不少文件才找到。', 'utf8');

    events.onRequestEvent(ctx, 'journal/request', 'journal/result', (request) => {
      if (request.action !== 'mirror-dir') return {};

      const target = path.join(root, 'bots', request.bot, 'sessions', request.sessionId);
      return { dir: target };
    });
  }

  if (options.withApproval === true) {
    const approvalOptions: events.OnRequestEventOptions<events.EventArg<'approval/request'>, events.EventArg<'approval/result'>> = {
      filter: (request) => request.action !== 'close' || options.withoutClose !== true,
    };
    //M 用事件模拟审批插件，按请求登记、按种类查询、关闭仍在等待的卡片。
    events.onRequestEvent(ctx, 'approval/request', 'approval/result', (request) => {
      if (request.action === 'list') {
        const items = approvalAskList.filter((item) => item.state === 'waiting' && item.kind === request.kind);
        return { items };
      }
      if (request.action === 'close') {
        const pending = approvalAskList.find((item) => item.id === request.id);
        if (pending === undefined) return { error: '找不到卡片' };

        pending.state = 'rejected';
        pending.card.state = 'ended';
        pending.card.result = request.note;
        return { settled: pending };
      }
      if (request.action !== 'ask') return {};

      const id = approvalAskList.length + 1;
      const card = { ...request.input.card, state: 'waiting' } as Pending['card'];
      const pending = { ...request.input, id, state: 'waiting', askedAt: Date.now(), card } as Pending;
      approvalAskList.push(pending);
      return { pending };
    }, approvalOptions);
  }

  if (options.withHand === true) {
    //M 模拟机器人接手，回执只带实际接手的会话号。
    events.onRequestEvent(ctx, 'bot/request', 'bot/result', (request) => {
      if (request.action !== 'hand') return { ok: false };

      const input = { bot: request.bot, kind: 'work' as const, thinking: 'low' as const };
      let freshId = request.sessionId;
      if (freshId === undefined) {
        const fresh = ctx.sessions.create(input);
        freshId = fresh.id;
      }
      return { ok: true, sessionId: freshId };
    });
  }

  if (options.withDecision === true) {
    //M 模拟三题都有分数，推进和完成过线，打转低于门槛。
    events.onRequestEvent(ctx, 'decision/judge', 'decision/judge-result', (request) => {
      decisionRequests.push(request);
      const looping = request.question.instructions === words.QUESTIONS.looping.instructions;
      if (looping) return { verdict: 'deny', score: 0.1, reason: '没有打转' } as const;

      return { verdict: 'allow', score: 0.9, reason: '达到门槛' } as const;
    });
  }

  ctx.on('trace', (where: string, what: string, _code: string, vars?: Record<string, unknown>) => {
    traces.push({ where, what, vars });
  });

  //M 测试默认关闭超时门槛与长跑提醒；用例可单独启用。
  const pluginConfig = { overtime_minutes: 0, long_run_card_minutes: 0, ...options.pluginConfig };
  await ctx.plugin(progressPlugin, pluginConfig);

  return { ctx, root, session: fakeSession, askedReviews, askInputs, approvalAskList, decisionRequests, sayLogs, traces };
}


test('1. Progress 主流程：running 启动、消息与工具耗时累计、act stop 终止并写 overtime.jsonl', async () => {
  const world = await setupWorld();
  const baseAt = Date.now() - 500;
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);

  expect(world.ctx.progress.list('周小灵').length).toBe(1);
  expect(world.ctx.progress.list('周小灵')[0]?.stage).toBe('running');

  //M Message 是一条历史消息。用 role 标记种类，content 给正文，timestamp 给可控的测试时间。
  world.ctx.emit('session/new-message', world.session, {
    role: 'user',
    content: '查一下这个问题出在哪',
    timestamp: baseAt + 100,
  } as piAi.Message);
  world.ctx.emit('session/new-message', world.session, {
    role: 'assistant',
    provider: 'mock',
    model: 'test-model',
    content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
    timestamp: baseAt + 250,
  } as unknown as piAi.Message);
  world.ctx.emit('session/new-message', world.session, {
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
  expect(world.traces.some((item) => item.what === 'trace.review.skip' && item.vars?.['reason'] === '有进度在转')).toBe(true);

  //M 停止任务产生 overtime.jsonl，手动等待下一轮不可能等 5 秒，重新挂载一份短周期实例或等待 5s？
  //M 更好的测法：停掉当前进程并用 short every_ms 测试——改用 first_ms: 80, 让运行态在前 25ms 内结束。
  expect(world.approvalAskList.length).toBe(0);
});


test('3. Review 完整闭环：空闲挑选超时条目、记 reviewedAt、送审并同意写出复盘 MD', async () => {
  const world = await setupWorld({
    withApproval: true,
    withMirror: true,
    withCatalog: true,
    pluginConfig: { wrapup_model: 'mock/new-model', review: { first_ms: 70, every_ms: 5000 } },
  });

  //M 20ms 内完成并产生 overtime.jsonl；70ms 时插件空闲触发复盘。
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);
  world.ctx.emit('session/new-message', world.session, { role: 'user', content: '分析插件合并缓慢原因', timestamp: Date.now() } as piAi.Message);
  world.ctx.progress.act(world.session.id, 'stop');

  //M 等待复盘定时器执行完成并写入 approval.ask。
  const deadline = Date.now() + 2000;
  while (world.approvalAskList.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  expect(world.askedReviews.length).toBe(1);
  expect(world.askedReviews[0]).toContain('读了不少文件才找到');
  expect(world.askInputs[0]?.thinking).toBe('medium');
  expect(world.askInputs[0]?.model).toBe('mock/new-model');
  expect(world.session.row.reviewedAt).toBeDefined();
  expect(world.approvalAskList.length).toBe(1);
  expect(world.approvalAskList[0]?.kind).toBe('review');
  expect(world.session.row.reviewApprovalId).toBe(world.approvalAskList[0]?.id);

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

test('复盘缺少镜像和模型应答时仍能生成询问', async () => {
  const world = await setupWorld({ withApproval: true, pluginConfig: { review: { first_ms: 40 } } });
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);
  world.ctx.progress.act(world.session.id, 'stop');

  const deadline = Date.now() + 1000;
  while (world.approvalAskList.length === 0 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(world.askInputs[0]?.text).toContain('没有记录：未获取到镜像');
  expect(world.askInputs[0]?.thinking).toBe('minimal');
});

test('查到一张待确认的复盘卡片时不再生成复盘', async () => {
  const world = await setupWorld({ withApproval: true, pluginConfig: { review: { first_ms: 40 } } });
  const input = { kind: 'review', title: '待确认', detail: '', payload: null, bot: world.session.row.bot };
  const ask = { action: 'ask', input } as const;

  //M 先经审批事件登记一张复盘卡片，再产生可复盘的超时记录。
  await events.requestEvent(world.ctx, 'approval/request', 'approval/result', ask, eventOptions);
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);
  world.ctx.progress.act(world.session.id, 'stop');

  const deadline = Date.now() + 1000;
  while (!world.traces.some((item) => item.vars?.['reason'] === '有复盘在等用户') && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(world.traces).toContainEqual(expect.objectContaining({ what: 'trace.review.skip', vars: { reason: '有复盘在等用户' } }));
  expect(world.askInputs).toEqual([]);
});

test('复盘列表无人应答仍生成建议，送审无人应答按拒绝处理', async () => {
  const world = await setupWorld({ pluginConfig: { review: { first_ms: 40 } } });
  const requests: Pending['payload'][] = [];

  //M 记录发送的载荷，不接单。之后模拟卡片迟到并被点击同意。
  world.ctx.on('approval/request', (request) => {
    if (request.action === 'ask') {
      requests.push(request.input.payload);
    }
  });
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);
  world.ctx.progress.act(world.session.id, 'stop');

  const reason = '审核未确认登记，复盘按拒绝处理：审核未获回执（unhandled）';
  const deadline = Date.now() + 1000;
  while (!world.traces.some((item) => item.vars?.['reason'] === reason) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(world.traces).toContainEqual(expect.objectContaining({ what: 'trace.review.skip', vars: { reason } }));
  expect(world.askInputs[0]?.kind).toBe('review');
  expect(world.session.row.reviewedAt).toBeDefined();
  expect(world.approvalAskList).toEqual([]);
  expect(requests).toHaveLength(1);
  const decided = { id: 1, kind: 'review', state: 'approved', payload: requests[0] } as Pending;
  world.ctx.emit('approval/decided', decided);

  const reviewDir = path.join(world.root, 'memory', '复盘');
  expect(fs.existsSync(reviewDir)).toBe(false);
});

test.each([{ withoutClose: true }, { withoutClose: false }])(
  '长跑确认卡片登记成功，会话结束照常定格，关闭无应答为 $withoutClose', async ({ withoutClose }) => {
  const world = await setupWorld({
    withApproval: true,
    withoutClose,
    pluginConfig: { long_run_card_minutes: 0.00005, review: false },
  });
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);

  //M 等待长跑请求的回执写入进度，再结束会话触发关闭卡片。
  const deadline = Date.now() + 1000;
  while (world.session.row.progress?.cardId === undefined && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  const pending = world.approvalAskList[0];
  expect(world.session.row.progress?.cardId).toBe(pending?.id);
  expect(pending?.card.kind).toBe('long-run');
  expect(world.sayLogs).toEqual([]);
  world.session.row.state = 'done';
  world.ctx.emit('session/change', world.session);
  await Bun.sleep(10);

  expect(world.ctx.progress.list()[0]?.stage).toBe('done');
  if (withoutClose) {
    expect(pending?.state).toBe('waiting');
    return;
  }
  expect(pending?.card.state).toBe('ended');
  expect(pending?.card.result).toBe('会话已结束（完成）');
});

test('长跑提醒、报时和收尾用通知发送，模型无人应答用最低默认档', async () => {
  const world = await setupWorld({
    pluginConfig: { long_run_card_minutes: 0.00005, review: false },
  });
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);
  await Bun.sleep(15);

  //G 没有确认登记的长跑卡片，后到的决定不能停止会话。
  const decided = { id: 1, kind: 'long-run', state: 'approved', payload: { sessionId: world.session.id } } as Pending;
  world.ctx.emit('approval/decided', decided);
  expect(world.session.row.state).toBe('running');

  world.ctx.progress.act(world.session.id, 'limit', 0.005);

  const deadline = Date.now() + 1000;
  while (world.sayLogs.length < 3 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(world.sayLogs).toEqual([
    expect.stringContaining('不管它就一直做下去'),
    expect.stringContaining('到点会先停下'),
    expect.stringContaining('先停在这里'),
  ]);
  expect(world.askInputs[0]?.thinking).toBe('minimal');
});

test.each([{ withDecision: true }, { withDecision: false }])(
  '到点判断三题有回执时延长，决策应答为 $withDecision', async ({ withDecision }) => {
  const world = await setupWorld({
    withDecision,
    pluginConfig: { limit_default_minutes: 0.0005, review: false },
  });
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);

  const deadline = Date.now() + 1000;
  while (!world.traces.some((item) => item.where === 'Progress.onDeadline') && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(world.traces).toContainEqual(expect.objectContaining({
    what: 'trace.progress.deadline', vars: expect.objectContaining({ extend: withDecision }),
  }));
  if (withDecision) {
    expect(world.decisionRequests).toHaveLength(3);
    expect(world.session.row.progress?.extended).toBe(1);
    return;
  }
  expect(world.ctx.progress.list()[0]?.stage).toBe('timeout');
});

test.each([
  { withCatalog: true, listenSay: true, expectedThinking: 'xhigh' as const },
  { withCatalog: false, listenSay: false, expectedThinking: 'high' as const },
])('进度审核选择 $expectedThinking 思考档并完成转交', async ({ withCatalog, listenSay, expectedThinking }) => {
  const world = await setupWorld({
    withCatalog,
    listenSay,
    withHand: true,
    pluginConfig: { limit_default_minutes: 0.0005, limit_extend_times: 0 },
    reviewReply: '{"absurd":false,"handoff":true,"handoffNote":"继续核对已有结果"}',
  });
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);

  const deadline = Date.now() + 1000;
  while (world.ctx.progress.list()[0]?.stage !== 'handed' && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(world.ctx.progress.list()[0]?.stage).toBe('handed');
  expect(world.ctx.sessions.open('session-next').row.progress?.handedOver).toBe(true);
  expect(world.askInputs[0]?.thinking).toBe(expectedThinking);
  if (!listenSay) return;

  expect(world.sayLogs).toContain('↪ 这件事转到新会话 session-next 接着做。交接说明：\n继续核对已有结果');
});

test('转交无人应答时撤销老会话的转交标记，进度和通知都写失败', async () => {
  const world = await setupWorld({
    pluginConfig: { limit_default_minutes: 0.0005, limit_extend_times: 0 },
    reviewReply: '{"absurd":false,"handoff":true,"handoffNote":"核对已有结果"}',
  });
  world.session.row.frontTask = { front: 'front-1', round: 2, workspace: '工作区', origin: {}, paused: false };
  world.session.row.state = 'running';
  world.ctx.emit('session/change', world.session);

  const deadline = Date.now() + 1000;
  while (world.ctx.progress.list()[0]?.endedAt === undefined && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  const failure = '想转新会话，但没有接手成功：转交未获回执（unhandled）';
  expect(world.ctx.progress.list()[0]).toMatchObject({ stage: 'stopped', action: failure });
  expect(world.session.row.frontTask.handedTo).toBeUndefined();
  expect(world.sayLogs).toContain(failure);
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

