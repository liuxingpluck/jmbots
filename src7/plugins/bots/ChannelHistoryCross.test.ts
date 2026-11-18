/**
 * 渠道历史跨渠道查询与各渠道应答端到端离线验证（B 块）：
 *   1. 默认条数 80（描述写明“一般 50–100 条够用，自己定”）、before 游标翻页与条数上限 200；
 *   2. 本人（owner）从网页或飞书会话跨渠道查询微信、网页、命令行、飞书历史，含附件脱敏（不泄漏本机路径）与预留 view 默认入口；
 *   3. 外人（guest / builder / 微信客户）跨渠道或指定其他聊天被直接拒绝并说明原因，且直接发 channel/history 事件也无法绕过权限防线。
 *
 * 跑法：bun test ./src7/plugins/bots/ChannelHistoryCross.test.ts
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
import * as cliModule from '../cli/index.ts';
import * as feishuModule from '../feishu/index.ts';
import * as webApiModule from '../web-api/index.ts';
import * as wechatModule from '../wechat/index.ts';
import * as workspacesPlugin from '../workspaces/index.ts';
import * as botsPlugin from './index.ts';


//M 每个测例后自动释放插件与临时目录。
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
  readonly version = '0.7.39-test';
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
}


/** 等待条件满足，最多 3 秒。 */
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等待超时：条件未在 3 秒内成立');
}


/** 桩化飞书客户端，拦截真实网络调用并支持注入入站消息。 */
function stubFeishuClient(
  feishu: feishuModule.Feishu,
  appId: string,
  options?: { botOpenId?: string },
): { triggerInbound: (data: unknown) => Promise<void> } {
  const inside = feishu as unknown as {
    apps: Map<string, {
      botOpenId?: string;
      client: { im: { v1: Record<string, unknown> } };
    }>;
    chats: Map<string, unknown>;
    onMessage: (appId: string, data: unknown) => Promise<void>;
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
    reply: () => Promise.resolve({ code: 0, data: { message_id: nextId() } }),
    create: () => Promise.resolve({ code: 0, data: { message_id: nextId() } }),
  };

  const members = new Map<string, string>([['ou_owner', '老板'], ['ou_guest', '访客'], ['ou_builder', '共建']]);
  inside.chats.set('oc_chat_1', { name: '测试主群', members, at: Date.now() });
  inside.chats.set('oc_other_chat', { name: '机密备忘群', members, at: Date.now() });

  return {
    triggerInbound: (data: unknown) => inside.onMessage(appId, data),
  };
}


/** 往测试数据库 wechat_messages 写入一条模拟记录。 */
function insertWechatMsg(
  db: Database,
  input: {
    account: string;
    chat: string;
    localId: number;
    at: number;
    fromSelf: number;
    kind: string;
    sender: string;
    text: string;
    view?: Record<string, unknown>;
  },
): void {
  const viewJson = JSON.stringify(input.view ?? { kind: input.kind, text: input.text, sender: input.sender });
  db.query(
    'INSERT INTO wechat_messages (account, chat, source, local_id, at, from_self, kind, sender, text, view) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(input.account, input.chat, 'm0', input.localId, input.at, input.fromSelf, input.kind, input.sender, input.text, viewJson);
}


test('1. channel_history 默认条数 80、工具说明含 50–100 提示且支持 before 游标翻页与 200 上限', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hist-80-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources, { root, bots: [{ name: '小史' }] });
  await ctx.plugin(FakeHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  const wechat = new wechatModule.Wechat(ctx, wechatModule.checkConfig(ctx, { bot: '小史', interval_ms: 0, send: false }));
  wechat.reader.accounts = () => [{ id: 'acc1', nickname: '客服号', wxid: 'wxid_me' }];

  //M 校验未配 history_limit 时描述包含默认 80 与“一般 50–100 条够用，自己定”。
  const frontTools = ctx.tools.list('front');
  const historyTool = frontTools.find((item) => item.name === 'channel_history');
  expect(historyTool?.description).toContain('80');
  expect(historyTool?.description).toContain('一般 50–100 条够用');

  //M 写入 210 条微信消息：验证不传 limit 默认 80、游标翻页、以及显式 limit=200 与越限 250 被拦。
  for (let i = 1; i <= 210; i += 1) {
    insertWechatMsg(ctx.resources.db, {
      account: 'acc1',
      chat: 'wxid_page',
      localId: i,
      at: 1_700_000_000 + i,
      fromSelf: 0,
      kind: 'text',
      sender: '客户甲',
      text: `微信第${String(i)}条`,
    });
  }

  let phase: 'default80' | 'cursor' | 'limit200' = 'default80';
  let cursorToUse = '';
  const captured: channels.ChannelHistoryResult[] = [];
  ctx.on('session/request', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      captured.push(JSON.parse(piAi.contentText(last.content)) as channels.ChannelHistoryResult);
      request.answer = piAi.fauxAssistantMessage('已读取历史');
      return;
    }
    if (phase === 'default80') {
      const call = piAi.fauxToolCall('channel_history', { channel: 'wechat', chat: 'wxid_page' });
      request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
      return;
    }
    if (phase === 'cursor') {
      const call = piAi.fauxToolCall('channel_history', { channel: 'wechat', chat: 'wxid_page', before: cursorToUse });
      request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
      return;
    }
    const call = piAi.fauxToolCall('channel_history', { channel: 'wechat', chat: 'wxid_page', limit: 200 });
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
  });

  //M 1) 网页发话触发默认 80 条查询。
  await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload: { text: '查默认条数', bot: '小史' } });
  await waitFor(() => captured.length >= 1);
  expect(captured[0]?.ok).toBe(true);
  expect(captured[0]?.items).toHaveLength(80);
  expect(captured[0]?.items[0]?.text).toBe('微信第131条');
  expect(captured[0]?.items[79]?.text).toBe('微信第210条');
  expect(captured[0]?.nextCursor).not.toBeNull();
  cursorToUse = captured[0]?.nextCursor ?? '';

  //M 2) 翻上一页拿到前 80 条（第 51..130 条）。
  phase = 'cursor';
  await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload: { text: '翻上一页', bot: '小史' } });
  await waitFor(() => captured.length >= 2);
  expect(captured[1]?.ok).toBe(true);
  expect(captured[1]?.items).toHaveLength(80);
  expect(captured[1]?.items[0]?.text).toBe('微信第51条');
  expect(captured[1]?.items[79]?.text).toBe('微信第130条');
  expect(captured[1]?.nextCursor).not.toBeNull();

  //M 3) limit=200 返回最新 200 条且有下一页游标。
  phase = 'limit200';
  await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload: { text: '取两百条', bot: '小史' } });
  await waitFor(() => captured.length >= 3);
  expect(captured[2]?.ok).toBe(true);
  expect(captured[2]?.items).toHaveLength(200);
  expect(captured[2]?.items[0]?.text).toBe('微信第11条');
  expect(captured[2]?.items[199]?.text).toBe('微信第210条');
  expect(captured[2]?.nextCursor).not.toBeNull();

  //M 4) 超过 200 的 limit 被工具入参校验直接拒绝。
  const frontMeta = ctx.sessions.find({ kind: 'front', bot: '小史' })[0]!;
  const frontSession = ctx.sessions.open(frontMeta.id);
  frontSession.row.state = 'running';
  const overLimit = await ctx.tools.execute(
    { type: 'toolCall', id: 'c_over', name: 'channel_history', arguments: { channel: 'wechat', chat: 'wxid_page', limit: 250 } },
    frontSession,
    new AbortController().signal,
  );
  frontSession.row.state = 'done';
  expect(overLimit.isError).toBe(true);
});


test('2. 本人跨渠道取微信/网页/命令行/飞书历史（含附件脱敏与预留 view 默认入口）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hist-cross-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_aaaabbbbccccdddd';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '小跨' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '小跨' }],
  });
  await ctx.plugin(FakeHttp);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
    groups: [
      { chat_id: 'oc_chat_1', listen: 'all', trusted: false },
      { chat_id: 'oc_other_chat', listen: 'all', trusted: false },
    ],
  });
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  const wechat = new wechatModule.Wechat(ctx, wechatModule.checkConfig(ctx, { bot: '小跨', interval_ms: 0, send: false }));
  wechat.reader.accounts = () => [{ id: 'acc1', nickname: '客服号', wxid: 'wxid_me' }];
  const cli = new cliModule.Cli(ctx, { exit: () => undefined, write: () => undefined });
  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const feishuStub = stubFeishuClient(feishu, appId, { botOpenId: 'ou_bot' });

  //M 预置微信消息（含对方文字、自己发文字、图片消息）和会话名。
  ctx.resources.db.query('INSERT INTO wechat_sync (account, chat, name, is_group, last_time) VALUES (?, ?, ?, 0, 2000)')
    .run('acc1', 'wxid_c1', '大客户张总');
  insertWechatMsg(ctx.resources.db, {
    account: 'acc1', chat: 'wxid_c1', localId: 1, at: 1_700_001_000, fromSelf: 0, kind: 'text', sender: '', text: '报价单发我一下',
  });
  insertWechatMsg(ctx.resources.db, {
    account: 'acc1', chat: 'wxid_c1', localId: 2, at: 1_700_001_010, fromSelf: 1, kind: 'text', sender: '', text: '好的马上整理',
  });
  insertWechatMsg(ctx.resources.db, {
    account: 'acc1',
    chat: 'wxid_c1',
    localId: 3,
    at: 1_700_001_020,
    fromSelf: 0,
    kind: 'image',
    sender: '',
    text: '[图片]',
    view: { kind: 'image', title: '合同截图.png' },
  });

  //M 预置飞书两个群的历史消息。
  let stepMode: 'plain' | 'web_to_wechat' | 'web_to_cli' | 'web_to_feishu' | 'feishu_to_http' | 'feishu_to_other_group' | 'web_with_view' = 'plain';
  const historyResults: channels.ChannelHistoryResult[] = [];
  ctx.on('session/request', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      if (last.toolName === 'channel_history') {
        const parsed = JSON.parse(piAi.contentText(last.content)) as channels.ChannelHistoryResult;
        historyResults.push(parsed);
        if (request.tools.some((tool) => tool.name === 'channel_reply')) {
          const replyCall = piAi.fauxToolCall('channel_reply', { text: '跨渠道查询完成' });
          request.answer = piAi.fauxAssistantMessage([replyCall], { stopReason: 'toolUse' });
          return;
        }
      }
      request.answer = piAi.fauxAssistantMessage('跨渠道查询完成');
      return;
    }

    if (stepMode === 'plain') {
      if (request.tools.some((tool) => tool.name === 'channel_reply')) {
        const replyCall = piAi.fauxToolCall('channel_reply', { text: '收到' });
        request.answer = piAi.fauxAssistantMessage([replyCall], { stopReason: 'toolUse' });
        return;
      }
      request.answer = piAi.fauxAssistantMessage('网页已记录这条消息');
      return;
    }
    if (stepMode === 'web_to_wechat') {
      const call = piAi.fauxToolCall('channel_history', { channel: 'wechat', chat: 'wxid_c1' });
      request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
      return;
    }
    if (stepMode === 'web_to_cli') {
      const call = piAi.fauxToolCall('channel_history', { channel: 'cli' });
      request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
      return;
    }
    if (stepMode === 'web_to_feishu') {
      const call = piAi.fauxToolCall('channel_history', { channel: 'feishu', chat: 'oc_chat_1' });
      request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
      return;
    }
    if (stepMode === 'feishu_to_http') {
      const call = piAi.fauxToolCall('channel_history', { channel: 'http' });
      request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
      return;
    }
    if (stepMode === 'feishu_to_other_group') {
      const call = piAi.fauxToolCall('channel_history', { chat: 'oc_other_chat' });
      request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
      return;
    }
    const call = piAi.fauxToolCall('channel_history', {});
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
  });

  const crossSessionsIdle = (): boolean => ctx.sessions
    .find({ kind: 'front', bot: '小跨' })
    .every((s) => s.state !== 'running' && s.activeKey === undefined);

  //M 预置命令行一条消息、飞书两群消息、网页一条带图片附件消息。
  await cli.submitLine('小跨', '命令行巡检一次');
  await waitFor(crossSessionsIdle);

  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_fs_g1',
      chat_id: 'oc_chat_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '主群通知：下午两点开会' }),
    },
  });
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_fs_g2',
      chat_id: 'oc_other_chat',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '备忘群：记得归档合同' }),
    },
  });
  await waitFor(crossSessionsIdle);

  const pngBytes = Buffer.from('fake-png-content').toString('base64');
  const postWeb = await ctx.http.app.inject({
    method: 'POST',
    url: '/api/message',
    payload: {
      text: '这是网页端上传的截图',
      bot: '小跨',
      images: [{ name: '需求截图.png', data: pngBytes }],
    },
  });
  expect(postWeb.statusCode).toBe(200);
  const webMsgId = (postWeb.json() as { id: number }).id;
  await waitFor(() => {
    const row = ctx.resources.db.query('SELECT status FROM web_messages WHERE id = ?').get(webMsgId) as { status: string } | null;
    return row?.status === 'replied' && crossSessionsIdle();
  });

  //M 1) 网页本人跨渠道查微信（含双向方向与图片脱敏）。
  stepMode = 'web_to_wechat';
  await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload: { text: '帮我看微信', bot: '小跨' } });
  await waitFor(() => historyResults.length >= 1 && crossSessionsIdle());
  const wxRes = historyResults[0]!;
  expect(wxRes.ok).toBe(true);
  expect(wxRes.scope).toBe('wechat:acc1:wxid_c1');
  expect(wxRes.items).toHaveLength(3);
  expect(wxRes.items[0]?.direction).toBe('user');
  expect(wxRes.items[0]?.sender.name).toBe('大客户张总');
  expect(wxRes.items[1]?.direction).toBe('bot');
  expect(wxRes.items[1]?.sender.name).toBe('我');
  expect(wxRes.items[2]?.attachments).toHaveLength(1);
  expect(wxRes.items[2]?.attachments[0]?.name).toBe('合同截图.png');

  //M 2) 网页本人跨渠道查命令行。
  stepMode = 'web_to_cli';
  await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload: { text: '帮我看命令行', bot: '小跨' } });
  await waitFor(() => historyResults.length >= 2 && crossSessionsIdle());
  const cliRes = historyResults[1]!;
  expect(cliRes.ok).toBe(true);
  expect(cliRes.scope).toBe('cli:local:cli:本机');
  expect(cliRes.items.some((item) => item.text === '命令行巡检一次')).toBe(true);

  //M 3) 网页本人跨渠道查飞书主群。
  stepMode = 'web_to_feishu';
  await ctx.http.app.inject({ method: 'POST', url: '/api/message', payload: { text: '帮我看飞书', bot: '小跨' } });
  await waitFor(() => historyResults.length >= 3 && crossSessionsIdle());
  const fsRes = historyResults[2]!;
  expect(fsRes.ok).toBe(true);
  expect(fsRes.scope).toBe(`feishu:${appId}:oc_chat_1`);
  expect(fsRes.items.some((item) => item.text.includes('下午两点开会'))).toBe(true);

  //M 4) 飞书本人在私聊里跨渠道查网页（群里不许跨，见第 3 条测试）：拿到用户消息、机器人回复及脱敏附件，绝不暴露临时工作区绝对路径。
  stepMode = 'feishu_to_http';
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_fs_ask_http',
      chat_id: 'oc_p2p_owner',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '查网页记录' }),
    },
  });
  await waitFor(() => historyResults.length >= 4 && crossSessionsIdle());
  const httpRes = historyResults[3]!;
  expect(httpRes.ok).toBe(true);
  expect(httpRes.scope).toBe('http:local:http:本机');
  const uploadedItem = httpRes.items.find((item) => item.text.includes('这是网页端上传的截图'));
  expect(uploadedItem).toBeDefined();
  expect(uploadedItem?.attachments).toHaveLength(1);
  expect(uploadedItem?.attachments[0]?.name).toContain('需求截图.png');
  expect(uploadedItem?.attachments[0]?.state).toBe('available');
  expect(JSON.stringify(httpRes.items)).not.toContain(root);
  //M 网页 1.1.3 起是 channel_tool：plain 模式下假模型有 channel_reply 就用它回“收到”，网页那条的回话就是它。
  expect(httpRes.items.some((item) => item.direction === 'bot' && item.text === '收到')).toBe(true);

  //M 5) 飞书本人在私聊里查另一个群。
  stepMode = 'feishu_to_other_group';
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_fs_ask_other',
      chat_id: 'oc_p2p_owner',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '查备忘群' }),
    },
  });
  await waitFor(() => historyResults.length >= 5 && crossSessionsIdle());
  const otherGroupRes = historyResults[4]!;
  expect(otherGroupRes.ok).toBe(true);
  expect(otherGroupRes.items.some((item) => item.text.includes('记得归档合同'))).toBe(true);

  //M 6) 验证预留的 view 默认入口：模拟 131 传入 view={ channel: 'wechat', chat: 'wxid_c1' }，不传参调用自动取微信聊天。
  stepMode = 'web_with_view';
  const httpFrontMeta = ctx.sessions.find({ kind: 'front', bot: '小跨', customer: 'http:本机' })[0]!;
  const httpFront = ctx.sessions.open(httpFrontMeta.id);
  httpFront.row.channel = 'http';
  httpFront.row.address = { messageId: webMsgId, customer: 'http:本机', view: { channel: 'wechat', chat: 'wxid_c1' } };
  httpFront.row.state = 'running';
  const viewExec = await ctx.tools.execute(
    { type: 'toolCall', id: 'c_view', name: 'channel_history', arguments: {} },
    httpFront,
    new AbortController().signal,
  );
  httpFront.row.state = 'done';
  expect(viewExec.isError).toBe(false);
  const viewRes = JSON.parse(viewExec.text) as channels.ChannelHistoryResult;
  expect(viewRes.ok).toBe(true);
  expect(viewRes.scope).toBe('wechat:acc1:wxid_c1');
  expect(viewRes.items.some((item) => item.text === '报价单发我一下')).toBe(true);
});


test('3. 外人（guest / builder / 微信客户）跨渠道或指定其他聊天直接拒，且直发事件同样被拦', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hist-deny-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_5555666677778888';
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
      { chat_id: 'oc_chat_1', listen: 'all', trusted: false },
      { chat_id: 'oc_other_chat', listen: 'all', trusted: false },
    ],
  });
  await ctx.plugin(webApiModule);
  await ctx.http.app.ready();

  const wechat = new wechatModule.Wechat(ctx, wechatModule.checkConfig(ctx, { bot: '小守', interval_ms: 0, send: false }));
  wechat.reader.accounts = () => [{ id: 'acc1', nickname: '客服号', wxid: 'wxid_me' }];
  new cliModule.Cli(ctx, { exit: () => undefined, write: () => undefined });
  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const feishuStub = stubFeishuClient(feishu, appId, { botOpenId: 'ou_bot' });

  insertWechatMsg(ctx.resources.db, {
    account: 'acc1', chat: 'wxid_c1', localId: 1, at: 1_700_002_000, fromSelf: 0, kind: 'text', sender: '客户1', text: '客户1私聊',
  });
  insertWechatMsg(ctx.resources.db, {
    account: 'acc1', chat: 'wxid_other', localId: 1, at: 1_700_002_001, fromSelf: 0, kind: 'text', sender: '客户2', text: '绝密他人消息',
  });

  //M 先写入飞书测试主群一条当前消息与另一群一条机密消息。
  const results: channels.ChannelHistoryResult[] = [];
  let nextArgs: Record<string, string | number | boolean> = {};
  let captureActive = false;
  const denySessionsIdle = (): boolean => ctx.sessions
    .find({ kind: 'front', bot: '小守' })
    .every((s) => s.state !== 'running' && s.activeKey === undefined);

  ctx.on('session/request', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      if (last.toolName === 'channel_history') {
        results.push(JSON.parse(piAi.contentText(last.content)) as channels.ChannelHistoryResult);
        const replyCall = piAi.fauxToolCall('channel_reply', { text: '已拦截或完成' });
        request.answer = piAi.fauxAssistantMessage([replyCall], { stopReason: 'toolUse' });
        return;
      }
      request.answer = piAi.fauxAssistantMessage('已拦截或完成');
      return;
    }
    if (!captureActive) {
      const seedReply = piAi.fauxToolCall('channel_reply', { text: '已记录' });
      request.answer = piAi.fauxAssistantMessage([seedReply], { stopReason: 'toolUse' });
      return;
    }
    const call = piAi.fauxToolCall('channel_history', nextArgs);
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
  });

  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_sec_other',
      chat_id: 'oc_other_chat',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '机密群记录' }),
    },
  });
  await waitFor(denySessionsIdle);
  captureActive = true;

  //M 1) guest 在 oc_chat_1 指定别的聊天 oc_other_chat → 被拒。
  nextArgs = { chat: 'oc_other_chat' };
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest' }, sender_type: 'user' },
    message: {
      message_id: 'om_sec_1',
      chat_id: 'oc_chat_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 看机密群' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小守' }],
    },
  });
  await waitFor(() => results.length >= 1 && denySessionsIdle());
  expect(results[0]?.ok).toBe(false);
  expect(results[0]?.error?.code).toBe('forbidden');
  expect(results[0]?.error?.message).toContain('外人');

  //M 2) guest 在 oc_chat_1 跨渠道查微信 → 被拒。
  nextArgs = { channel: 'wechat', chat: 'wxid_c1' };
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest' }, sender_type: 'user' },
    message: {
      message_id: 'om_sec_2',
      chat_id: 'oc_chat_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 看微信' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小守' }],
    },
  });
  await waitFor(() => results.length >= 2 && denySessionsIdle());
  expect(results[1]?.ok).toBe(false);
  expect(results[1]?.error?.code).toBe('forbidden');
  expect(results[1]?.error?.message).toContain('跨渠道');

  //M 3) builder 跨渠道查网页 → 被拒；查当前聊天 oc_chat_1 → 允许。
  nextArgs = { channel: 'http' };
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_builder' }, sender_type: 'user' },
    message: {
      message_id: 'om_sec_3',
      chat_id: 'oc_chat_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 看网页' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小守' }],
    },
  });
  await waitFor(() => results.length >= 3 && denySessionsIdle());
  expect(results[2]?.ok).toBe(false);
  expect(results[2]?.error?.code).toBe('forbidden');

  nextArgs = {};
  await feishuStub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest' }, sender_type: 'user' },
    message: {
      message_id: 'om_sec_4',
      chat_id: 'oc_chat_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 看本群' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小守' }],
    },
  });
  await waitFor(() => results.length >= 4 && denySessionsIdle());
  expect(results[3]?.ok).toBe(true);
  expect(results[3]?.scope).toBe(`feishu:${appId}:oc_chat_1`);

  //M 4) 微信客户（非 owner）查自己聊天允许，指定别人微信聊天或跨渠道查网页一律被拒。
  const wxSession = ctx.sessions.create({ bot: '小守', kind: 'front', customer: 'wechat:wxid_c1' });
  wxSession.row.channel = 'wechat';
  wxSession.row.address = { account: 'acc1', chat: 'wxid_c1', name: '客户1', customer: 'wechat:wxid_c1' };
  wxSession.row.state = 'running';

  const wxOwnExec = await ctx.tools.execute(
    { type: 'toolCall', id: 'wx_own', name: 'channel_history', arguments: {} },
    wxSession,
    new AbortController().signal,
  );
  const wxOwnRes = JSON.parse(wxOwnExec.text) as channels.ChannelHistoryResult;
  expect(wxOwnRes.ok).toBe(true);
  expect(wxOwnRes.items).toHaveLength(1);
  expect(wxOwnRes.items[0]?.text).toBe('客户1私聊');

  const wxCrossChatExec = await ctx.tools.execute(
    { type: 'toolCall', id: 'wx_cross_chat', name: 'channel_history', arguments: { chat: 'wxid_other' } },
    wxSession,
    new AbortController().signal,
  );
  const wxCrossChatRes = JSON.parse(wxCrossChatExec.text) as channels.ChannelHistoryResult;
  expect(wxCrossChatRes.ok).toBe(false);
  expect(wxCrossChatRes.error?.code).toBe('forbidden');

  const wxCrossChExec = await ctx.tools.execute(
    { type: 'toolCall', id: 'wx_cross_ch', name: 'channel_history', arguments: { channel: 'http' } },
    wxSession,
    new AbortController().signal,
  );
  const wxCrossChRes = JSON.parse(wxCrossChExec.text) as channels.ChannelHistoryResult;
  expect(wxCrossChRes.ok).toBe(false);
  expect(wxCrossChRes.error?.code).toBe('forbidden');
  wxSession.row.state = 'done';

  //M 5) 外人直接构造 channel/history 事件请求各渠道处理函数，仍被各渠道处理器二次拒绝。
  const guestSnapshot: channels.SourceSnapshot = {
    messageId: 'm_guest',
    nativeId: 'n_guest',
    channel: 'feishu',
    accountId: appId,
    chatId: 'oc_chat_1',
    chatType: 'group',
    senderId: 'ou_guest',
    role: 'guest',
    targetBots: ['小守'],
    mentions: [],
    origin: { channel: 'feishu', address: { role: 'guest', chatId: 'oc_chat_1' } },
    visibility: { scope: `feishu:${appId}:oc_chat_1`, trusted: false, publicSourceIds: [] },
    botName: '小守',
    claimKey: 'k_guest',
    replyRoundKey: 'r_guest',
  };
  for (const probe of [
    { channel: 'wechat', chatId: 'wxid_c1' },
    { channel: 'cli', chatId: 'cli:本机' },
    { channel: 'http', chatId: 'http:本机' },
    { channel: 'feishu', chatId: 'oc_other_chat' },
  ]) {
    const directRes = await channels.requestChannelHistory(ctx, {
      channel: probe.channel,
      sourceSnapshot: guestSnapshot,
      mode: 'current',
      chatId: probe.chatId,
      limit: 50,
    });
    expect(directRes.ok).toBe(false);
    expect(directRes.error?.code).toBe('forbidden');
  }

  //M 6) 本人在群里说话也不跨渠道：取到的别处历史会回到群里，被群里的外人看到。
  const ownerInGroup: channels.SourceSnapshot = {
    ...guestSnapshot,
    senderId: 'ou_owner',
    role: 'owner',
    origin: { channel: 'feishu', address: { role: 'owner', chatId: 'oc_chat_1' } },
  };
  expect(channels.isHistoryOwner(ownerInGroup)).toBe(false);
  const ownerGroupRes = await channels.requestChannelHistory(ctx, {
    channel: 'wechat',
    sourceSnapshot: ownerInGroup,
    mode: 'current',
    chatId: 'wxid_c1',
    limit: 50,
  });
  expect(ownerGroupRes.ok).toBe(false);
  expect(ownerGroupRes.error?.code).toBe('forbidden');
});
