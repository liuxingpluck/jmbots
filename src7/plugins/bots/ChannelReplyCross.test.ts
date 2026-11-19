/**
 * channel_reply 跨渠道 / 跨聊天端到端离线测试（#145）：
 *   1. 网页本人让 AI 往飞书群发话：飞书收到 channel/reply 且目标正确（不误 @ 路人），原网页不自动补回话；显式双调则两边各收各的；
 *   2. 本人跨渠道发微信照守“点头才发”规矩（不改微信插件），飞书私聊本人也可跨渠道发回网页，未知渠道或未知聊天写明原因拒绝；
 *   3. 外人（guest / builder / 微信客户）与群聊里的本人（含 trusted 群）指定别的渠道或别的聊天一律拒绝；
 *   4. 不写 channel 和 chat 时严格保持现状：网页带 view 看飞书群、网页引用飞书消息都只回网页不发飞书。
 *
 * 跑法：bun test ./src7/plugins/bots/ChannelReplyCross.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as channels from '../../Channels.ts';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as approvalModule from '../approval/index.ts';
import * as cliModule from '../cli/index.ts';
import * as feishuModule from '../feishu/index.ts';
import * as webApiModule from '../web-api/index.ts';
import * as wechatModule from '../wechat/index.ts';
import * as workspacesPlugin from '../workspaces/index.ts';
import * as botsPlugin from './index.ts';


//M 每个测例后自动清理挂载的插件与临时根目录。
const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假资源服务：提供内存 SQLite、临时目录与飞书应用配置。 */
class FakeResources extends cordis.Service {
  readonly db = new Database(':memory:');
  readonly raw: Record<string, unknown>;
  readonly root: string;
  readonly version = '0.7.40-test';
  readonly builtTime = Date.now();
  readonly config = {
    defaultModel: 'fake/fake',
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
    plugins: [] as Array<{ name: string; config?: unknown }>,
  };

  constructor(
    ctx: cordis.Context,
    options: {
      root: string;
      bots: Array<{ name: string }>;
      feishuApps?: Array<{ app_id: string; app_secret: string; bot: string }>;
    },
  ) {
    super(ctx, 'resources');
    this.root = options.root;
    this.raw = {
      bots: options.bots,
      channels: { feishu: options.feishuApps ?? [] },
    };
  }

  dir(...parts: string[]): string {
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
    ctx.effect(() => () => void this.app.close());
  }

  /** 这些注入请求模拟已核验的本机网页。 */
  isVerified(): boolean {
    return true;
  }
}


/** 飞书 SDK 发信记录：区分 create 与 reply 并保留提取出的正文与接收目标。 */
interface SentFeishuRecord {
  kind: 'create' | 'reply';
  receiveId: string;
  replyToMessageId: string;
  msgType: string;
  text: string;
}


/** 等待条件满足，最多 3 秒。 */
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等待超时：条件未在 3 秒内成立');
}


/** 等待某机器人全部前台会话空转（状态非 running 且无活跃队列项）。 */
async function waitFrontIdle(ctx: cordis.Context, bot: string): Promise<void> {
  await waitFor(() => ctx.sessions.find({ kind: 'front', bot }).every((item) => item.state !== 'running' && item.activeKey === undefined));
}


/** 往网页提交一条消息，交回新消息号。 */
async function postWeb(ctx: cordis.Context, payload: Record<string, unknown>): Promise<number> {
  const response = await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload });
  expect(response.statusCode).toBe(200);
  return (response.json() as { id: number }).id;
}


/** 等网页那条消息状态变成 replied，并短暂确认不会多出额外回话。 */
async function settledWeb(
  ctx: cordis.Context,
  id: number,
): Promise<{ status: string; sessionId: string | null; replies: Array<{ text: string; session: { id: string } }> }> {
  let view: { status: string; sessionId: string | null; replies: Array<{ text: string; session: { id: string } }> } | undefined;
  await waitFor(async () => {
    const response = await ctx.http.app.inject({ method: 'GET', url: `/api/messages/${String(id)}` });
    if (response.statusCode !== 200) return false;

    const body = response.json() as { status: string; sessionId: string | null; replies: Array<{ text: string; session: { id: string } }> };
    if (body.status !== 'replied') return false;

    view = body;
    return true;
  });

  //M 再等 40 毫秒确认收尾后没有多余自动兜底回复。
  await Bun.sleep(40);
  const checkRes = await ctx.http.app.inject({ method: 'GET', url: `/api/messages/${String(id)}` });
  const latest = checkRes.json() as typeof view;
  expect(latest?.replies.length).toBe(view?.replies.length);
  return latest!;
}


/**
 * 从飞书 SDK 的 JSON 正文串里提取纯文本内容。
 * @param rawContent SDK data.content 字符串。
 */
function parseFeishuContentText(rawContent: unknown): string {
  if (typeof rawContent !== 'string' || rawContent === '') return '';

  try {
    const parsed = JSON.parse(rawContent) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;

    return rawContent;
  } catch {
    return rawContent;
  }
}


/**
 * 桩化飞书客户端，拦截发信并记录发出的消息及目标，同时支持注模拟入站消息。
 * @param feishu 飞书服务实例。
 * @param appId 应用号。
 * @param options 可选配置（如机器人 openId 与预设群清单）。
 */
function stubFeishuClient(
  feishu: feishuModule.Feishu,
  appId: string,
  options?: { botOpenId?: string },
): {
  sent: SentFeishuRecord[];
  chats: Map<string, { name: string; members: Map<string, string>; at: number }>;
  triggerInbound: (data: unknown) => Promise<void>;
} {
  const inside = feishu as unknown as {
    apps: Map<string, {
      botOpenId?: string;
      client: { im: { v1: Record<string, unknown> } };
    }>;
    chats: Map<string, { name: string; members: Map<string, string>; at: number }>;
    inbound: { onMessage: (appId: string, data: unknown) => Promise<void> };
  };
  const app = inside.apps.get(appId);
  if (app === undefined) {
    throw new Error(`测试应用不存在：${appId}`);
  }
  app.botOpenId = options?.botOpenId ?? 'ou_bot';

  let seq = 0;
  const nextId = (): string => {
    seq += 1;
    return `om_sent_${String(seq)}`;
  };

  //M 记录所有从 im.v1.message.reply 与 im.v1.message.create 发往飞书的真实请求。
  const sent: SentFeishuRecord[] = [];
  const imV1 = app.client.im.v1 as {
    messageReaction: Record<string, unknown>;
    message: Record<string, unknown>;
    image: Record<string, unknown>;
    file: Record<string, unknown>;
  };
  imV1.messageReaction = {
    create: () => Promise.resolve({ code: 0, data: { reaction_id: 'r_1' } }),
    delete: () => Promise.resolve({ code: 0, data: {} }),
  };
  imV1.image = {
    create: () => Promise.resolve({ image_key: 'img_stub' }),
  };
  imV1.file = {
    create: () => Promise.resolve({ file_key: 'file_stub' }),
  };
  imV1.message = {
    reply: (req?: { path?: { message_id?: string }; data?: { msg_type?: string; content?: string } }) => {
      sent.push({
        kind: 'reply',
        receiveId: '',
        replyToMessageId: req?.path?.message_id ?? '',
        msgType: req?.data?.msg_type ?? '',
        text: parseFeishuContentText(req?.data?.content),
      });
      return Promise.resolve({ code: 0, data: { message_id: nextId() } });
    },
    create: (req?: { data?: { receive_id?: string; msg_type?: string; content?: string } }) => {
      sent.push({
        kind: 'create',
        receiveId: req?.data?.receive_id ?? '',
        replyToMessageId: '',
        msgType: req?.data?.msg_type ?? '',
        text: parseFeishuContentText(req?.data?.content),
      });
      return Promise.resolve({ code: 0, data: { message_id: nextId() } });
    },
  };

  return {
    sent,
    chats: inside.chats,
    triggerInbound: (data: unknown) => inside.inbound.onMessage(appId, data),
  };
}


test('1. 网页本人让 AI 往飞书群发话：飞书收到 channel/reply 且目标正确，原网页不自动补回话；显式双调则两边各收各的', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-reply-feishu-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_cross_reply_1';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '小发' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '小发' }],
  });
  await ctx.plugin(FakeHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
    groups: [{ chat_id: 'oc_group_1', listen: 'all', trusted: false }],
  });
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  //M 预置群信息：群里另有路人甲发过言，用来验证跨渠道发群不会误加 @路人甲。
  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const feishuStub = stubFeishuClient(feishu, appId, { botOpenId: 'ou_bot' });
  const members = new Map<string, string>([['ou_owner', '老板'], ['ou_guest', '路人甲']]);
  feishuStub.chats.set('oc_group_1', { name: '项目甲群', members, at: Date.now() });

  //M 记下每一次 channel/reply 请求、工具返回回执与发给模型的系统提示。
  const replyEvents: channels.ChannelReplyRequest[] = [];
  ctx.on('channel/reply', (request) => {
    replyEvents.push(structuredClone(request));
  });

  const receipts: channels.ReplyReceipt[] = [];
  const systems: string[] = [];
  let mode: 'seed' | '1a' | '1b' = 'seed';
  let callsIn1b = 0;

  ctx.on('session/request', (request) => {
    systems.push(request.system.join('\n'));
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      receipts.push(JSON.parse(piAi.contentText(last.content)) as channels.ReplyReceipt);
      if (mode === '1b' && callsIn1b === 1) {
        //M 子场景 1b 第二步：显式再调一次不带 channel/chat 的 channel_reply 回给网页原聊天。
        callsIn1b = 2;
        const backWeb = piAi.fauxToolCall('channel_reply', { text: '已经在飞书项目甲群里说了' });
        request.answer = piAi.fauxAssistantMessage([backWeb], { stopReason: 'toolUse' });
        return;
      }
      request.answer = piAi.fauxAssistantMessage('已在群里通知（这句普通文字绝不能兜底发回网页）');
      return;
    }

    if (mode === 'seed') {
      //M 预热群消息：先在原飞书群简单回一句“收到”，让群稳定写进 /api/channels 和 web_messages。
      const seedReply = piAi.fauxToolCall('channel_reply', { text: '收到' });
      request.answer = piAi.fauxAssistantMessage([seedReply], { stopReason: 'toolUse' });
      return;
    }

    if (mode === '1a') {
      //M 子场景 1a：只跨渠道调用飞书群，不调回网页的 channel_reply。
      const crossCall = piAi.fauxToolCall('channel_reply', { text: '今晚九点发版', channel: 'feishu', chat: 'oc_group_1' });
      request.answer = piAi.fauxAssistantMessage([crossCall], { stopReason: 'toolUse' });
      return;
    }

    //M 子场景 1b：用群展示名“项目甲群”指定目标发往飞书群，再接后续工具结果回网页。
    callsIn1b = 1;
    const crossByName = piAi.fauxToolCall('channel_reply', { text: '项目甲群第二次通知', channel: 'feishu', chat: '项目甲群' });
    request.answer = piAi.fauxAssistantMessage([crossByName], { stopReason: 'toolUse' });
  });

  //M 先向飞书群注入一条路人甲入站消息，建立 /api/channels 里的群聊天记录。
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest' }, sender_type: 'user' },
    message: {
      message_id: 'om_seed_1',
      chat_id: 'oc_group_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '项目群报个到' }),
    },
  });
  await waitFrontIdle(ctx, '小发');
  feishuStub.sent.length = 0;
  replyEvents.length = 0;
  receipts.length = 0;
  systems.length = 0;

  //M 验证工具说明与系统提示明确写明“只在本人口头要求时才发别处，绝不自作主张”。
  const replyTool = ctx.tools.list('front').find((item) => item.name === 'channel_reply');
  expect(replyTool?.description).toContain('别处');
  expect(replyTool?.description).toContain('自作主张');

  //G 场景 1a：网页本人让发飞书群 oc_group_1，bots 只带 target 发事件，飞书自认群号且不误 @ 路人，原网页不自动补回话。
  mode = '1a';
  const id1a = await postWeb(ctx, { text: '帮我在飞书项目甲群说：今晚九点发版', bot: '小发' });
  const view1a = await settledWeb(ctx, id1a);
  expect(receipts[0]?.ok).toBe(true);
  expect(receipts[0]?.status).toBe('sent');
  expect(replyEvents).toHaveLength(1);
  expect(replyEvents[0]?.channel).toBe('feishu');
  expect(replyEvents[0]?.target).toEqual({ channel: 'feishu', chat: 'oc_group_1' });
  expect(replyEvents[0]?.sourceSnapshot.channel).toBe('http');
  expect(feishuStub.sent).toHaveLength(1);
  expect(feishuStub.sent[0]?.kind).toBe('create');
  expect(feishuStub.sent[0]?.receiveId).toBe('oc_group_1');
  expect(feishuStub.sent[0]?.text).toBe('今晚九点发版');
  expect(view1a.status).toBe('replied');
  expect(view1a.replies).toEqual([]);
  expect(systems.some((text) => text.includes('只有用户本人明确要求去别的渠道或别的聊天发话时才填'))).toBe(true);

  //G 场景 1b：先按展示名“项目甲群”跨渠道发飞书群（由飞书自己认出群号），再显式调不带 channel/chat 的 channel_reply 回网页。
  mode = '1b';
  const id1b = await postWeb(ctx, { text: '用群名发一遍再告诉我', bot: '小发' });
  const view1b = await settledWeb(ctx, id1b);
  expect(replyEvents[1]?.target).toEqual({ channel: 'feishu', chat: '项目甲群' });
  expect(feishuStub.sent).toHaveLength(2);
  expect(feishuStub.sent[1]?.kind).toBe('create');
  expect(feishuStub.sent[1]?.receiveId).toBe('oc_group_1');
  expect(feishuStub.sent[1]?.text).toBe('项目甲群第二次通知');
  expect(view1b.replies.map((item) => item.text)).toEqual(['已经在飞书项目甲群里说了']);
});


test('2. 本人跨渠道发微信照守“点头才发”规矩（不改微信插件），飞书私聊本人也可跨渠道发回网页，未知渠道或未知聊天写明原因拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-reply-wx-http-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_cross_reply_2';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '小发' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '小发' }],
  });
  await ctx.plugin(FakeHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(approvalModule, { thinking: 'low', decision_pass: 0.8 });
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
  });
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  //M 不修改微信业务规矩：按 apply 同款方式挂载 Wechat 并接入 approval（send=true，该会话未开自动发），同时挂载 Cli。
  const wechat = new wechatModule.Wechat(ctx, wechatModule.checkConfig(ctx, { bot: '小发', interval_ms: 0, send: true }));
  wechat.reader.accounts = () => [{ id: 'acc1', nickname: '客服号', wxid: 'wxid_me' }];
  wechat.approval = ctx.approval;
  ctx.resources.db.query('INSERT INTO wechat_watch (account, chat, name, auto, last_time) VALUES (?, ?, ?, 0, 2000)')
    .run('acc1', 'wxid_zhang', '张总');
  const cliLines: string[] = [];
  new cliModule.Cli(ctx, {
    exit: () => undefined,
    write: (line) => {
      cliLines.push(line);
    },
  });

  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const feishuStub = stubFeishuClient(feishu, appId, { botOpenId: 'ou_bot' });

  //M 收集审批弹出记录与工具返回回执，校验微信草稿确认流程和错误提示。
  const askedApprovals: Array<{ kind: string; detail: string }> = [];
  ctx.on('approval/asked', (pending) => {
    askedApprovals.push({ kind: pending.kind, detail: pending.detail });
  });

  const receipts: channels.ReplyReceipt[] = [];
  let nextArgs: Record<string, string> = {};
  ctx.on('session/request', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      receipts.push(JSON.parse(piAi.contentText(last.content)) as channels.ReplyReceipt);
      request.answer = piAi.fauxAssistantMessage('完成');
      return;
    }
    const call = piAi.fauxToolCall('channel_reply', nextArgs);
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
  });

  //G 场景 2a：网页本人让给微信张总发消息 → 微信自认张总并落进 wechat_outbox 等审批，approval 收到 wechat-send 待确认。
  nextArgs = { text: '张总合同已看', channel: 'wechat', chat: '张总' };
  const wxId = await postWeb(ctx, { text: '在微信上跟张总说合同已看', bot: '小发' });
  await settledWeb(ctx, wxId);
  expect(receipts[0]?.ok).toBe(true);
  expect(receipts[0]?.status).toBe('sent');
  const outRow = ctx.resources.db.query('SELECT account, chat, text, state FROM wechat_outbox ORDER BY id DESC LIMIT 1')
    .get() as { account: string; chat: string; text: string; state: string } | null;
  expect(outRow).toEqual({ account: 'acc1', chat: 'wxid_zhang', text: '张总合同已看', state: 'waiting' });
  expect(askedApprovals).toHaveLength(1);
  expect(askedApprovals[0]?.kind).toBe('wechat-send');
  expect(askedApprovals[0]?.detail).toBe('张总合同已看');

  //G 场景 2b：飞书私聊本人让发到网页（传入“本机”）及命令行（“本机”）→ 各自认出聊天并写对目标，且不串回原飞书行。
  nextArgs = { text: '给网页留条备忘', channel: 'http', chat: '本机' };
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_owner_p2p_1',
      chat_id: 'oc_p2p_owner',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '在网页记一笔' }),
    },
  });
  await waitFor(() => receipts.length >= 2);
  await waitFrontIdle(ctx, '小发');
  expect(receipts[1]?.ok).toBe(true);
  expect(receipts[1]?.status).toBe('sent');

  const webListRes = await ctx.http.app.inject({ method: 'GET', url: '/api/messages?bot=小发&channel=http&chat=http:本机' });
  expect(webListRes.statusCode).toBe(200);
  const webList = webListRes.json() as { messages: Array<{ text: string; replies: Array<{ text: string }> }> };
  expect(webList.messages.some((item) => item.replies.some((rep) => rep.text === '给网页留条备忘'))).toBe(true);
  const feishuP2pRes = await ctx.http.app.inject({ method: 'GET', url: '/api/messages?bot=小发&channel=feishu&chat=oc_p2p_owner' });
  const feishuP2pList = feishuP2pRes.json() as { messages: Array<{ replies: Array<{ text: string }> }> };
  expect(feishuP2pList.messages[0]?.replies).toEqual([]);

  nextArgs = { text: '给终端打一句', channel: 'cli', chat: '本机' };
  const cliPostId = await postWeb(ctx, { text: '在命令行打印一句', bot: '小发' });
  await settledWeb(ctx, cliPostId);
  expect(receipts[2]?.ok).toBe(true);
  expect(cliLines).toContain('[小发] 给终端打一句');

  //G 场景 2c：未知渠道报“渠道 X 没挂”；各渠道未知聊天报“没有叫 X 的聊天”。
  nextArgs = { text: '去未知渠道', channel: 'slack', chat: 'c1' };
  const unknownChId = await postWeb(ctx, { text: '发去 slack', bot: '小发' });
  await settledWeb(ctx, unknownChId);
  expect(receipts[3]?.ok).toBe(false);
  expect(receipts[3]?.status).toBe('rejected');
  expect(receipts[3]?.reason).toContain('渠道 slack 没挂');

  const badTargets: Array<{ channel: string; chat: string }> = [
    { channel: 'feishu', chat: 'oc_not_exist' },
    { channel: 'wechat', chat: 'wxid_none' },
    { channel: 'http', chat: '不存在的网页' },
    { channel: 'cli', chat: '不存在的终端' },
  ];
  for (const [idx, badTarget] of badTargets.entries()) {
    nextArgs = { text: '去未知聊天', channel: badTarget.channel, chat: badTarget.chat };
    const reqId = await postWeb(ctx, { text: `找不存在聊天 ${badTarget.chat}`, bot: '小发' });
    await settledWeb(ctx, reqId);
    const rec = receipts[4 + idx];
    expect(rec?.ok).toBe(false);
    expect(rec?.status).toBe('rejected');
    expect(rec?.reason).toContain(`没有叫 ${badTarget.chat} 的聊天`);
  }
});


test('3. 外人（guest / builder / 微信客户）与群聊里的本人（含 trusted 群）指定别的渠道或别的聊天一律拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-reply-deny-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_cross_reply_3';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '小守' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '小守' }],
  });
  await ctx.plugin(FakeHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [
      { open_id: 'ou_owner', name: '老板', owner: true },
      { open_id: 'ou_builder', name: '共建者', role: 'builder', dir: 'builders/b1' },
      { open_id: 'ou_guest', name: '访客', role: 'guest' },
    ],
    groups: [
      { chat_id: 'oc_untrusted', listen: 'all', trusted: false },
      { chat_id: 'oc_trusted', listen: 'all', trusted: true },
    ],
  });
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const feishuStub = stubFeishuClient(feishu, appId, { botOpenId: 'ou_bot' });
  const members = new Map<string, string>([['ou_owner', '老板'], ['ou_builder', '共建者'], ['ou_guest', '访客']]);
  feishuStub.chats.set('oc_untrusted', { name: '公开外群', members, at: Date.now() });
  feishuStub.chats.set('oc_trusted', { name: '核心内部群', members, at: Date.now() });

  //M 先从网页建立一个样例消息供构造微信客户标准入站事件，同时让 http:本机 存在记录。
  const receipts: channels.ReplyReceipt[] = [];
  const emittedWeb: Array<{ message: channels.ChannelMessage }> = [];
  ctx.on('channel/message', (msg) => {
    emittedWeb.push({ message: msg });
  });

  let nextCallArgs: Record<string, string> | undefined;
  ctx.on('session/request', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      receipts.push(JSON.parse(piAi.contentText(last.content)) as channels.ReplyReceipt);
      request.answer = piAi.fauxAssistantMessage('收到阻断回执');
      return;
    }
    if (nextCallArgs === undefined) {
      const normalReply = piAi.fauxToolCall('channel_reply', { text: '预热网页' });
      request.answer = piAi.fauxAssistantMessage([normalReply], { stopReason: 'toolUse' });
      return;
    }
    const call = piAi.fauxToolCall('channel_reply', nextCallArgs);
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
  });

  const warmId = await postWeb(ctx, { text: '预热一条网页记录', bot: '小守' });
  await settledWeb(ctx, warmId);
  const sampleMsg = emittedWeb[0]!.message;
  //M 清空预热产生的工具回执，只从后续 5 次越权测试起记录。
  receipts.length = 0;

  //M 记录所有成功穿到目标渠道的 channel/reply 事件：以下 5 次越权调用都不该落到目标渠道。
  const reachedTargetChannels: string[] = [];
  ctx.on('channel/reply', (request) => {
    reachedTargetChannels.push(`${request.channel}:${request.sourceSnapshot.chatId}`);
  });

  //G 1) 飞书群 guest 指定往网页发话 → 拒绝并写明原因。
  nextCallArgs = { text: '越权发网页', channel: 'http', chat: 'http:本机' };
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest' }, sender_type: 'user' },
    message: {
      message_id: 'om_deny_guest',
      chat_id: 'oc_untrusted',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我在网页说一下' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小守' }],
    },
  });
  await waitFor(() => receipts.length >= 1);
  await waitFrontIdle(ctx, '小守');
  expect(receipts[0]?.ok).toBe(false);
  expect(receipts[0]?.status).toBe('rejected');
  expect(receipts[0]?.reason).toContain('forbidden');

  //G 2) 飞书私聊 builder 指定往飞书群发话 → 拒绝（非 owner 哪怕私聊也不能发别处）。
  nextCallArgs = { text: '共建者发群', channel: 'feishu', chat: 'oc_trusted' };
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_builder' }, sender_type: 'user' },
    message: {
      message_id: 'om_deny_builder',
      chat_id: 'oc_p2p_builder',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我在内部群说一下' }),
    },
  });
  await waitFor(() => receipts.length >= 2);
  await waitFrontIdle(ctx, '小守');
  expect(receipts[1]?.ok).toBe(false);
  expect(receipts[1]?.status).toBe('rejected');
  expect(receipts[1]?.reason).toContain('forbidden');

  //G 3) 微信客户（p2p 非 owner）指定往飞书群发话 → 拒绝。
  nextCallArgs = { text: '客户发飞书', channel: 'feishu', chat: 'oc_trusted' };
  const wxMsg = structuredClone(sampleMsg);
  wxMsg.messageId = channels.makeChannelMessageId('wechat', 'acc1', 'wx_in_1');
  wxMsg.nativeId = 'wx_in_1';
  wxMsg.channel = 'wechat';
  wxMsg.accountId = 'acc1';
  wxMsg.chatId = 'wxid_customer_1';
  wxMsg.chatType = 'p2p';
  wxMsg.role = 'guest';
  wxMsg.sender = { id: 'wxid_customer_1', name: '外部客户' };
  wxMsg.rawText = '帮我在飞书群说一声';
  wxMsg.text = '帮我在飞书群说一声';
  wxMsg.origin = {
    channel: 'wechat',
    address: { account: 'acc1', chat: 'wxid_customer_1', name: '外部客户', customer: 'wechat:wxid_customer_1' },
  };
  wxMsg.visibility = { scope: 'wechat:acc1:wxid_customer_1', trusted: true, publicSourceIds: [] };
  wxMsg.routing = { listenOnly: false, autoFinal: true };
  await ctx.serial('channel/message', wxMsg, { claims: [] });
  await waitFor(() => receipts.length >= 3);
  await waitFrontIdle(ctx, '小守');
  expect(receipts[2]?.ok).toBe(false);
  expect(receipts[2]?.status).toBe('rejected');
  expect(receipts[2]?.reason).toContain('forbidden');

  //G 4) 飞书普通群（trusted=false）里的本人 owner 指定往网页发话 → 拒绝且说明群聊禁止。
  nextCallArgs = { text: '群里让发网页', channel: 'http', chat: 'http:本机' };
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_deny_owner_group1',
      chat_id: 'oc_untrusted',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我在网页发一条' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小守' }],
    },
  });
  await waitFor(() => receipts.length >= 4);
  await waitFrontIdle(ctx, '小守');
  expect(receipts[3]?.ok).toBe(false);
  expect(receipts[3]?.status).toBe('rejected');
  expect(receipts[3]?.reason).toContain('forbidden');
  expect(receipts[3]?.reason).toContain('群聊');

  //G 5) 哪怕是 trusted=true 的内部群里的本人 owner，也不允许指定发去另一聊天。
  nextCallArgs = { text: '可信群让发他群', channel: 'feishu', chat: 'oc_untrusted' };
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_deny_owner_group2',
      chat_id: 'oc_trusted',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我在外群说一下' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小守' }],
    },
  });
  await waitFor(() => receipts.length >= 5);
  await waitFrontIdle(ctx, '小守');
  expect(receipts[4]?.ok).toBe(false);
  expect(receipts[4]?.status).toBe('rejected');
  expect(receipts[4]?.reason).toContain('forbidden');
  expect(receipts[4]?.reason).toContain('群聊');

  //M 以上 5 次跨渠道尝试全部被拦截，绝无任何一条到达目标渠道的 channel/reply。
  expect(reachedTargetChannels).toEqual([]);
});


test('4. 不写 channel 和 chat 时严格保持现状：网页带 view 看飞书群、网页引用飞书消息都只回网页不发飞书', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-reply-keep-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_cross_reply_4';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '小常' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '小常' }],
  });
  await ctx.plugin(FakeHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
    groups: [{ chat_id: 'oc_group_1', listen: 'all', trusted: false }],
  });
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const feishuStub = stubFeishuClient(feishu, appId, { botOpenId: 'ou_bot' });
  const members = new Map<string, string>([['ou_owner', '老板'], ['ou_guest', '路人甲']]);
  feishuStub.chats.set('oc_group_1', { name: '项目甲群', members, at: Date.now() });

  let replyText = '群里收到了';
  ctx.on('session/request', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      request.answer = piAi.fauxAssistantMessage('done');
      return;
    }
    const call = piAi.fauxToolCall('channel_reply', { text: replyText });
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
  });

  //M 先向飞书群注入一条入站消息，取得它在 web_messages 里的消息号作 reply_to 引用对象。
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest' }, sender_type: 'user' },
    message: {
      message_id: 'om_keep_1',
      chat_id: 'oc_group_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '群里有个问题' }),
    },
  });
  await waitFrontIdle(ctx, '小常');
  const feishuList = await ctx.http.app.inject({ method: 'GET', url: '/api/messages?bot=小常&channel=feishu&chat=oc_group_1' });
  expect(feishuList.statusCode).toBe(200);
  const quotedId = (feishuList.json() as { messages: Array<{ id: number }> }).messages[0]!.id;
  feishuStub.sent.length = 0;

  //G 场景 4a：网页带 view 看飞书群、不指定 channel/chat 回复 → 只回网页，不向飞书发出任何消息。
  replyText = '只是在网页回答你';
  const viewMsgId = await postWeb(ctx, {
    text: '这个群刚说了啥',
    bot: '小常',
    view: { channel: 'feishu', chat: 'oc_group_1' },
  });
  const viewRes = await settledWeb(ctx, viewMsgId);
  expect(viewRes.replies.map((item) => item.text)).toEqual(['只是在网页回答你']);
  expect(feishuStub.sent).toEqual([]);

  //G 场景 4b：网页引用飞书群消息发话、不指定 channel/chat 回复 → 仍只回网页这一条，不进飞书群（保持 #144 a）。
  replyText = '引用后仍在网页回';
  const quoteMsgId = await postWeb(ctx, {
    text: '按他说的改一下',
    reply_to: quotedId,
  });
  const quoteRes = await settledWeb(ctx, quoteMsgId);
  expect(quoteRes.replies.map((item) => item.text)).toEqual(['引用后仍在网页回']);
  expect(feishuStub.sent).toEqual([]);
});
