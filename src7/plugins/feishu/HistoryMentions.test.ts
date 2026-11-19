/** 离线验证飞书本地历史的 @我 过滤、条数和签名游标。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import { expect, test } from 'bun:test';
import * as protocol from '../../Channels.ts';
import * as historyRequest from '../bots/HistoryRequest.ts';
import type { FeishuChatLogEntry } from './History.ts';
import * as feishuModule from './index.ts';

const APP_ID = 'cli_mentions_fixture';
const CHAT_ID = 'oc_mentions_fixture';
const BOT_NAME = '合成机器人';
const BOT_OPEN_ID = 'ou_fixture_bot';
const SENDER_ID = 'ou_fixture_sender';
const SCOPE = `feishu:${APP_ID}:${CHAT_ID}`;

const snapshot: protocol.SourceSnapshot = {
  messageId: 'query-message',
  nativeId: null,
  channel: 'feishu',
  accountId: APP_ID,
  chatId: CHAT_ID,
  chatType: 'group',
  senderId: SENDER_ID,
  role: 'guest',
  targetBots: [BOT_NAME],
  mentions: [],
  origin: { channel: 'feishu', address: { owner: false } },
  visibility: { scope: SCOPE, trusted: false, publicSourceIds: [] },
  botName: BOT_NAME,
  claimKey: 'fixture-claim',
  replyRoundKey: 'fixture-round',
};

/** 构造可直接写入测试聊天日志的标准条目。 */
function getEntry(messageId: string, createdAt: number, mentions: protocol.ChannelMention[]): FeishuChatLogEntry {
  return {
    messageId,
    nativeId: messageId,
    appId: APP_ID,
    chatId: CHAT_ID,
    direction: 'user',
    createdAt,
    sender: { id: SENDER_ID },
    text: messageId,
    mentions,
    attachments: [],
  };
}

/** 构造乱序的合成日志。三条较旧命中共享时间戳，明确定义同一时间的翻页边界。 */
function getHistoryFixture() {
  const byName = { id: 'ou_unbound_alias', botNames: [BOT_NAME] };
  const byId = { id: BOT_OPEN_ID, botNames: [] };
  const other = { id: 'ou_fixture_other', botNames: ['其他机器人'] };
  const everyone = { id: 'all', name: '所有人', botNames: [] };

  //M 查询上限内有 200 条有效近期记录，另有三条旧记录供翻页。
  const recent = Array.from({ length: 200 }, (_item, index) => {
    const suffix = String(index).padStart(3, '0');
    const messageId = `recent-${suffix}`;
    return getEntry(messageId, 200 + index, [byId]);
  });
  const older = [
    getEntry('old-a', 100, [byName]),
    getEntry('old-b', 100, [byId]),
    getEntry('old-c', 100, [other, byId]),
  ] as const;

  //M 不匹配的消息比命中的都新，分辨是否先过滤再按条数分页。
  const excluded = [
    getEntry('not-other', 500, [other]),
    getEntry('not-all', 501, [everyone]),
    getEntry('not-plain', 502, []),
  ];
  const entries = [...recent, ...older, ...excluded].reverse();
  return { entries, recent, older };
}

test('飞书历史 @我 只选本机器人并保留原有分页边界', async () => {
  const root = fs.mkdtempSync(path.join(import.meta.dir, '.mentions-test-'));
  const log = path.join(root, `${CHAT_ID}.jsonl`);
  const ctx = new cordis.Context();
  const db = new sqlite.Database(':memory:');
  try {
    //M 用真实飞书事件监听和合成日志，不触发 ready 或 SDK 请求。
    ctx.provide('resources', { db, root, ensureRuntimeDir: () => root });
    ctx.provide('bots', { channel: () => () => undefined });
    const config = {
      domain: 'http://127.0.0.1:9',
      apps: [{ appId: APP_ID, appSecret: 'fixture', bot: BOT_NAME }],
      people: new Map(),
      groups: new Map(),
    };
    const channel = new feishuModule.Feishu(ctx, config);
    const app = channel.apps.get(APP_ID);
    if (app === undefined) {
      throw new Error('合成飞书应用未登记');
    }
    app.botOpenId = BOT_OPEN_ID;

    const { entries, recent, older } = getHistoryFixture();
    const jsonl = entries.map((entry) => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(log, jsonl + '\n', 'utf8');

    //M 200 条上限下，@其他机器人、@所有人和未 @ 的消息均无法挤入第一页。
    const request = { channel: 'feishu', sourceSnapshot: snapshot, mode: 'mentions', limit: 200 } as const;
    const first = await historyRequest.requestChannelHistory(ctx, request);
    expect(first).toMatchObject({ ok: true, scope: SCOPE, completeness: 'local_only' });
    expect(first.items.map((item) => item.messageId)).toEqual(recent.map((entry) => entry.messageId));

    //M 下一页从本页首条之前开始，并在同一毫秒按消息号稳定切分。
    const binding = {
      channel: 'feishu', accountId: APP_ID, chatId: CHAT_ID, mode: 'mentions', senderId: '', botName: BOT_NAME,
    } as const;
    const firstCursor = first.nextCursor;
    if (firstCursor === null) {
      throw new Error('第一页缺少进一步翻页的游标');
    }
    const firstBoundary = protocol.decodeHistoryCursor(firstCursor, binding);
    expect(firstBoundary).toMatchObject({ beforeAt: 200, beforeId: 'recent-000' });
    const next = { ...request, limit: 2, before: firstCursor };
    const second = await historyRequest.requestChannelHistory(ctx, next);
    expect(second.ok).toBe(true);
    expect(second.items.map((item) => item.messageId)).toEqual([older[1].messageId, older[2].messageId]);

    const secondCursor = second.nextCursor;
    if (secondCursor === null) {
      throw new Error('第二页未保留同一时间的较早记录');
    }
    const secondBoundary = protocol.decodeHistoryCursor(secondCursor, binding);
    expect(secondBoundary).toMatchObject({ beforeAt: 100, beforeId: 'old-b' });
    const previous = { ...next, before: secondCursor };
    const third = await historyRequest.requestChannelHistory(ctx, previous);
    expect(third).toMatchObject({ ok: true, nextCursor: null });
    expect(third.items.map((item) => item.messageId)).toEqual([older[0].messageId]);

    //G @我的游标不能换到其他查询模式，未知机器人身份也不放宽匹配。
    const mismatched = { ...next, mode: 'current' } as const;
    const invalid = await historyRequest.requestChannelHistory(ctx, mismatched);
    expect(invalid).toMatchObject({ ok: false, items: [], error: { code: 'invalid_cursor' } });
    delete app.botOpenId;
    const unresolved = await historyRequest.requestChannelHistory(ctx, request);
    expect(unresolved).toMatchObject({ ok: false, items: [], error: { code: 'identity_unresolved' } });
  } finally {
    await ctx.fiber.dispose();
    db.close();
    if (fs.existsSync(log)) {
      fs.unlinkSync(log);
    }
    fs.rmdirSync(root);
  }
});
