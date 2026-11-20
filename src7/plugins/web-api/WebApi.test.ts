/**
 * web-api 网页发话走 channel/direct 的冒烟与离线测试（渠道统一第 2、3、4 步）：
 *   1. POST /api/message 返回 { id, file: '' } 与原先一字不差；
 *      channel/direct 只发 1 次，目标机器人只认领 1 次，回复照旧落进 GET /api/messages/:id 的 replies；
 *   2. 同客户前台会话发起待确认后通过 POST /api/message 发“同意 1” → channel/direct 只发 1 次，
 *      approval 只消费 1 次，确认文字通过 channel/reply 落进 replies，不再触发多余模型轮次；
 *   3. 第 4 步：一轮里调两次 channel_reply → replies 两条、顺序对；一次不调 → 零次兜底只出一条；
 *   4. 第 3 步：指定会话只进那场、只回一次，显式会话不投给别的机器人，“同意 N”只消费一次；引用别的渠道的消息进原会话、回到网页这条；
 *   5. A 块：GET /api/channels 清单，时间线按 channel + chat 筛，POST 带 view 校验后进前台提示，不带 view 时请求、返回、消息都不变；
 *   6. 网页主人发“同意 N”可批飞书群/单聊或无会话的待确认且只消费一次；飞书群外人与微信客户发“同意 N”不能批主人待确认。
 *
 * 跑法：bun test ./src7/plugins/web-api/WebApi.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { registerHttpErrorHandler } from '../http/index.ts';
import * as channels from '../channels/index.ts';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as approvalModule from '../approval/index.ts';
import * as botsPlugin from '../bots/index.ts';
import * as workspacesPlugin from '../workspaces/index.ts';
import * as webApiModule from './index.ts';


//M 每个测例后自动清理插件和临时目录。
const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假资源服务。 */
class FakeResources extends cordis.Service {
  readonly db = new Database(':memory:');
  readonly raw: Record<string, unknown>;
  readonly root: string;
  readonly version = '0.7.30-test';
  readonly builtTime = Date.now();
  readonly config = {
    defaultModel: 'fake/fake',
    sessionCacheMax: 500,
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
    plugins: [] as Array<{ name: string; config?: unknown }>,
  };

  constructor(ctx: cordis.Context, options: { root: string; bots: Array<{ name: string }> }) {
    super(ctx, 'resources');
    this.root = options.root;
    this.raw = { bots: options.bots };
  }

  ensureRuntimeDir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  getModel(): { input: string[] } {
    return { input: ['text'] };
  }
}


/** 内存 Fastify Http 服务，用 app.inject 测接口而不占真实端口。 */
class FakeHttp extends cordis.Service {
  readonly app: fastify.FastifyInstance;

  constructor(ctx: cordis.Context) {
    super(ctx, 'http');
    this.app = fastify.default({ logger: false });
    //M 注入请求使用生产 HTTP 的错误正文和状态码。
    registerHttpErrorHandler(this.app);
    ctx.effect(() => () => void this.app.close());
  }

  isVerified(request: fastify.FastifyRequest): boolean {
    return request.headers['x-fixture-unverified'] !== '1';
  }
}


/** 等待条件满足，最多 3 秒。 */
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等待超时：条件未在 3 秒内成立');
}


test('POST /api/message 与 GET /api/messages/:id 冒烟契约不变，且 channel/direct 仅发 1 次、approval 仅消费 1 次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webapi-channel-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources, { root, bots: [{ name: '助手' }] });
  await ctx.plugin(FakeHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(approvalModule, { thinking: 'low', decision_pass: 0.8 });
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  //M 跟踪 channel/direct 发出与认领结果、模型调用次数。
  const emitted: Array<{ message: channels.ChannelMessage; control: channels.ChannelMessageControl | undefined }> = [];
  ctx.on('channel/direct', (message, control) => {
    emitted.push({ message, control });
  });

  let modelRuns = 0;
  ctx.on('session/before-model', (request) => {
    modelRuns += 1;
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    let said = '';
    if (last?.role === 'user') {
      said = piAi.contentText(last.content);
    }
    request.answer = piAi.fauxAssistantMessage(`网页回：${said}`);
  });

  //G 1. 冒烟契约：POST /api/message 返回严格等于 { id: 1, file: '' }。
  const postRes = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/message',
    payload: { text: '你好网页冒烟', bot: '助手', from: 'web' },
  });
  expect(postRes.statusCode).toBe(200);
  expect(postRes.json<{ id: number; file: string }>()).toEqual({ id: 1, file: '' });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.message.channel).toBe('http');
  expect(emitted[0]?.message.targetBots).toEqual(['助手']);
  expect(emitted[0]?.control?.claims).toHaveLength(1);
  expect(emitted[0]?.control?.claims[0]?.status).toBe('claimed');

  let view1: { status: string; replies: Array<{ text: string }> } | undefined;
  await waitFor(async () => {
    const getRes = await ctx.http.app.inject({ method: 'GET', url: '/api/messages/1' });
    if (getRes.statusCode !== 200) return false;

    const body = getRes.json() as { status: string; replies: Array<{ text: string }> };
    if (body.status === 'replied' && body.replies.length > 0) {
      view1 = body;
      return true;
    }
    return false;
  });
  expect(modelRuns).toBe(1);
  expect(view1?.replies).toHaveLength(1);
  expect(view1?.replies[0]?.text).toBe('网页回：你好网页冒烟');

  //G 2. 审批单次消费：从同客户前台会话发起待确认，再 POST /api/message 发“同意 1”，确认回执照样落进 replies。
  const front = ctx.sessions.find({ bot: '助手', kind: 'front', customer: 'http:本机' })[0];
  expect(front).toBeDefined();
  let decidedState = '';
  ctx.on('approval/decided', (pending) => {
    decidedState = pending.state;
  });
  const pending = ctx.approval.ask({
    kind: 'exec',
    title: '执行一条检查',
    detail: 'dir',
    payload: {},
    bot: '助手',
    session: front?.id,
  });

  const approvePost = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/message',
    payload: { text: `同意 ${String(pending.id)}`, bot: '助手' },
  });
  expect(approvePost.statusCode).toBe(200);
  expect(approvePost.json<{ id: number; file: string }>()).toEqual({ id: 2, file: '' });
  expect(emitted).toHaveLength(2);
  expect(emitted[1]?.control?.approvalHandled).toBe(true);
  expect(emitted[1]?.control?.claims).toHaveLength(0);
  expect(decidedState).toBe('approved');
  expect(modelRuns).toBe(1);

  const getRes2 = await ctx.http.app.inject({ method: 'GET', url: '/api/messages/2' });
  expect(getRes2.statusCode).toBe(200);
  const view2 = getRes2.json() as { status: string; replies: Array<{ text: string }> };
  expect(view2.status).toBe('replied');
  expect(view2.replies).toHaveLength(1);
  expect(view2.replies[0]?.text).toContain(`已同意待确认 #${String(pending.id)}`);
});


/**
 * 搭一套挂好 web-api 的环境：两个机器人（助手、备选），假模型由 answer 决定每一步回什么。
 * @param answer 每次 session/before-model 收到步数（从 1 数）和会话，交回 AssistantMessage，含 content 和 stopReason。
 * @param options 可省略审核插件或替换为没有事件应答的机器人清单。
 */
async function makeWeb(
  answer: (step: number, session: { id: string }) => ReturnType<typeof piAi.fauxAssistantMessage>,
  options: { withApproval?: boolean; withBotEvents?: boolean } = {},
): Promise<{ ctx: cordis.Context; emitted: Array<{ message: channels.ChannelMessage; control: channels.ChannelMessageControl | undefined }>; steps: () => number }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webapi-step34-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources, { root, bots: [{ name: '助手' }, { name: '备选' }] });
  await ctx.plugin(FakeHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  if (options.withBotEvents !== false) {
    await ctx.plugin(botsPlugin, {});
  }
  if (options.withBotEvents === false) {
    //M 只提供网页需要的机器人清单，模拟保存附件的机器人响应器缺席。
    const bot = { name: '助手', config: {} };
    ctx.provide('bots', {
      list: () => [bot],
      get: (name: string) => [bot].find((entry) => entry.name === name),
      channel: () => () => undefined,
    });
  }
  if (options.withApproval !== false) {
    await ctx.plugin(approvalModule, { thinking: 'low', decision_pass: 0.8 });
  }
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  //M 记下每次 channel/direct 和认领结果。
  const emitted: Array<{ message: channels.ChannelMessage; control: channels.ChannelMessageControl | undefined }> = [];
  ctx.on('channel/direct', (message, control) => {
    emitted.push({ message, control });
  });

  //M 假模型：第几步回什么由 answer 定。
  let step = 0;
  ctx.on('session/before-model', (request) => {
    step += 1;
    request.answer = answer(step, request.session);
  });
  return { ctx, emitted, steps: () => step };
}


/**
 * POST /api/message 一次，交回消息号。
 * @param ctx 挂好的环境。
 * @param payload 请求体。
 */
async function post(ctx: cordis.Context, payload: Record<string, unknown>): Promise<number> {
  const response = await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload });
  expect(response.statusCode).toBe(200);
  return (response.json() as { id: number }).id;
}

test('网页来源标记由 HTTP 钩子生成，已批准的定时提醒只写一次原机器人时间线', async () => {
  const world = await makeWeb(() => piAi.fauxAssistantMessage('知道了'));
  const { ctx, emitted } = world;
  const original = { text: '定一条提醒', bot: '助手', verifiedOwner: true };
  const rejectedSource = {
    method: 'POST' as const, url: '/api/message', payload: original, headers: { 'x-fixture-unverified': '1' },
  };
  const unverified = await ctx.http.app.inject(rejectedSource);
  expect(unverified.statusCode).toBe(200);
  expect(emitted[0]?.message.origin.address['verifiedOwner']).toBe(false);
  const id = await post(ctx, original);
  expect(emitted[1]?.message.origin.address['verifiedOwner']).toBe(true);
  await settled(ctx, id);

  const row = Object.freeze({
    id: 17, bot: '助手', channel: 'http', account: 'local', chat: 'http:本机', text: '提醒：测试会议', confirmed: true,
  });
  requestEventModule.onRequestEvent(ctx, 'assist/reminder-read', 'assist/reminder-row', (request) => {
    if (request.reminderId !== row.id) return {};

    return { row };
  });
  const payload = { reminderId: row.id };
  const before = world.steps();
  const first = await requestEventModule.requestEvent(ctx, 'approval/reminder-send', 'approval/reminder-sent', payload);
  const repeated = await requestEventModule.requestEvent(ctx, 'approval/reminder-send', 'approval/reminder-sent', payload);
  expect(first.reply?.receipt.status).toBe('sent');
  expect(repeated.reply?.receipt.status).toBe('sent');
  expect(world.steps()).toBe(before);
  const sql = "SELECT id FROM web_messages WHERE bot = ? AND source = 'reminder' ORDER BY id";
  const reminders = ctx.resources.db.query<{ id: number }, [string]>(sql).all('助手');
  expect(reminders).toHaveLength(1);
  const url = `/api/messages/${reminders[0]!.id}`;
  const visible = await ctx.http.app.inject(url);
  expect(visible.json()).toMatchObject({ text: '（系统）提醒：测试会议', channel: 'http', status: 'replied' });
});


/**
 * 等这条消息回完，交回网页看到的样子。
 * @param ctx 挂好的环境。
 * @param id 消息号。
 */
async function settled(ctx: cordis.Context, id: number): Promise<{ status: string; sessionId: string | null; replies: Array<{ text: string; session: { id: string } }> }> {
  let view: { status: string; sessionId: string | null; replies: Array<{ text: string; session: { id: string } }> } | undefined;
  await waitFor(async () => {
    const response = await ctx.http.app.inject({ method: 'GET', url: `/api/messages/${String(id)}` });
    if (response.statusCode !== 200) return false;

    const body = response.json() as { status: string; sessionId: string | null; replies: Array<{ text: string; session: { id: string } }> };
    if (body.status !== 'replied') return false;

    view = body;
    return true;
  });

  //M 再等一下：确认标成回完以后不会再多出回话。
  await Bun.sleep(50);
  const response = await ctx.http.app.inject({ method: 'GET', url: `/api/messages/${String(id)}` });
  const last = response.json() as typeof view;
  expect(last?.replies.length).toBe(view?.replies.length);
  return last!;
}


test('切换模型使用目录回执，无应答时按未知模型返回', async () => {
  const { ctx } = await makeWeb(() => piAi.fauxAssistantMessage('好'));
  const session = ctx.sessions.create({ bot: '助手', kind: 'work' });
  const model = 'fake/alternate';
  const request = {
    method: 'POST',
    url: `/api/sessions/${session.id}/model`,
    payload: { model },
  } as const;
  const originalModel = session.row.model;

  //G 无监听时按未知模型报错，不保存任何会话变更。
  const unavailable = await ctx.http.app.inject(request);
  expect(unavailable.statusCode).toBe(400);
  expect(unavailable.json<{ error: string }>()).toEqual({ error: `模型不可用：${model}` });
  expect(session.row.model).toBe(originalModel);

  //M 模拟目录接受事件并返回模型信息，网页应保存模型与默认思考档。
  const stop = requestEventModule.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', (query) => {
    expect(query).toMatchObject({ action: 'find', model });
    return {
      info: {
        id: model,
        name: '测试模型',
        kind: 'chat' as const,
        contextWindow: 1000,
        thinking: ['off', 'high'],
        price: { input: 0, output: 0 },
      },
    };
  });
  closers.push(() => { stop(); });
  const updated = await ctx.http.app.inject(request);
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ id: session.id, model, thinking: 'high' });
  expect(session.row).toMatchObject({ model, thinking: 'high' });
});

test('页面版本查询无人应答只保留后端版本，收到基地回执后显示壳子版本', async () => {
  const { ctx } = await makeWeb(() => piAi.fauxAssistantMessage('好'));
  const route = '/api/ui/info';
  const withoutBase = await ctx.http.app.inject(route);
  expect(withoutBase.statusCode).toBe(200);
  expect(withoutBase.json()).toMatchObject({ server: { version: expect.any(String) }, shell: null });

  requestEventModule.onRequestEvent(ctx, 'base/request', 'base/result', (request) => {
    expect(request).toMatchObject({ method: 'GET', route: '/version', timeoutMs: 800 });
    return { ok: true, status: 200, body: { version: ' 1.2.3 ', builtAt: 123 } };
  });
  const withBase = await ctx.http.app.inject(route);
  expect(withBase.statusCode).toBe(200);
  expect(withBase.json()).toMatchObject({ shell: { version: '1.2.3', builtAt: 123 } });
});

test.each([{ withApproval: true, approvals: 1 }, { withApproval: false, approvals: 0 }])(
  '机器人列表按审核回执显示待确认数，审批监听为 $withApproval', async ({ withApproval, approvals }) => {
    const { ctx } = await makeWeb(() => piAi.fauxAssistantMessage('好'), { withApproval });
    let status = 'idle';
    if (withApproval) {
      //M 有会话的待确认影响机器人状态，无会话的待确认不计入。
      const session = ctx.sessions.create({ bot: '助手', kind: 'work' });
      const input = { kind: 'exec', title: '待确认', detail: 'dir', payload: null, bot: '助手' };
      const withSession = { ...input, session: session.id };
      ctx.approval.ask(withSession);
      ctx.approval.ask(input);
      status = 'waiting';
    }

    const response = await ctx.http.app.inject('/api/bots');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '助手', approvals, status }),
      expect.objectContaining({ name: '备选', approvals: 0, status: 'idle' }),
    ]));
  },
);

test('机器人确认保存附件后，网页消息引用实际路径并消费暂存上传', async () => {
  const { ctx, emitted } = await makeWeb(() => piAi.fauxAssistantMessage('好'));
  const upload = '20261118065001001001';
  const dir = ctx.resources.ensureRuntimeDir('data', 'tmp', 'uploads');
  const file = path.join(dir, `${upload}_笔记.txt`);
  fs.writeFileSync(file, '原始附件');
  const requests: requestEventModule.EventArg<'bot/request'>[] = [];
  ctx.on('bot/request', (request) => { requests.push(request); });

  const payload = { bot: '助手', text: '查这份附件', uploads: [upload] };
  const id = await post(ctx, payload);
  await settled(ctx, id);

  expect(requests).toContainEqual(expect.objectContaining({ action: 'save-file', bot: '助手', name: '笔记.txt' }));
  expect(fs.existsSync(file)).toBe(false);
  const bot = ctx.bots.get('助手');
  const inbox = path.join(bot!.workspace, 'inbox');
  const day = fs.readdirSync(inbox)[0]!;
  const savedDir = path.join(inbox, day);
  const name = fs.readdirSync(savedDir)[0]!;
  const saved = path.join(savedDir, name);
  expect(fs.readFileSync(saved, 'utf8')).toBe('原始附件');
  expect(emitted[0]?.message.text).toContain(saved);
});

test.each([
  { failure: '无人应答', throws: false, status: 503, error: '附件存不下：保存附件未获回执（unhandled）' },
  { failure: '处理方抛错', throws: true, status: 504, error: '附件保存结果不确定，请核对工作区后再提交。' },
])('保存附件遇到 $failure 时回 $status 并保留上传，不提交消息', async ({ throws, status, error }) => {
  const options = { withApproval: false, withBotEvents: false };
  const { ctx, emitted } = await makeWeb(() => piAi.fauxAssistantMessage('好'), options);
  if (throws) {
    //M 模拟机器人接单后抛错，调用方无法确定文件是否已经落盘。
    requestEventModule.onRequestEvent(ctx, 'bot/request', 'bot/result', () => {
      throw new Error('模拟保存抛错');
    });
  }
  const upload = '20261118065001001001';
  const dir = ctx.resources.ensureRuntimeDir('data', 'tmp', 'uploads');
  const file = path.join(dir, `${upload}_笔记.txt`);
  fs.writeFileSync(file, '原始附件');

  const payload = { bot: '助手', text: '查这份附件', uploads: [upload] };
  const input = { method: 'POST', url: '/api/message', payload } as const;
  const response = await ctx.http.app.inject(input);
  expect(response.statusCode).toBe(status);
  expect(response.json<{ error: string }>().error).toBe(error);
  expect(fs.readFileSync(file, 'utf8')).toBe('原始附件');
  expect(emitted).toEqual([]);
});

test('暂存上传在等落盘回执期间只能由一条消息占用，失败后可以重试', async () => {
  const options = { withApproval: false, withBotEvents: false };
  const { ctx } = await makeWeb(() => piAi.fauxAssistantMessage('好'), options);
  const upload = '20261118065001001001';
  const dir = ctx.resources.ensureRuntimeDir('data', 'tmp', 'uploads');
  const file = path.join(dir, `${upload}_笔记.txt`);
  fs.writeFileSync(file, '原始附件');
  const received = Promise.withResolvers<void>();
  const next = Promise.withResolvers<void>();
  const stop = requestEventModule.onRequestEvent(ctx, 'bot/request', 'bot/result', async () => {
    received.resolve();
    await next.promise;
    return { ok: false, error: '模拟保存失败' };
  });

  //M 首次请求留在等待回执状态，再提交同一个暂存上传。
  const payload = { bot: '助手', text: '查这份附件', uploads: [upload] };
  const input = { method: 'POST', url: '/api/message', payload } as const;
  const first = ctx.http.app.inject(input).then((response) => response);
  await received.promise;
  const duplicate = await ctx.http.app.inject(input);
  next.resolve();
  const failed = await first;
  expect(duplicate.statusCode).toBe(409);
  expect(failed.statusCode).toBe(500);
  expect(failed.json<{ error: string }>().error).toBe('附件存不下：模拟保存失败');

  //M 首次保存失败后占用释放，下一条能重新发起保存请求。
  stop();
  const retry = await ctx.http.app.inject(input);
  expect(retry.statusCode).toBe(503);
  expect(fs.readFileSync(file, 'utf8')).toBe('原始附件');
});


test('运行中列表优先用进度事件，无应答时显示会话自己的进度', async () => {
  const { ctx } = await makeWeb(() => piAi.fauxAssistantMessage('好'));
  const session = ctx.sessions.create({ bot: '助手', kind: 'work' });
  session.row.state = 'running';
  session.save();
  const url = '/api/ui/running';

  //M 没有进度插件时仍列出运行会话，用会话信息给出动作和开始时刻。
  const fallback = await ctx.http.app.inject(url);
  expect(fallback.statusCode).toBe(200);
  expect(fallback.json()).toMatchObject([
    { id: session.id, action: '后台运行中', startedAt: session.row.updatedAt },
  ]);

  const startedAt = session.row.updatedAt - 1000;
  const action = '测试进度卡片的动作';
  const card = {
    id: 1,
    sessionId: session.id,
    bot: '助手',
    text: '',
    model: session.row.model,
    stage: 'running' as const,
    action,
    startedAt,
    steps: 0,
    limitChosen: false,
    extended: 0,
    timings: { modelMs: 0, tools: [] },
    messageIds: [],
  };

  //M 进度监听回应后，网页改用卡片中的动作和开始时刻。
  const stop = requestEventModule.onRequestEvent(ctx, 'progress/request', 'progress/result', (query) => {
    expect(query).toMatchObject({ action: 'list', bot: '助手' });
    return { items: [card] };
  });
  closers.push(() => { stop(); });
  const current = await ctx.http.app.inject(url);
  expect(current.statusCode).toBe(200);
  expect(current.json()).toMatchObject([{ id: session.id, action, startedAt }]);
});


test('回话追溯查询流水和用量，无应答时保留消息与缺项说明', async () => {
  const { ctx } = await makeWeb(() => piAi.fauxAssistantMessage('已回答'));
  const id = await post(ctx, { text: '测试追溯', bot: '助手' });
  const message = await settled(ctx, id);
  const sessionId = message.replies[0]!.session.id;
  const url = `/api/messages/${id}/trace?reply=0`;

  //M 两个监听都没挂时，消息仍可追溯到目标回话与原文。
  const fallback = await ctx.http.app.inject(url);
  expect(fallback.statusCode).toBe(200);
  expect(fallback.json()).toMatchObject({
    target: { messageId: id, text: '已回答' },
    scope: 'message-only',
    sources: [{ id, text: '测试追溯' }],
    events: [],
    usage: [],
    truncated: false,
    notes: expect.arrayContaining(['没有流水明细或查询超时', '没有用量或查询超时']),
  });

  //M 流水以收件编号为键，用量以相关会话和起止时刻为键。
  const stopJournal = requestEventModule.onRequestEvent(ctx, 'journal/request', 'journal/result', (query) => {
    expect(query).toMatchObject({ action: 'reply-lines', message: id, maxLines: 500, sessions: [sessionId] });
    return {
      events: [{
        id: 1,
        type: '测试事件',
        at: 0,
        source: '测试插件',
        bot: '助手',
        sessionId,
        messageId: id,
        key: null,
        parent: null,
        depth: 0,
        data: { kind: '事件', mode: '通知', listeners: ['测试插件'], site: 'WebApi.test.ts' },
      }],
    };
  });
  const stopUsage = requestEventModule.onRequestEvent(ctx, 'model-catalog/usage', 'model-catalog/usage-result', (query) => {
    expect(query).toMatchObject({ sessions: [sessionId], limit: 200 });
    expect(query.from).toBeGreaterThan(0);
    expect(query.to).toBeGreaterThanOrEqual(query.from);
    return {
      rows: [{
        at: query.to,
        sessionId,
        provider: 'fake',
        model: 'fake',
        kind: 'chat',
        purpose: 'front',
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        ms: 1,
        ok: true,
      }],
      truncated: true,
    };
  });
  closers.push(() => { stopJournal(); });
  closers.push(() => { stopUsage(); });

  const current = await ctx.http.app.inject(url);
  expect(current.statusCode).toBe(200);
  expect(current.json()).toMatchObject({
    scope: 'exact',
    events: [{ type: '测试事件', source: '测试插件', data: { mode: '通知' } }],
    usage: [{ sessionId, input: 1, output: 2 }],
    truncated: true,
  });
});


test('第 4 步：网页一轮里调两次 channel_reply，replies 两条、顺序对；一次不调走兜底只出一条', async () => {
  //M 第 1 条消息：第 1 步发“先说一句”，第 2 步发“再说一句”，第 3 步收尾不调工具；第 2 条消息（第 4 步）一次不调。
  const { ctx, steps } = await makeWeb((step) => {
    if (step === 1) {
      const call = piAi.fauxToolCall('channel_reply', { text: '先说一句', kind: 'progress' });
      return piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
    }
    if (step === 2) {
      const call = piAi.fauxToolCall('channel_reply', { text: '再说一句' });
      return piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
    }
    if (step === 3) return piAi.fauxAssistantMessage('这句是草稿，不该发出去');

    return piAi.fauxAssistantMessage('一次没调，兜底发这句');
  });

  const first = await post(ctx, { text: '连发两条', bot: '助手', from: 'web' });
  const firstView = await settled(ctx, first);
  expect(firstView.replies.map((item) => item.text)).toEqual(['先说一句', '再说一句']);
  expect(steps()).toBe(3);

  const second = await post(ctx, { text: '一条都不调', bot: '助手', from: 'web' });
  const secondView = await settled(ctx, second);
  expect(secondView.replies.map((item) => item.text)).toEqual(['一次没调，兜底发这句']);
  expect(steps()).toBe(4);
});


test('第 3 步：指定会话只进那场、只回一次；显式会话不投给别的机器人；指定会话发“同意 N”只消费一次', async () => {
  const { ctx, emitted, steps } = await makeWeb((_step, session) => piAi.fauxAssistantMessage(`会话 ${session.id} 回`));

  //M 先建两场：助手的一场后台、备选的一场前台。
  const work = ctx.sessions.create({ bot: '助手', kind: 'work', thinking: 'low' });
  const otherFront = ctx.sessions.create({ bot: '备选', kind: 'front', customer: 'http:本机' });

  //M 指定助手的后台：只进那场，回一次。
  const id = await post(ctx, { text: '接着这场干', session: work.id });
  const view = await settled(ctx, id);
  expect(emitted.at(-1)?.message.routing.sessionId).toBe(work.id);
  expect(emitted.at(-1)?.control?.claims).toEqual([
    expect.objectContaining({ bot: '助手', status: 'claimed', sessionId: work.id }),
  ]);
  expect(view.replies).toHaveLength(1);
  expect(view.replies[0]?.text).toBe(`会话 ${work.id} 回`);
  expect(view.sessionId).toBe(work.id);
  expect(steps()).toBe(1);

  //M 指定会话和机器人对不上：入口直接 400。
  const mismatch = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/message',
    payload: { text: '对不上', bot: '助手', session: otherFront.id },
  });
  expect(mismatch.statusCode).toBe(400);

  //M 绕过入口直接发：消息给两个机器人、指定的是备选的前台 → 只有备选认领，进那场前台。
  const control: channels.ChannelMessageControl = { claims: [] };
  const direct = structuredClone(emitted.at(-1)!.message);
  direct.messageId = channels.makeChannelMessageId('http', 'local', 'direct-1');
  direct.targetBots = ['助手', '备选'];
  direct.routing = { autoFinal: true, sessionId: otherFront.id };
  direct.origin = { channel: 'http', address: { messageId: 9999, customer: 'http:本机' } };
  await ctx.serial('channel/direct', direct, control);
  expect(control.claims).toEqual([
    expect.objectContaining({ bot: '备选', status: 'claimed', sessionId: otherFront.id }),
  ]);
  await waitFor(() => ctx.sessions.find({ id: otherFront.id })[0]?.state === 'done');

  //M 指定会话发“同意 N”：approval 先消费一次，不进会话、不调模型。待确认挂在网页的前台上（发起人是网页，网页能批）。
  const before = steps();
  let decided = 0;
  ctx.on('approval/decided', () => {
    decided += 1;
  });
  //M   前台要记着网页的渠道和地址：approval 从会话的渠道、地址认发起人（actor），没地址就谁说“同意”都不算。
  const webFront = ctx.sessions.create({ bot: '助手', kind: 'front', customer: 'http:本机' });
  ctx.bots.route(webFront, { channel: 'http', address: { messageId: 0, customer: 'http:本机' } });
  const pending = ctx.approval.ask({ kind: 'exec', title: '跑一条', detail: 'dir', payload: {}, bot: '助手', session: webFront.id });
  const approve = await post(ctx, { text: `同意 ${String(pending.id)}`, session: work.id });
  expect(emitted.at(-1)?.control?.approvalHandled).toBe(true);
  expect(emitted.at(-1)?.control?.claims).toHaveLength(0);
  const approveView = await settled(ctx, approve);
  expect(approveView.replies).toHaveLength(1);
  expect(decided).toBe(1);
  expect(steps()).toBe(before);
});


test('第 3 步：网页引用别的渠道的消息，进原会话，回话回到网页这条', async () => {
  const { ctx, emitted } = await makeWeb((_step, session) => piAi.fauxAssistantMessage(`原会话 ${session.id} 回`));

  //M 在新装数据库核对引用和跨渠道来源两列的类型。
  const schema = 'PRAGMA table_info(web_messages)';
  const columns = ctx.resources.db.query(schema).all();
  expect(columns).toContainEqual(expect.objectContaining({ name: 'reply_to', type: 'INTEGER', notnull: 0 }));
  expect(columns).toContainEqual(expect.objectContaining({ name: 'source_id', type: 'TEXT', notnull: 0 }));

  //M 造一条飞书群里的消息：原会话是助手的一场前台，收件表里记了它（照 bot/receive 记的样子）。
  const original = ctx.sessions.create({ bot: '助手', kind: 'front', customer: 'feishu:group:oc_1' });
  const insert = 'INSERT INTO web_messages (bot, channel, source, address, text, session_id, status, replies, created_at, updated_at, source_id)'
    + " VALUES (?, 'feishu', 'feishu', ?, ?, ?, 'replied', '[]', ?, ?, ?)";
  const now = Date.now();
  const address = JSON.stringify({ chatId: 'oc_1', chatType: 'group', chatName: '测试群' });
  const result = ctx.resources.db.query(insert).run('助手', address, '群里有人问进度', original.id, now, now, 'src-1');
  const quotedId = Number(result.lastInsertRowid);

  const id = await post(ctx, { text: '帮我回他：明天给', reply_to: quotedId });
  const view = await settled(ctx, id);

  //M 带的路由：指定原会话，记下被引那条的原渠道、原机器人、原会话。
  const message = emitted.at(-1)!.message;
  expect(message.channel).toBe('http');
  expect(message.routing.sessionId).toBe(original.id);
  expect(message.routing.replyOrigin).toEqual({ source: 'feishu', bot: '助手', sessionId: original.id });

  //M 话进了原会话；回话追加在网页这条上，回一次。
  const said = ctx.sessions.open(original.id).row.messages.filter((item) => item.role === 'user').map((item) => piAi.contentText(item.content));
  expect(said.some((text) => text.includes('群里有人问进度') && text.includes('帮我回他：明天给'))).toBe(true);
  expect(view.replies.map((item) => item.text)).toEqual([`原会话 ${original.id} 回`]);
  expect(view.sessionId).toBe(original.id);

  //M 网页这条是网页自己的一条（不冒充飞书的消息），被引那条不多回话。
  const row = ctx.resources.db.query('SELECT channel, reply_to FROM web_messages WHERE id = ?').get(id) as { channel: string; reply_to: number };
  expect(row).toEqual({ channel: 'http', reply_to: quotedId });
  const quoted = ctx.resources.db.query('SELECT replies FROM web_messages WHERE id = ?').get(quotedId) as { replies: string };
  expect(quoted.replies).toBe('[]');
});


test('时间线能读取损坏地址，并用其余字符串字段生成渠道标签', async () => {
  //M 在收件表放入解析失败和字段类型不符的旧地址，同时保留正常地址作对照。
  const { ctx } = await makeWeb(() => piAi.fauxAssistantMessage('好'));
  const insert = 'INSERT INTO web_messages (bot, channel, source, address, text, status, created_at, updated_at)'
    + " VALUES ('助手', ?, 'test', ?, ?, 'replied', 1000, 1000)";
  const save = ctx.resources.db.query(insert);
  const badId = JSON.stringify({ chatId: 'oc_bad', chatType: 'group', openId: 42 });
  const user = JSON.stringify({ name: { text: '错类型' }, chatName: '', userName: '用户甲', openId: 'ou_1234' });
  const suffixOnly = JSON.stringify({ openId: 'ou_9876' });
  const wechat = JSON.stringify({ name: ['错类型'], chat: 'wx_chat' });
  save.run('feishu', '{', '坏地址');
  save.run('feishu', badId, '坏编号');
  save.run('feishu', user, '备用名字');
  save.run('feishu', suffixOnly, '编号末四位');
  save.run('wechat', wechat, '微信聊天号');

  //M 一条地址出错时仍返回整页，并按各渠道的规则生成两个展示字段。
  const response = await ctx.http.app.inject('/api/messages?bot=助手');
  expect(response.statusCode).toBe(200);
  const page = response.json<{ messages: Array<{ text: string; peer: string; chatLabel: string }> }>();
  expect(page.messages.map((item) => [item.text, item.peer, item.chatLabel])).toEqual([
    ['坏地址', '飞书·私聊', '飞书·私聊'],
    ['坏编号', '飞书·群', '飞书·群'],
    ['备用名字', '飞书·私聊·用户甲', '飞书·私聊·用户甲'],
    ['编号末四位', '飞书·私聊·9876', '飞书·私聊·9876'],
    ['微信聊天号', '微信·wx_chat', '微信·wx_chat'],
  ]);
});


test('A 块：GET /api/channels 列挂着的渠道和聊天；时间线按 channel + chat 筛；POST 带 view 校验后进前台提示，不带时消息上没有 view', async () => {
  //M 假模型记下前台每一步的系统提示。
  const systems: string[][] = [];
  const { ctx, emitted } = await makeWeb(() => piAi.fauxAssistantMessage('好'));
  ctx.on('session/before-model', (request) => {
    systems.push([...request.system]);
  });

  //M 挂一个假的飞书渠道（只登记渠道名），收件表里放两个群各一条。
  ctx.bots.channel('feishu');
  const insert = 'INSERT INTO web_messages (bot, channel, source, address, text, session_id, status, replies, created_at, updated_at)'
    + " VALUES ('助手', 'feishu', 'feishu', ?, ?, NULL, 'replied', '[]', ?, ?)";
  const groupA = JSON.stringify({ chatId: 'oc_a', chatType: 'group', chatName: '甲群' });
  const groupB = JSON.stringify({ chatId: 'oc_b', chatType: 'group', chatName: '乙群' });
  ctx.resources.db.query(insert).run(groupA, '甲群的话', 1000, 1000);
  ctx.resources.db.query(insert).run(groupB, '乙群的话', 2000, 2000);

  //M 不带 view 的冒烟：返回 { id, file: '' }，消息上没有 view 这一项。
  const plainResponse = await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload: { text: '平常一句', bot: '助手' } });
  expect(plainResponse.json<{ id: number; file: string }>()).toEqual({ id: 3, file: '' });
  expect('view' in emitted.at(-1)!.message).toBe(false);
  await settled(ctx, 3);

  //M 清单：网页（http:本机 一项）、飞书（乙群在前）。
  const listResponse = await ctx.http.app.inject({ method: 'GET', url: '/api/channels?bot=助手' });
  const list = listResponse.json() as { channels: Array<{ id: string; label: string; count: number; chats: Array<{ id: string; label: string; count: number; updatedAt: number }> }> };
  const web = list.channels.find((item) => item.id === 'http');
  const feishu = list.channels.find((item) => item.id === 'feishu');
  expect(web?.chats.map((item) => item.id)).toEqual(['http:本机']);
  expect(web?.label).toBe('网页');
  expect(feishu?.chats.map((item) => [item.id, item.label, item.count])).toEqual([
    ['oc_b', '飞书·群·乙群', 1],
    ['oc_a', '飞书·群·甲群', 1],
  ]);

  //M 时间线按 channel + chat 筛：只出甲群那条，带 chat、chatLabel。
  const filtered = await ctx.http.app.inject({ method: 'GET', url: '/api/messages?bot=助手&channel=feishu&chat=oc_a' });
  const page = filtered.json() as { messages: Array<{ text: string; chat: string; chatLabel: string }> };
  expect(page.messages.map((item) => [item.text, item.chat, item.chatLabel])).toEqual([['甲群的话', 'oc_a', '飞书·群·甲群']]);
  const chatOnly = await ctx.http.app.inject({ method: 'GET', url: '/api/messages?bot=助手&chat=oc_a' });
  expect(chatOnly.statusCode).toBe(400);

  //M 倒序只取最新一条并报告还有更早的，增量按更新时间筛选后以编号排序。
  const latest = await ctx.http.app.inject('/api/messages?channel=feishu&limit=1');
  expect(latest.json()).toMatchObject({ messages: [{ text: '乙群的话' }], hasMore: true, cursor: 2000 });
  const changed = await ctx.http.app.inject('/api/messages?channel=feishu&after=1000');
  expect(changed.json()).toMatchObject({
    messages: [{ text: '甲群的话' }, { text: '乙群的话' }],
    hasMore: false,
    cursor: 2000,
  });

  //M 搜索保留原话命中类型与倒序排列。
  const search = await ctx.http.app.inject({ url: '/api/search', query: { q: '群的话', bot: '助手' } });
  expect(search.json()).toMatchObject({
    messages: [{ snippet: '乙群的话', hit: 'text' }, { snippet: '甲群的话', hit: 'text' }],
  });

  //M 带 view：校验过的 view（带名字）放进消息，前台这一轮的提示里有“用户正在网页上看”。
  const viewed = await post(ctx, { text: '这个群在聊什么', bot: '助手', view: { channel: 'feishu', chat: 'oc_a' } });
  await settled(ctx, viewed);
  expect(emitted.at(-1)?.message.view).toEqual({ channel: 'feishu', chat: 'oc_a', label: '飞书·群·甲群' });
  expect(systems.at(-1)).toContain('用户正在网页上看：飞书·群·甲群');

  //M 看整个渠道：chat 不写。
  await post(ctx, { text: '飞书最近怎样', bot: '助手', view: { channel: 'feishu' } });
  expect(emitted.at(-1)?.message.view).toEqual({ channel: 'feishu', chat: '', label: '飞书·全部聊天' });

  //M 写错的 view 都 400，不发 channel/direct。
  const before = emitted.length;
  for (const bad of [{ channel: 'wechat', chat: 'x' }, { channel: 'feishu', chat: 'oc_none' }, { chat: 'oc_a' }, 'feishu']) {
    const response = await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload: { text: '错的', bot: '助手', view: bad } });
    expect(response.statusCode).toBe(400);
  }
  expect(emitted).toHaveLength(before);
});


test('第 6 步：网页主人可批飞书群/单聊与无会话待确认且只消费一次，飞书群外人与微信客户不能批', async () => {
  const { ctx, emitted, steps } = await makeWeb((_step, session) => piAi.fauxAssistantMessage(`会话 ${session.id} 回`));

  //M 记录每一次 approval/decided 的序号与最终状态，验证同号待确认只消费一次。
  const decidedIds: number[] = [];
  const decidedStates = new Map<number, string>();
  ctx.on('approval/decided', (pending) => {
    decidedIds.push(pending.id);
    decidedStates.set(pending.id, pending.state);
  });
  const getApprovalState = (id: number): string | undefined => {
    const row = ctx.resources.db.query('SELECT state FROM approval_pending WHERE id = ?').get(id) as { state: string } | null;
    return row?.state;
  };

  //M 先从网页发一条普通消息作为基础样例，并验证网页入站消息的 origin.address.owner 严格为 true。
  const warmId = await post(ctx, { text: '先打个招呼', bot: '助手' });
  await settled(ctx, warmId);
  const webSample = emitted[0]!.message;
  expect(webSample.origin.address['owner']).toBe(true);

  //M 造三种非网页发起的待确认：飞书群会话、飞书单聊会话、无会话（session 留空）。
  const feishuGroupSession = ctx.sessions.create({ bot: '助手', kind: 'front', customer: 'feishu:group:oc_g1' });
  ctx.bots.route(feishuGroupSession, {
    channel: 'feishu',
    address: { appId: 'cli_1', chatId: 'oc_g1', openId: 'ou_guest', chatType: 'group', customer: 'feishu:group:oc_g1', owner: false, role: 'guest' },
  });
  const pendingGroup = ctx.approval.ask({
    kind: 'exec',
    title: '群会话发起的操作',
    detail: 'cmd_group',
    payload: {},
    bot: '助手',
    session: feishuGroupSession.id,
  });

  const feishuP2pSession = ctx.sessions.create({ bot: '助手', kind: 'front', customer: 'feishu:ou_other' });
  ctx.bots.route(feishuP2pSession, {
    channel: 'feishu',
    address: { appId: 'cli_1', chatId: 'oc_p2p', openId: 'ou_other', chatType: 'p2p', customer: 'feishu:ou_other', owner: false, role: 'guest' },
  });
  const pendingP2p = ctx.approval.ask({
    kind: 'exec',
    title: '飞书单聊发起的操作',
    detail: 'cmd_p2p',
    payload: {},
    bot: '助手',
    session: feishuP2pSession.id,
  });

  const pendingSessionless = ctx.approval.ask({
    kind: 'exec',
    title: '无会话待确认',
    detail: 'cmd_none',
    payload: {},
    bot: '助手',
  });

  //M 先造一条网页主人发起的待确认，校验飞书群外人与微信客户发“同意 N”都不能批主人待确认。
  const webFront = ctx.sessions.create({ bot: '助手', kind: 'front', customer: 'http:本机' });
  ctx.bots.route(webFront, { channel: 'http', address: { messageId: 0, customer: 'http:本机', owner: true } });
  const pendingOwner = ctx.approval.ask({
    kind: 'exec',
    title: '主人网页发起的操作',
    detail: 'cmd_owner',
    payload: {},
    bot: '助手',
    session: webFront.id,
  });

  const feishuGuestMsg = structuredClone(webSample);
  feishuGuestMsg.messageId = channels.makeChannelMessageId('feishu', 'cli_1', 'om_guest_1');
  feishuGuestMsg.nativeId = 'om_guest_1';
  feishuGuestMsg.channel = 'feishu';
  feishuGuestMsg.accountId = 'cli_1';
  feishuGuestMsg.chatId = 'oc_g1';
  feishuGuestMsg.chatType = 'group';
  feishuGuestMsg.role = 'guest';
  feishuGuestMsg.sender = { id: 'ou_guest', name: '群外人' };
  feishuGuestMsg.rawText = `同意 ${String(pendingOwner.id)}`;
  feishuGuestMsg.text = `同意 ${String(pendingOwner.id)}`;
  feishuGuestMsg.visibility = { scope: 'feishu:cli_1:oc_g1', trusted: false, publicSourceIds: [] };
  feishuGuestMsg.origin = {
    channel: 'feishu',
    address: { appId: 'cli_1', chatId: 'oc_g1', openId: 'ou_guest', chatType: 'group', owner: false, role: 'guest' },
  };
  const feishuGuestCtrl: channels.ChannelMessageControl = { claims: [] };
  await ctx.serial('channel/mention', feishuGuestMsg, feishuGuestCtrl);
  expect(feishuGuestCtrl.approvalHandled).toBeUndefined();
  expect(getApprovalState(pendingOwner.id)).toBe('waiting');

  const wechatCustomerMsg = structuredClone(webSample);
  wechatCustomerMsg.messageId = channels.makeChannelMessageId('wechat', 'wx_acc', 'wx_msg_1');
  wechatCustomerMsg.nativeId = 'wx_msg_1';
  wechatCustomerMsg.channel = 'wechat';
  wechatCustomerMsg.accountId = 'wx_acc';
  wechatCustomerMsg.chatId = 'wx_c1';
  wechatCustomerMsg.chatType = 'p2p';
  wechatCustomerMsg.role = 'guest';
  wechatCustomerMsg.sender = { id: 'wx_c1', name: '微信客户' };
  wechatCustomerMsg.rawText = `同意 ${String(pendingOwner.id)}`;
  wechatCustomerMsg.text = `同意 ${String(pendingOwner.id)}`;
  wechatCustomerMsg.visibility = { scope: 'wechat:wx_acc:wx_c1', trusted: true, publicSourceIds: [] };
  wechatCustomerMsg.origin = {
    channel: 'wechat',
    address: { account: 'wx_acc', chat: 'wx_c1', customer: 'wechat:wx_c1', name: '微信客户' },
  };
  const wechatCtrl: channels.ChannelMessageControl = { claims: [] };
  await ctx.serial('channel/direct', wechatCustomerMsg, wechatCtrl);
  expect(wechatCtrl.approvalHandled).toBeUndefined();
  expect(getApprovalState(pendingOwner.id)).toBe('waiting');
  expect(decidedIds).toHaveLength(0);

  //M 等待外人入站轮次跑完后再记录模型调用基线，确保后续验证网页主人“同意 N”零模型调用。
  await waitFor(() => ctx.sessions.find({ bot: '助手' }).every((item) => item.state !== 'running' && item.activeKey === undefined));
  const stepsBeforeOwnerApprovals = steps();

  //M 网页主人依次对飞书群、飞书单聊、无会话及主人待确认发“同意 N”：每条都能直接批且不走模型轮次。
  for (const targetPending of [pendingGroup, pendingP2p, pendingSessionless, pendingOwner]) {
    const msgId = await post(ctx, { text: `同意 ${String(targetPending.id)}`, bot: '助手' });
    const latest = emitted.at(-1)!;
    expect(latest.message.origin.address['owner']).toBe(true);
    expect(latest.control?.approvalHandled).toBe(true);
    expect(latest.control?.claims).toHaveLength(0);
    expect(decidedStates.get(targetPending.id)).toBe('approved');
    expect(getApprovalState(targetPending.id)).toBe('approved');
    const view = await settled(ctx, msgId);
    expect(view.replies[0]?.text).toContain(`已同意待确认 #${String(targetPending.id)}`);
  }

  expect(decidedIds).toEqual([pendingGroup.id, pendingP2p.id, pendingSessionless.id, pendingOwner.id]);
  expect(steps()).toBe(stepsBeforeOwnerApprovals);

  //M 对已批准的飞书群待确认重复发“同意 N”：不能触发第二次 approval/decided，且等该条收尾避免与清理竞争。
  const repeatId = await post(ctx, { text: `同意 ${String(pendingGroup.id)}`, bot: '助手' });
  await settled(ctx, repeatId);
  expect(decidedIds.filter((item) => item === pendingGroup.id)).toHaveLength(1);
});
