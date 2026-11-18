/** 飞书群进度调度离线测试：使用假模型和内存飞书发送端。 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';
import * as channel from '../../Channels.ts';
import type { ChannelMessage, SourceSnapshot } from '../../Channels.ts';
import { Sessions, type ChatRequest, type Session } from '../../Sessions.ts';
import { Tools, type ToolGate } from '../../Tools.ts';
import * as botsPlugin from '../bots/index.ts';
import * as feishu from '../feishu/index.ts';
import * as memory from '../memory/ChannelIndex.ts';
import * as daily from './GroupDaily.ts';

const GROUP = 'oc_test_group';
const OTHER = 'oc_another_group';
const BOT = '周小灵';
const PROMPT = '应汇报成员：小林、小周。';
const SETTING = { at: '17:30', bot: BOT, prompt: PROMPT };
const APPS = [
  { app_id: 'cli_primary', app_secret: 'offline-test', bot: BOT },
  { app_id: 'cli_shared', app_secret: 'offline-test', bot: '助手', bots: [BOT] },
];

function getConfig(groups: unknown[], apps = APPS.slice(0, 1)): feishu.FeishuConfig {
  const ctx = new cordis.Context();
  ctx.provide('resources', { raw: { channels: { feishu: apps } }, config: { plugins: [] } });
  ctx.provide('bots', { get: (name: string) => ({ name }) });
  return feishu.checkConfig(ctx, { groups });
}

test('只登记启用 daily 的飞书群并使用明确的发信机器人和账号', () => {
  const config = getConfig([{ chat_id: GROUP, daily: SETTING }, { chat_id: OTHER }]);
  expect(config.groups.get(GROUP)).toMatchObject({
    listen: 'all', daily: { hour: 17, minute: 30, appId: 'cli_primary', bot: BOT, prompt: PROMPT },
  });
  expect(config.groups.get(OTHER)).toMatchObject({ listen: 'mention' });
  expect(config.groups.get(OTHER)?.daily).toBeUndefined();
  expect(() => getConfig([{ chat_id: GROUP, daily: { ...SETTING, at: '24:00' } }])).toThrow('HH:mm');
  expect(() => getConfig([{ chat_id: GROUP, daily: { ...SETTING, prompt: ' ' } }])).toThrow('prompt');
  expect(() => getConfig([{ chat_id: GROUP, daily: SETTING }], APPS)).toThrow('app_id');
  const shared = getConfig([{ chat_id: GROUP, daily: { ...SETTING, app_id: 'cli_shared' } }], APPS);
  expect(shared.groups.get(GROUP)?.daily?.appId).toBe('cli_shared');
});

test('每日时刻按运行机器本地日历，重启错过的当日不补', () => {
  const before = new Date(2026, 10, 19, 17, 29, 59);
  const due = new Date(2026, 10, 19, 17, 30);
  const after = new Date(2026, 10, 19, 17, 30, 1);
  const tomorrow = new Date(2026, 10, 20, 17, 30);
  expect(daily.getNextReportAt(before, 17, 30)).toEqual(due);
  expect(daily.getNextReportAt(due, 17, 30)).toEqual(tomorrow);
  expect(daily.getNextReportAt(after, 17, 30)).toEqual(tomorrow);
});

test('定时标准消息发给原群指定机器人，日报工具只查同群和同账号', async () => {
  const ctx = new cordis.Context();
  const db = new Database(':memory:');
  try {
    const found: Array<{ id: string; customer: string }> = [];
    ctx.provide('sessions', {
      find: () => found,
      create: (input: { customer: string }) => {
        const session = { id: 'synthetic-report-session', customer: input.customer };
        found.push(session);
        return session;
      },
    });
    const received: ChannelMessage[] = [];
    ctx.on('channel/message', (message) => { received.push(message); });
    daily.bindReportTools(ctx);

    const at = new Date(2026, 10, 19, 17, 30);
    const group = { chatId: GROUP, name: '测试项目 群', hour: 17, minute: 30, bot: BOT, appId: 'cli_primary', prompt: PROMPT };
    await daily.dispatchReport(ctx, group, at);
    await daily.dispatchReport(ctx, group, at);
    expect(found).toHaveLength(1);
    const message = received[0]!;
    expect(received[1]!.messageId).toBe(message.messageId);
    expect(message).toMatchObject({
      targetBots: [BOT], chatId: GROUP, chatType: 'group', role: 'guest',
      origin: { channel: 'feishu', address: { owner: false, trusted: false, messageId: '', openId: '', scheduled: 'daily-progress' } },
      routing: { listenOnly: false, autoFinal: true, sessionId: 'synthetic-report-session' },
    });
    expect(message.text).toContain(PROMPT);
    expect(message.text).toContain('2026-11-18 17:30 至 2026-11-19 17:30');

    const claimKey = channel.getClaimKey(message.messageId, BOT);
    const replyRoundKey = channel.getReplyRoundKey(message.messageId, BOT, 'synthetic-report-session');
    const snapshot: SourceSnapshot = { ...message, senderId: message.sender.id, botName: BOT, claimKey, replyRoundKey };
    const session = { row: { activeSourceSnapshot: snapshot } } as Session;
    const access = memory.getAccess(session);
    expect(access).toEqual({ full: false, channel: 'feishu', chat: GROUP, account: 'cli_primary', key: 'group:feishu:' + GROUP });
    expect(() => memory.getScope({ chat: OTHER }, access)).toThrow('只能查');
    const scoped = memory.getScope({}, access);
    const index = new memory.ChannelIndex(db);
    const current = { ...message, messageId: 'test-group-report', text: '小林完成联调', sender: { id: 'ou_a', name: '小林' } };
    const other = { ...current, messageId: 'test-private', chatType: 'p2p' as const, chatId: 'private', text: '私聊内容' };
    const wrongApp = { ...current, messageId: 'test-other-app', accountId: 'cli_other', text: '另一应用内容' };
    index.add(memory.getMessageRow(current)!);
    index.add(memory.getMessageRow(other)!);
    index.add(memory.getMessageRow(wrongApp)!);
    const query = memory.getQuery({}, scoped);
    expect(index.search(query).map((row) => row.text)).toEqual(['小林完成联调']);

    const tools = ['channel_reply', 'channel_search', 'read'].map((name) => ({ name }));
    const request = { session, tools } as ChatRequest;
    await ctx.serial('session/request', request);
    expect(request.tools.map((tool) => tool.name)).toEqual(['channel_reply', 'channel_search']);
    const denied = { session, call: { name: 'read' } } as ToolGate;
    await ctx.serial('session/before-tool', denied);
    expect(denied.deny).toContain('本群');
  } finally {
    await ctx.fiber.dispose();
    db.close();
  }
});


test('日报经真实机器人认领与回复流程，只向合成群发一条汇总', async () => {
  const ctx = new cordis.Context();
  const db = new Database(':memory:');
  try {
    ctx.provide('resources', {
      db, root: process.cwd(), raw: { bots: [{ name: BOT }] }, dir: () => process.cwd(),
      config: { defaultModel: 'fake/report', thinking: 'low', plugins: [], providers: {} },
      getModel: () => ({ input: ['text'] }),
    });
    ctx.provide('workspaces', { ensureDefault: () => undefined, getAccess: () => ({}) });
    await ctx.plugin(Tools);
    await ctx.plugin(Sessions);
    await ctx.plugin(botsPlugin, { prompt: false });
    daily.bindReportTools(ctx);

    ctx.tools.register({
      definition: { name: 'channel_search', description: '合成群汇报', parameters: piAi.Type.Object({}) },
      kinds: ['front'],
      run: () => '小林：联调完成。',
    });
    const summary = '小林已完成联调。@小周 请补充进度。明天验收。';
    const sent: { chat: string; text: string }[] = [];
    channel.registerTextReply(ctx, {
      channel: 'feishu',
      sendDirectText: (text, request) => { sent.push({ chat: request.sourceSnapshot.chatId, text }); },
    });
    ctx.on('session/request', (request) => {
      const last = request.messages.at(-1);
      if (last?.role === 'toolResult' && last.toolName === 'channel_reply') {
        request.answer = piAi.fauxAssistantMessage('已发送日报');
        return;
      }
      const call = last?.role === 'toolResult'
        ? piAi.fauxToolCall('channel_reply', { text: summary })
        : piAi.fauxToolCall('channel_search', {});
      request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
    });
    const ended = Promise.withResolvers<void>();
    ctx.on('channel/settled', (event) => {
      if (event.sourceSnapshot.chatId === GROUP) ended.resolve();
    });
    const slot = new Date(2026, 10, 19, 17, 30);
    const group = { chatId: GROUP, name: '合成群', hour: 17, minute: 30, bot: BOT, appId: 'cli_primary', prompt: PROMPT };
    await daily.dispatchReport(ctx, group, slot);
    await ended.promise;
    expect(sent).toEqual([{ chat: GROUP, text: summary }]);

    // 同一计划重放应命中该日报前台的认领键，普通群前台仍可独立创建。
    await daily.dispatchReport(ctx, group, slot);
    expect(ctx.sessions.find({ bot: BOT, kind: 'front' })).toHaveLength(1);
    const normalCustomer = 'feishu:group:' + GROUP;
    expect(ctx.sessions.find({ bot: BOT, kind: 'front', customer: normalCustomer })).toEqual([]);
    expect(ctx.sessions.find({ bot: BOT, kind: 'front' })[0]?.sourceScope).toBeUndefined();
    expect(sent).toHaveLength(1);
  } finally {
    await ctx.fiber.dispose();
    db.close();
  }
});
