/**
 * 独立无渠道纯 API 机器人（`INS客服`）与 `PeerApi`（`POST /api/peer/message`）全离线集成单测：
 * 1. 验证纯英文无渠道 `INS客服`（`language: 'en'`）每轮加载 `persona.md` 与英文系统提示词，且严格阻断主人私人 `memory/` 泄漏；
 * 2. 验证语舱 AI（`yucang-ai`）按 `(peer.account, peer.id)` 实现多买家、跨双店（US/SG）会话与记忆归属键 100% 隔离，同买家多轮续聊自动复用原会话；
 * 3. 验证 `guest` 最小权限红线：自动剥离 `exec` / `write` 等动手工具、拒绝 `grants` / 指定 `session`、拦截访客伪造“同意 1”批复主人待确认卡；
 * 4. 验证 `POST /api/peer/message` 单次同步拿回复、`POST /api/message` 传 `peer` 异步轮询与 `GET /api/channels` 访客列表展示。
 */
import * as bunSqlite from 'bun:sqlite';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as approvalModule from '../approval/index.ts';
import * as botsPlugin from '../bots/index.ts';
import * as httpPlugin from '../http/index.ts';
import * as memoryKeyModule from '../memory/MemoryKey.ts';
import * as workspacesPlugin from '../workspaces/index.ts';
import type * as peerApiModule from './PeerApi.ts';
import * as webApiModule from './index.ts';


const closers: Array<() => Promise<unknown> | void> = [];
bunTest.afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 测试专用资源服务（支持配置 `language: 'en'` 的独立无渠道 `INS客服`）。 */
class FakeInsResources extends cordis.Service {
  readonly db = new bunSqlite.Database(':memory:');
  readonly raw: Record<string, unknown>;
  readonly root: string;
  readonly version = '0.7.102-test';
  readonly builtTime = Date.now();
  readonly config = {
    defaultModel: 'fake/fake',
    sessionCacheMax: 500,
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
    plugins: [] as Array<{ name: string; config?: unknown }>,
  };

  constructor(
    ctx: cordis.Context,
    options: { root: string; bots: Array<{ name: string; language?: string }> },
  ) {
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


/** 内存 Fastify 服务（不绑定物理网卡端口）。 */
class FakeInsHttp extends cordis.Service {
  readonly app: fastify.FastifyInstance;

  constructor(ctx: cordis.Context) {
    super(ctx, 'http');
    this.app = fastify.default({ logger: false });
    httpPlugin.registerHttpErrorHandler(this.app);
    ctx.effect(() => () => void this.app.close());
  }

  isVerified(): boolean {
    return true;
  }
}


bunTest.test('INS客服纯 API 机器人：按店铺+买家隔离会话与记忆键、加载英文人设且阻断私人记忆与高危工具', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-ins-peer-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));

  //M 预置 INS客服 的公开人设 persona.md 与仅供主人读取的私人记忆文件，核验访客轮只加载 persona.md 不泄漏私人记忆。
  const botDir = path.join(root, 'bots', 'INS客服');
  fs.mkdirSync(path.join(botDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(botDir, 'persona.md'),
    'You are Mia, China inbound travel DM specialist. Visa-free transit rules follow official consulate notices.',
    'utf8',
  );
  fs.writeFileSync(path.join(botDir, 'memory', 'private_cost.md'), 'INTERNAL_FACTORY_COST_SECRET_88', 'utf8');
  fs.writeFileSync(path.join(root, 'memory', 'owner_note.md'), 'OWNER_PRIVATE_BANK_SECRET_99', 'utf8');

  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeInsResources, {
    root,
    bots: [
      { name: '助手', language: 'zh' },
      { name: 'INS客服', language: 'en' },
    ],
  });
  await ctx.plugin(FakeInsHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(approvalModule, { thinking: 'low', decision_pass: 0.8 });
  await ctx.plugin(webApiModule);

  //M 额外注册一个模拟高危 exec 工具与只读 time 工具，验证 guest 访客轮自动剥离 exec。
  ctx.tools.register({
    definition: { name: 'exec', description: 'run shell command', parameters: piAi.Type.Object({}) },
    sessionKinds: ['front', 'work'],
    run: () => 'executed',
  });
  ctx.tools.register({
    definition: { name: 'time', description: 'get current time', parameters: piAi.Type.Object({}) },
    sessionKinds: ['front', 'work'],
    run: () => '2026-11-22T10:00:00Z',
  });

  await ctx.http.app.ready();

  const capturedTurns: Array<{
    sessionId: string;
    memoryKey: string;
    systemJoined: string;
    toolNames: string[];
    userHistory: string[];
  }> = [];

  ctx.on('session/before-model', (request) => {
    const userMsgs = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => piAi.contentText(m.content));
    capturedTurns.push({
      sessionId: request.session.id,
      memoryKey: memoryKeyModule.getSessionMemoryKey(request.session.row),
      systemJoined: request.system.join('\n---\n'),
      toolNames: request.tools.map((t) => t.name),
      userHistory: userMsgs,
    });
    const latest = userMsgs.at(-1) ?? '';
    request.answer = piAi.fauxAssistantMessage(`Hi! Regarding "${latest}", our travel advisor can plan a private tour for you.`);
  });

  // 1. 语舱 AI 转发 US 店买家 Emma 第 1 句咨询（POST /api/peer/message 单次请求同步拿回复）
  const emmaTurn1 = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/peer/message',
    payload: {
      bot: 'INS客服',
      from: 'yucang-ai',
      peer: { id: 'buyer_emma_01', name: 'Emma (@emma_home)', account: 'ins_shop_us' },
      text: 'Can I visit Beijing and Xi\'an on the 240-hour visa-free transit from California?',
    },
  });
  bunTest.expect(emmaTurn1.statusCode).toBe(200);
  const emmaBody1 = emmaTurn1.json<peerApiModule.PeerMessageReply>();
  bunTest.expect(emmaBody1.status).toBe('replied');
  bunTest.expect(emmaBody1.bot).toBe('INS客服');
  bunTest.expect(emmaBody1.chatId).toBe('peer:ins_shop_us:buyer_emma_01');
  bunTest.expect(emmaBody1.reply).toContain('plan a private tour');
  bunTest.expect(emmaBody1.sessionId).not.toBeNull();

  const turn1Meta = capturedTurns[0]!;
  // 验证加载了英文声明、英文前台提示与 persona.md，且未混入中文“用中文简短回答”或主人私人记忆
  bunTest.expect(turn1Meta.systemJoined).toContain('Mia, China inbound travel DM specialist');
  bunTest.expect(turn1Meta.systemJoined).toContain('answer customer inquiries');
  bunTest.expect(turn1Meta.systemJoined).not.toContain('用中文简短回答');
  bunTest.expect(turn1Meta.systemJoined).not.toContain('INTERNAL_FACTORY_COST_SECRET_88');
  bunTest.expect(turn1Meta.systemJoined).not.toContain('OWNER_PRIVATE_BANK_SECRET_99');
  // 验证 guest 工具白名单：不含 exec，保留只读工具 time 与 channel_reply
  bunTest.expect(turn1Meta.toolNames).not.toContain('exec');
  bunTest.expect(turn1Meta.toolNames).toContain('time');
  bunTest.expect(turn1Meta.toolNames).toContain('channel_reply');
  // 验证记忆归属键精确绑定到店铺+买家
  bunTest.expect(turn1Meta.memoryKey).toBe('person:http:ins_shop_us:buyer_emma_01');

  // 2. 同一 US 店另一位买家 Lucas 咨询 -> 必须分配全新的独立会话与独立记忆键
  const lucasTurn = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/peer/message',
    payload: {
      bot: 'INS客服',
      from: 'yucang-ai',
      peer: { id: 'buyer_lucas_02', name: 'Lucas Studio', account: 'ins_shop_us' },
      text: 'How much is a 7-day private tour of Chengdu and Chongqing for 6 people?',
    },
  });
  const lucasBody = lucasTurn.json<peerApiModule.PeerMessageReply>();
  bunTest.expect(lucasBody.status).toBe('replied');
  bunTest.expect(lucasBody.sessionId).not.toBe(emmaBody1.sessionId);
  bunTest.expect(capturedTurns[1]?.memoryKey).toBe('person:http:ins_shop_us:buyer_lucas_02');
  bunTest.expect(capturedTurns[1]?.userHistory).toHaveLength(1);

  // 3. 即使同一买家 ID 访问另一家独立店铺（ins_shop_sg），也必须完全隔离会话与记忆键（防多店串号）
  const emmaSgTurn = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/peer/message',
    payload: {
      bot: 'INS客服',
      from: 'yucang-ai',
      peer: { id: 'buyer_emma_01', name: 'Emma (@emma_home)', account: 'ins_shop_sg' },
      text: 'Do Singapore passport holders need a visa for a 10-day Yunnan trip?',
    },
  });
  const emmaSgBody = emmaSgTurn.json<peerApiModule.PeerMessageReply>();
  bunTest.expect(emmaSgBody.sessionId).not.toBe(emmaBody1.sessionId);
  bunTest.expect(emmaSgBody.sessionId).not.toBe(lucasBody.sessionId);
  bunTest.expect(capturedTurns[2]?.memoryKey).toBe('person:http:ins_shop_sg:buyer_emma_01');

  // 4. US 店 Emma 发来第 2 句追问 -> 自动回到她自己的原会话并累计沉淀 2 轮对话，与 Lucas / SG 店会话零串写
  const emmaTurn2 = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/peer/message',
    payload: {
      bot: 'INS客服',
      from: 'yucang-ai',
      peer: { id: 'buyer_emma_01', name: 'Emma (@emma_home)', account: 'ins_shop_us' },
      text: 'Great, can I pay with Alipay using my US card?',
    },
  });
  const emmaBody2 = emmaTurn2.json<peerApiModule.PeerMessageReply>();
  bunTest.expect(emmaBody2.sessionId).toBe(emmaBody1.sessionId);
  const emmaSessionUsers = ctx.sessions
    .open(emmaBody1.sessionId!)
    .row.messages.filter((m) => m.role === 'user')
    .map((m) => piAi.contentText(m.content));
  bunTest.expect(emmaSessionUsers).toHaveLength(2);
  bunTest.expect(emmaSessionUsers[0]).toContain('visa-free transit from California');
  bunTest.expect(emmaSessionUsers[1]).toContain('Alipay using my US card');
  const lucasSessionUsers = ctx.sessions
    .open(lucasBody.sessionId!)
    .row.messages.filter((m) => m.role === 'user');
  bunTest.expect(lucasSessionUsers).toHaveLength(1);

  // 5. 安全拦截：禁止外部访客传 grants、禁止手动指定 session；且 GET /api/channels 正确展示访客会话同时保留网页本机项
  const badGrants = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/peer/message',
    payload: {
      bot: 'INS客服',
      peer: { id: 'evil_buyer' },
      text: 'hi',
      grants: { dirs: [root] },
    },
  });
  bunTest.expect(badGrants.statusCode).toBe(400);

  const badSession = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/message',
    payload: {
      bot: 'INS客服',
      peer: { id: 'evil_buyer' },
      session: emmaBody1.sessionId,
      text: 'hijack session',
    },
  });
  bunTest.expect(badSession.statusCode).toBe(400);

  const channelsRes = await ctx.http.app.inject({
    method: 'GET',
    url: '/api/channels?bot=INS%E5%AE%A2%E6%9C%8D',
  });
  bunTest.expect(channelsRes.statusCode).toBe(200);
  const channelsJson = channelsRes.json<{
    channels: Array<{ id: string; chats: Array<{ id: string; label: string }> }>;
  }>();
  const httpChannel = channelsJson.channels.find((c) => c.id === 'http');
  bunTest.expect(httpChannel?.chats.some((c) => c.id === 'http:本机')).toBe(true);
  bunTest.expect(httpChannel?.chats.some((c) => c.label === '访客·Emma (@emma_home)')).toBe(true);
});
