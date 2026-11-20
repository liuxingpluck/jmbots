/** 主动发件通过已核验的本机 HTTP 和模拟渠道，测试只写内存账。 */
import * as sqlite from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as channels from '../channels/index.ts';
import type { SourceSnapshot } from '../channels/index.ts';
import type { Session } from '../../Sessions.ts';
import type { ToolSpec } from '../../Tools.ts';
import * as utils from '../../utils/index.ts';
import * as feishuModule from '../feishu/index.ts';
import * as httpModule from '../http/index.ts';
import * as approval from './index.ts';
import * as routes from './ChannelSend.ts';
import * as outbound from './Outbound.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const group = {
  channel: 'feishu',
  account: 'fixture-account',
  chat: 'oc_synthetic',
  text: ' 合成正文\n ',
};

/** 假渠道收到的一次发件：渠道、确切地址里的账号和聊天、正文、请求键。 */
interface SentCall {
  channel: string;
  account: string;
  chat: string;
  text: string;
  replyRequestKey: string;
}

/** 模拟经过 HTTP 钩子核验的请求、模型工具仓库和飞书事件。 */
function getWorld() {
  const ctx = new cordis.Context();
  const db = new sqlite.Database(':memory:');
  const app = fastify.default();
  cleanups.push(
    () => db.close(),
    async () => { await ctx.fiber.dispose(); },
    async () => { await app.close(); },
  );
  const state = { verified: true, now: Date.now(), uncertain: false };
  const calls: SentCall[] = [];
  const tools = new Map<string, ToolSpec>();
  ctx.provide('resources', { db });
  ctx.provide('tools', { register: (spec: ToolSpec) => { tools.set(spec.definition.name, spec); } });
  new outbound.Outbound(ctx, () => state.now);
  routes.mountChannelSend(ctx, { app, isVerified: () => state.verified });
  routes.registerChannelSendTool(ctx);

  //M 假飞书渠道：批准后的发件经 channel/reply 带确切地址来，记下渠道、账号、聊天和正文。
  channels.registerTextReply(ctx, {
    channel: 'feishu',
    sendDirectText: async (text, request, targetAddress): Promise<channels.TextReplyOutcome> => {
      const account = utils.getStringField(targetAddress, 'appId');
      const chat = utils.getStringField(targetAddress, 'chatId');
      calls.push({ channel: request.channel, account, chat, text, replyRequestKey: request.replyRequestKey });
      await Bun.sleep(5);
      if (state.uncertain) return { status: 'uncertain' };

      return { status: 'sent' };
    },
  });
  const post = (payload: Record<string, unknown>) => {
    return app.inject({ method: 'POST', url: '/api/channel/send', payload });
  };
  const prepare = async () => {
    const response = await post(group);
    expect(response.statusCode).toBe(200);
    return response.json().intent as { intentId: string; digest: string };
  };
  const confirm = (intent: Awaited<ReturnType<typeof prepare>>, fields: Record<string, unknown> = {}) => {
    return post({
      action: 'confirm', intentId: intent.intentId, observedIntentDigest: intent.digest,
      interactionId: 'fixture-click', decision: 'approve', ...fields,
    });
  };
  return { state, calls, post, prepare, confirm, tools };
}

test('HTTP 只认验证结果，申请阶段不会直接出站', async () => {
  const world = getWorld();
  world.state.verified = false;
  const denied = await world.post({ ...group, actor: 'owner', from: 'http' });
  expect(denied.statusCode).toBe(403);
  world.state.verified = true;
  const unsupported = await world.post({ ...group, channel: 'wechat' });
  expect(unsupported.statusCode).toBe(409);
  const pending = await world.post(group);
  expect(pending.json().intent).toMatchObject({ status: 'waiting', ...group });
  expect(world.calls).toHaveLength(0);
});

test('确认只发保持原样的已展示意图，并发及重试最多出站一次', async () => {
  const world = getWorld();
  const intent = await world.prepare();
  const mismatch = await world.confirm(intent, { observedIntentDigest: '0'.repeat(64) });
  expect(mismatch.statusCode).toBe(409);
  const altered = { account: 'fake-account', chat: 'fake-chat', text: '不同内容', from: '伪造来源' };
  await Promise.all([world.confirm(intent, altered), world.confirm(intent)]);
  const status = await world.post({ action: 'status', intentId: intent.intentId });
  expect(status.json().intent).toMatchObject({ status: 'sent', ...group });
  expect(world.calls).toHaveLength(1);
  expect(world.calls[0]).toMatchObject(group);
  //M 请求键由业务发送号算出：同一笔重试时渠道按它去重。
  expect(world.calls[0]?.replyRequestKey).toContain('approved-send:');
});

test('旧意图过期拒发，未知回执仍沿用同一业务号', async () => {
  const world = getWorld();
  const expired = await world.prepare();
  world.state.now += 600_000;
  const denied = await world.confirm(expired);
  expect(denied.statusCode).toBe(409);
  expect(world.calls).toHaveLength(0);
  const pending = await world.prepare();
  world.state.uncertain = true;
  const initial = await world.confirm(pending);
  const second = await world.confirm(pending);
  expect(initial.json().intent.status).toBe('uncertain');
  expect(second.json().intent).toMatchObject({ requestId: initial.json().intent.requestId, status: 'uncertain' });
  expect(world.calls).toHaveLength(1);
});

/** 真来源和会话地址使用不同值，验证工具只认活动快照。 */
function getSession(withSnapshot: boolean): Session {
  const snapshot: SourceSnapshot = {
    messageId: 'fixture-1', nativeId: null, channel: group.channel, accountId: group.account, chatId: group.chat,
    chatType: 'group', senderId: 'fixture-owner', role: 'owner', targetBots: ['fixture'], mentions: [],
    origin: { channel: group.channel, address: {} },
    visibility: { scope: 'fixture', trusted: false, publicSourceIds: [] },
    botName: 'fixture', claimKey: 'fixture-claim', replyRoundKey: 'fixture-round',
  };
  const row = { kind: 'front', address: { appId: 'old-account', chatId: 'old-chat' } };
  if (withSnapshot) return { id: 'fixture-session', row: { ...row, activeSourceSnapshot: snapshot } } as Session;

  return { id: 'fixture-session', row } as Session;
}

test('模型工具固定本轮目标，同调用只建一条意图，缺少快照时拒绝', async () => {
  const world = getWorld();
  const tool = world.tools.get('channel_send')!;
  const args = { text: group.text, channel: 'http', account: 'evil', chat: 'evil' };
  const signal = new AbortController().signal;
  const missing = getSession(false);
  await expect(Promise.resolve(tool.run(args, missing, signal, 'tool-1'))).rejects.toThrow('本轮可信飞书来源');
  const session = getSession(true);
  const first = await tool.run(args, session, signal, 'tool-1');
  const second = await tool.run(args, session, signal, 'tool-1');
  expect(first).toBe(second);
  const pending = JSON.parse(String(first)) as { intentId: string; status: string };
  expect(pending.status).toBe('waiting');
  expect(world.calls).toHaveLength(0);
  const status = await world.post({ action: 'status', intentId: pending.intentId });
  expect(status.json().intent).toMatchObject(group);
});

test('插件入口经真实 HTTP 核验，批准后经 channel/reply 照批准目标调飞书 SDK，历史写不进只打日志', async () => {
  const ctx = new cordis.Context();
  const db = new sqlite.Database(':memory:');
  const replyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-send-'));
  cleanups.push(
    () => db.close(),
    async () => { await ctx.fiber.dispose(); },
    () => fs.rmSync(replyDir, { recursive: true, force: true }),
  );
  const ip = '192.0.2.12';
  const token = 'fixture-token';
  ctx.provide('resources', {
    db,
    raw: { server: { port: 1, token, trusted_ips: [ip] } },
    ensureRuntimeDir: (...parts: string[]) => {
      //M 聊天历史目录故意写不进去；回复去重记录放临时目录。
      if (parts.includes('chats')) throw new Error('合成历史写入失败');
      if (parts.includes('replies')) return replyDir;

      return 'src7/plugins/http/fixtures-no-tokens';
    },
  });
  ctx.provide('bots', { channel: () => () => undefined });
  ctx.provide('sessions', {});
  const tools = new Map<string, ToolSpec>();
  ctx.provide('tools', { register: (spec: ToolSpec) => { tools.set(spec.definition.name, spec); } });
  await ctx.plugin(httpModule);
  await ctx.plugin(approval);
  expect(tools.has('channel_send')).toBe(true);

  const config = {
    domain: 'http://127.0.0.1:9',
    apps: [{ appId: group.account, appSecret: 'fixture', bot: '合成机器人' }],
    people: new Map(),
    groups: new Map(),
    historyOnJoin: 0,
  };
  const feishu = new feishuModule.Feishu(ctx, config);
  const sdk = feishu.client(group.account);
  const send = spyOn(sdk.im.v1.message, 'create').mockResolvedValue({ data: { message_id: 'om_fixture' } });
  const historyError = spyOn(console, 'error').mockImplementation(() => undefined);
  cleanups.push(() => historyError.mockRestore());

  const payload = { ...group, text: ' @C:/fixture.txt\n正文 ' };
  const route = { method: 'POST', url: '/api/channel/send' } as const;
  const denied = await ctx.http.app.inject({ ...route, payload, remoteAddress: ip });
  expect(denied.statusCode).toBe(403);
  const headers = { authorization: `Bearer ${token}` };
  const pending = await ctx.http.app.inject({ ...route, payload, remoteAddress: ip, headers });
  expect(pending.statusCode).toBe(200);
  const intent = pending.json().intent as { intentId: string; digest: string };
  expect(send).not.toHaveBeenCalled();

  const confirm = {
    action: 'confirm', intentId: intent.intentId, observedIntentDigest: intent.digest,
    interactionId: 'fixture-click', decision: 'approve',
  };
  const done = await ctx.http.app.inject({ ...route, payload: confirm });
  expect(done.json().intent.receipt).toEqual({ status: 'sent' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: group.chat, msg_type: 'text', content: JSON.stringify({ text: payload.text }) },
  });
  expect(historyError).toHaveBeenCalledWith(expect.stringContaining('合成历史写入失败'));
});
