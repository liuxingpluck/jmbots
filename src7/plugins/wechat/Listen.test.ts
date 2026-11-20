/**
 * 微信后台全量监听、只听不发的单元测试（2026-11-14 23:25 EST，用户要求照原版积木客服听全部会话、AI 只生成回复不发送）。
 * 跑法：bun test src7/plugins/wechat/Listen.test.ts
 * 不跑真的微信引擎：Reader 的 sessions / syncBatch / backfill 换成假的，数据全是合成的。
 * 查的是：全部会话都抓取存表；第一轮全是存量只存不交；只有勾了“监听”的会话，对方私聊、群里 @我 才交给机器人（没勾的 bots.receive 一次都不调）；公众号不交；
 * 一轮最多同步 60 个会话；机器人回复只成草稿、deliver 也不发；最近 50 条拼进 system；微信归档不足时用 backfill 补。
 * 2026-11-15：人手点“让 AI 回复”只对已监听会话调用 receive；监听会话 backfillAll 把更早的消息全部入库且不交机器人。
 */
import * as fastify from 'fastify';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Session } from '../../Sessions.ts';
import { Wechat, describe as describeView } from './index.ts';
import type { WechatConfig } from './index.ts';
import * as pageRoutes from './page/Routes.ts';
import { Reader } from './read/Reader.ts';
import type { ChatItem, RawMessage, SyncResult } from './read/Reader.ts';
import * as voiceModule from './read/Voice.ts';

/** 合成一条消息。 */
function msg(id: number, at: number, text: string, fromSelf = false, atMe = false): RawMessage {
  return { source: 'm0', local_id: id, local_type: 1, create_time: at, from_self: fromSelf, at_me: atMe, view: { kind: 'text', text, sender: '' } };
}

/** 假的 ctx：只给 Wechat 用到的几样。 */
function fake() {
  const received: { text: string; address: unknown }[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const ctx = {
    get: () => undefined,
    resources: { db: new Database(':memory:') },
    effect: () => undefined,
    emit: () => undefined,
    on: (name: string, fn: (...args: unknown[]) => unknown) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {
        const current = handlers.get(name) ?? [];
        const at = current.indexOf(fn);
        if (at >= 0) current.splice(at, 1);
      };
    },
    serial: async (name: string, ...args: unknown[]) => {
      //M 交给机器人的：私聊发 channel/direct，群里 @我 发 channel/mention。
      if (name === 'channel/direct' || name === 'channel/mention') {
        const message = args[0] as { text: string; origin: { address: unknown } };
        received.push({ text: message.text, address: message.origin.address });
        return;
      }
      const list = handlers.get(name) ?? [];
      for (const fn of [...list]) {
        await fn(...args);
      }
    },
    bots: { channel: () => () => undefined, receive: async (_c: string, _b: string, text: string, address: unknown) => { received.push({ text, address }); } },
    //M 旧路回话带会话号：微信照会话现在的状态看做完没有，这里一律当做完了。
    sessions: { open: () => ({ row: { state: 'done' } }) },
  };
  const config: WechatConfig ={ bot: '助手', root: '.', python: 'x', ocrPython: 'x', aobwUrl: 'http://127.0.0.1:1', lockFile: 'x', intervalMs: 0, atNames: '', chatLimit: 1000, send: false };
  const wechat = new Wechat(ctx as never, config);
  wechat.reader.backfill = async (_a, chat): Promise<SyncResult> => ({ chat, missing: false, messages: [] });
  return { wechat, ctx, received, handlers };
}

describe('微信后台全量监听、只听不发', () => {
  //M 2026-11-14 23:59 EST：只对勾了“监听”的会话起草；这条用例先把私聊、群都勾上监听（公众号也勾上，证明它照样不交）。
  test('第一轮存量只存不交；之后对方私聊、群里 @我 才交；公众号、自己说的不交', async () => {
    const { wechat, ctx, received } = fake();
    for (const chat of ['wxid_a', 'g1@chatroom', 'gh_news']) ctx.resources.db.query('INSERT INTO wechat_watch VALUES (?, ?, ?, 0, NULL)').run('acc1', chat, chat);
    let chats: ChatItem[] = [
      { username: 'wxid_a', chat: '甲', is_group: false, unread: 0, last_message: '', timestamp: 100 },
      { username: 'g1@chatroom', chat: '群', is_group: true, unread: 0, last_message: '', timestamp: 100 },
      { username: 'gh_news', chat: '号', is_group: false, unread: 0, last_message: '', timestamp: 100 },
    ];
    let batch: Record<string, RawMessage[]> = { 'wxid_a': [msg(1, 100, '旧话')], 'g1@chatroom': [msg(1, 100, '旧群话')], 'gh_news': [msg(1, 100, '推送')] };
    wechat.reader.accounts = () => [{ id: 'acc1', nickname: '', wxid: '' }];
    wechat.reader.sessions = async () => chats;
    wechat.reader.syncBatch = async (_a, list): Promise<SyncResult[]> => list.map((item) => ({ chat: item.chat, missing: false, is_group: item.chat.endsWith('@chatroom'), messages: batch[item.chat] ?? [] }));

    await wechat.poll();
    expect(received.length).toBe(0);
    expect((ctx.resources.db.query('SELECT COUNT(*) AS n FROM wechat_sync').get() as { n: number }).n).toBe(3);
    expect(wechat.status.chats).toBe(3);

    chats = chats.map((c) => ({ ...c, timestamp: 200 }));
    batch = {
      'wxid_a': [msg(2, 200, '在吗'), msg(3, 201, '我自己说的', true)],
      'g1@chatroom': [msg(2, 200, '群里闲聊'), msg(3, 201, '@我 问一下', false, true)],
      'gh_news': [msg(2, 200, '新推送')],
    };
    await wechat.poll();
    expect(received.map((item) => item.text).sort()).toEqual(['@我 问一下', '在吗']);
  });

  //M 2026-11-14 23:59 EST 用户纠正：没勾监听的会话来新消息只存不调模型；勾上以后才起草。
  test('没勾监听的会话：新消息照样存表，但不交给机器人；勾上监听后才交', async () => {
    const { wechat, ctx, received } = fake();
    let chats: ChatItem[] = [
      { username: 'wxid_b', chat: '乙', is_group: false, unread: 0, last_message: '', timestamp: 100 },
      { username: 'g2@chatroom', chat: '群二', is_group: true, unread: 0, last_message: '', timestamp: 100 },
    ];
    let batch: Record<string, RawMessage[]> = { 'wxid_b': [msg(1, 100, '旧话')], 'g2@chatroom': [msg(1, 100, '旧群话')] };
    wechat.reader.accounts = () => [{ id: 'acc1', nickname: '', wxid: '' }];
    wechat.reader.sessions = async () => chats;
    wechat.reader.syncBatch = async (_a, list): Promise<SyncResult[]> => list.map((item) => ({ chat: item.chat, missing: false, is_group: item.chat.endsWith('@chatroom'), messages: batch[item.chat] ?? [] }));
    await wechat.poll();

    chats = chats.map((c) => ({ ...c, timestamp: 200 }));
    batch = { 'wxid_b': [msg(2, 200, '在吗')], 'g2@chatroom': [msg(2, 200, '@我 问一下', false, true)] };
    await wechat.poll();
    expect(received.length).toBe(0);
    expect((ctx.resources.db.query("SELECT COUNT(*) AS n FROM wechat_messages WHERE account = 'acc1'").get() as { n: number }).n).toBe(4);

    ctx.resources.db.query('INSERT INTO wechat_watch VALUES (?, ?, ?, 0, NULL)').run('acc1', 'wxid_b', '乙');
    chats = chats.map((c) => ({ ...c, timestamp: 300 }));
    batch = { 'wxid_b': [msg(3, 300, '还在吗')], 'g2@chatroom': [msg(3, 300, '@我 再问', false, true)] };
    await wechat.poll();
    expect(received.map((item) => item.text)).toEqual(['还在吗']);
  });

  test('同一轮里：没勾监听的私聊、群里 @我 都不发事件；勾了的私聊发 channel/direct、群里 @我 发 channel/mention，各一次', async () => {
    const { wechat, ctx, received } = fake();
    let calls = 0;
    const origSerial = ctx.serial;
    ctx.serial = async (name: string, ...args: unknown[]) => {
      if (name === 'channel/direct' || name === 'channel/mention') calls += 1;
      await origSerial(name, ...args);
    };
    for (const chat of ['wxid_on', 'gon@chatroom']) ctx.resources.db.query('INSERT INTO wechat_watch VALUES (?, ?, ?, 0, NULL)').run('acc1', chat, chat);
    let chats: ChatItem[] = ['wxid_off', 'goff@chatroom', 'wxid_on', 'gon@chatroom'].map((username) => ({ username, chat: username, is_group: username.endsWith('@chatroom'), unread: 0, last_message: '', timestamp: 100 }));
    let batch: Record<string, RawMessage[]> = Object.fromEntries(chats.map((c) => [c.username, [msg(1, 100, '存量')]]));
    wechat.reader.accounts = () => [{ id: 'acc1', nickname: '', wxid: '' }];
    wechat.reader.sessions = async () => chats;
    wechat.reader.syncBatch = async (_a, list): Promise<SyncResult[]> => list.map((item) => ({ chat: item.chat, missing: false, is_group: item.chat.endsWith('@chatroom'), messages: batch[item.chat] ?? [] }));
    await wechat.poll();
    expect(calls).toBe(0);

    chats = chats.map((c) => ({ ...c, timestamp: 200 }));
    batch = {
      'wxid_off': [msg(2, 200, '没勾的私聊')],
      'goff@chatroom': [msg(2, 200, '@我 没勾的群', false, true)],
      'wxid_on': [msg(2, 200, '勾了的私聊')],
      'gon@chatroom': [msg(2, 200, '@我 勾了的群', false, true)],
    };
    await wechat.poll();
    const chatsCalled = received.map((item) => (item.address as { chat: string }).chat).sort();
    expect(chatsCalled).toEqual(['gon@chatroom', 'wxid_on']);
    expect(calls).toBe(2);
    //M 没勾的也照样存表：4 个会话 × 2 条。
    expect((ctx.resources.db.query("SELECT COUNT(*) AS n FROM wechat_messages WHERE account = 'acc1'").get() as { n: number }).n).toBe(8);
    expect((ctx.resources.db.query("SELECT COUNT(*) AS n FROM wechat_messages WHERE chat IN ('wxid_off', 'goff@chatroom') AND at = 200").get() as { n: number }).n).toBe(2);
  });

  test('非文字消息给人、给模型看的文字', () => {
    expect(describeView({ kind: 'image' })).toBe('[图片]');
    expect(describeView({ kind: 'voice', seconds: 5 })).toBe('[语音 5 秒]');
    expect(describeView({ kind: 'article', title: '标题', desc: '摘要' })).toBe('[文章/卡片] 标题 — 摘要');
    expect(describeView({ kind: 'text', text: '你好' })).toBe('你好');
  });

  test('一轮最多同步 60 个会话，剩下的下轮再做', async () => {
    const { wechat } = fake();
    const chats: ChatItem[] = Array.from({ length: 130 }, (_, i) => ({ username: `wxid_${String(i)}`, chat: `c${String(i)}`, is_group: false, unread: 0, last_message: '', timestamp: 100 }));
    let asked = 0;
    wechat.reader.accounts = () => [{ id: 'acc1', nickname: '', wxid: '' }];
    wechat.reader.sessions = async () => chats;
    wechat.reader.syncBatch = async (_a, list): Promise<SyncResult[]> => { asked = list.length; return list.map((item) => ({ chat: item.chat, missing: false, messages: [] })); };
    await wechat.poll();
    expect(asked).toBe(60);
    expect(wechat.status.pending).toBe(70);
    await wechat.poll(); await wechat.poll();
    expect(wechat.status.synced).toBe(130);
  });

  test('回复只成草稿；deliver 也不发', async () => {
    const { wechat, ctx, handlers } = fake();
    let sent = 0;
    wechat.sender.send = async () => { sent += 1; return {}; };
    const address = { account: 'acc1', chat: 'wxid_a', name: '甲', customer: 'wechat:wxid_a' };
    ctx.resources.db.query('INSERT INTO wechat_watch VALUES (?, ?, ?, 1, 0)').run('acc1', 'wxid_a', '甲');

    //M 会话做完一轮的旧路回话：照 Bots.send 的样子发 channel/reply（target 带会话记的地址、带会话号），交给微信登记的回复处理。
    const request = {
      requestId: 'rep_1',
      channel: 'wechat',
      bot: '助手',
      replyRequestKey: 'legacy-1',
      replyRoundKey: JSON.stringify(['s1', '助手', 'legacy']),
      replyIndex: 0,
      kind: 'final',
      mode: 'text',
      payloadHash: 'hash-1',
      parts: [{ partId: 'text:0', kind: 'text', text: '好的，马上处理' }],
      target: { channel: 'wechat', chat: 'wxid_a', address },
      sessionId: 's1',
      atFiles: true,
    };
    for (const handler of handlers.get('channel/reply') ?? []) {
      await handler(request);
    }
    const row = ctx.resources.db.query('SELECT id, state FROM wechat_outbox').get() as { id: number; state: string };
    expect(row.state).toBe('draft');
    await wechat.deliver(row.id);
    expect(sent).toBe(0);
    expect((ctx.resources.db.query('SELECT state FROM wechat_outbox WHERE id = ?').get(row.id) as { state: string }).state).toBe('draft');
  });

  test('最近 50 条进 system，并提示从记忆翻页', async () => {
    const { ctx, handlers } = fake();
    const insert = ctx.resources.db.query('INSERT INTO wechat_messages (account, chat, source, local_id, at, from_self, kind, sender, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= 60; i++) insert.run('acc1', 'wxid_a', 'm0', 1000 + i, 1000 + i, i % 2, 'text', '', `第${String(i)}条`);
    const address = { account: 'acc1', chat: 'wxid_a', name: '甲', customer: 'wechat:wxid_a' };
    const request = { session: { row: { address } }, system: [] as string[], tools: [{ name: 'memory_get' }] };
    for (const fn of handlers.get('session/before-model') ?? []) {
      fn(request);
    }
    expect(request.system.length).toBe(1);
    expect(request.system[0]!.split('\n').filter((line) => line.includes('：第')).length).toBe(50);
    expect(request.system[0]).toContain('第60条');
    expect(request.system[0]).not.toContain('第10条');

  });

  test('没勾监听：draftReply 抛错且不调机器人；勾了才调用 receive', async () => {
    const { wechat, ctx, received } = fake();
    await expect(wechat.draftReply('acc1', 'wxid_a')).rejects.toThrow('请先勾选监听');
    expect(received.length).toBe(0);
    ctx.resources.db.query('INSERT INTO wechat_watch VALUES (?, ?, ?, 0, NULL)').run('acc1', 'wxid_a', '甲');
    await wechat.draftReply('acc1', 'wxid_a');
    expect(received.length).toBe(1);
    expect((received[0]!.address as { chat: string }).chat).toBe('wxid_a');
  });

  test('监听会话 backfillAll 把更早的消息全部入库，不交给机器人', async () => {
    const { wechat, ctx, received } = fake();
    ctx.resources.db.query('INSERT INTO wechat_watch VALUES (?, ?, ?, 0, NULL)').run('acc1', 'wxid_a', '甲');
    ctx.resources.db.query('INSERT INTO wechat_sync (account, chat, name, is_group, last_time, full) VALUES (?, ?, ?, 0, ?, 0)').run('acc1', 'wxid_a', '甲', 2000);
    const insert = ctx.resources.db.query('INSERT INTO wechat_messages (account, chat, source, local_id, at, from_self, kind, sender, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('acc1', 'wxid_a', 'm0', 2, 2000, 0, 'text', '', '最近');
    wechat.reader.backfill = async (_a, _c, until): Promise<SyncResult> => {
      if (until <= 1000) return { chat: 'wxid_a', missing: false, messages: [] };
      return { chat: 'wxid_a', missing: false, messages: [msg(1, 1000, '更早的历史')] };
    };
    await wechat.backfillAll('acc1', 'wxid_a');
    const n = (ctx.resources.db.query("SELECT COUNT(*) AS n FROM wechat_messages WHERE chat = 'wxid_a'").get() as { n: number }).n;
    expect(n).toBe(2);
    expect((ctx.resources.db.query("SELECT text FROM wechat_messages WHERE local_id = 1").get() as { text: string }).text).toBe('更早的历史');
    expect(received.length).toBe(0);
    expect((ctx.resources.db.query("SELECT full FROM wechat_sync WHERE chat = 'wxid_a'").get() as { full: number }).full).toBe(1);
  });

  test('客服页 messages 轮询：空闲轮回轻量 unchanged，新消息、旧历史补录、原地撤回与换实例均推进版本', async () => {
    const { wechat, ctx, received } = fake();
    const db = ctx.resources.db;
    db.query('INSERT INTO wechat_watch VALUES (?, ?, ?, 0, 2000)').run('acc1', 'wxid_a', '甲');
    db.query('INSERT INTO wechat_sync (account, chat, name, is_group, last_time, full) VALUES (?, ?, ?, 0, 2000, 0)')
      .run('acc1', 'wxid_a', '甲');

    //M 预塞 800 条历史消息，构造长窗口且全程保持同一 limit=1000 参数校验版本变化。
    const insert = db.query(
      'INSERT INTO wechat_messages (account, chat, source, local_id, at, from_self, kind, sender, text, view)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 1; i <= 800; i += 1) {
      const text = `历史对话第 ${String(i)} 条正文内容用于核对体积`;
      insert.run('acc1', 'wxid_a', 'm0', 1000 + i, 1000 + i, i % 2, 'text', '', text, JSON.stringify({ kind: 'text', text }));
    }

    const app = fastify.default({ logger: false });
    const voice = new voiceModule.VoiceAudio(wechat.reader, '.');
    pageRoutes.readRoutes(app, db, wechat, voice);

    try {
      //M 1. 不带 version 参数保持旧契约，直接返回消息数组。
      const legacy = await app.inject('/api/wechat-kefu/messages?account=acc1&chat=wxid_a&limit=1000');
      expect(legacy.statusCode).toBe(200);
      expect((legacy.json() as unknown[]).length).toBe(800);

      //M 2. 首次带空 version 拉回完整 800 条快照与版本号；空闲轮只回 ~50 字节的 unchanged。
      const first = await app.inject('/api/wechat-kefu/messages?account=acc1&chat=wxid_a&limit=1000&version=');
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as { unchanged: boolean; version: string; messages?: { local_id: number; text: string }[] };
      expect(firstBody.unchanged).toBe(false);
      expect(firstBody.messages?.length).toBe(800);
      expect(first.body.length).toBeGreaterThan(50_000);

      //M 别的会话写入与 wechat_sync 更新不影响当前会话的快速命中。
      insert.run('acc1', 'wxid_other', 'm0', 1, 3000, 0, 'text', '', '别的会话', '{}');
      db.query('UPDATE wechat_sync SET last_time = 2001 WHERE account = ? AND chat = ?').run('acc1', 'wxid_a');

      const idle = await app.inject(
        `/api/wechat-kefu/messages?account=acc1&chat=wxid_a&limit=1000&version=${encodeURIComponent(firstBody.version)}`,
      );
      expect(idle.statusCode).toBe(200);
      expect(idle.body.length).toBeLessThan(120);
      const idleBody = idle.json() as { unchanged: boolean; version: string };
      expect(idleBody).toEqual({ unchanged: true, version: firstBody.version });

      //M 3. 旧历史补录（早于窗口首条，同一 limit=1000）：推进修订号并返回含补录旧消息的新窗口。
      db.query('UPDATE wechat_sync SET full = 0 WHERE account = ? AND chat = ?').run('acc1', 'wxid_a');
      wechat.reader.backfill = async (_a, _c, until): Promise<SyncResult> => {
        if (until <= 500) return { chat: 'wxid_a', missing: false, messages: [] };

        return { chat: 'wxid_a', missing: false, messages: [msg(500, 500, '补录的更早消息')] };
      };
      await wechat.backfillAll('acc1', 'wxid_a');
      const afterBackfill = await app.inject(
        `/api/wechat-kefu/messages?account=acc1&chat=wxid_a&limit=1000&version=${encodeURIComponent(firstBody.version)}`,
      );
      const backfillBody = afterBackfill.json() as { unchanged: boolean; version: string; messages: { text: string }[] };
      expect(backfillBody.unchanged).toBe(false);
      expect(backfillBody.version).not.toBe(firstBody.version);
      expect(backfillBody.messages.length).toBe(801);
      expect(backfillBody.messages[0]?.text).toBe('补录的更早消息');

      //M 4. 微信侧原地撤回已落库的末条消息（同 source + local_id 变成 system 撤回提示）：更新展示、推进版本且不重派机器人。
      const recalledMsg: RawMessage = {
        source: 'm0',
        local_id: 1800,
        local_type: 10000,
        create_time: 1800,
        from_self: false,
        at_me: false,
        view: { kind: 'system', text: '"甲" 撤回了一条消息' },
      };
      wechat.reader.syncBatch = async (): Promise<SyncResult[]> => [
        { chat: 'wxid_a', missing: false, is_group: false, messages: [recalledMsg] },
      ];
      await wechat.syncChats('acc1', [{ chat: 'wxid_a', name: '甲', since: 1799, at: 1800 }]);
      expect(received.length).toBe(0);

      const afterRecall = await app.inject(
        `/api/wechat-kefu/messages?account=acc1&chat=wxid_a&limit=1000&version=${encodeURIComponent(backfillBody.version)}`,
      );
      const recallBody = afterRecall.json() as { unchanged: boolean; version: string; messages: { text: string; kind: string }[] };
      expect(recallBody.unchanged).toBe(false);
      expect(recallBody.version).not.toBe(backfillBody.version);
      expect(recallBody.messages.at(-1)).toMatchObject({ kind: 'system', text: '"甲" 撤回了一条消息' });

      //M 5. 模拟后端重启（新挂载的 readRoutes 实例有新 bootId）：旧 version 自动失效重拉快照。
      const restartedApp = fastify.default({ logger: false });
      pageRoutes.readRoutes(restartedApp, db, wechat, voice);
      try {
        const afterRestart = await restartedApp.inject(
          `/api/wechat-kefu/messages?account=acc1&chat=wxid_a&limit=1000&version=${encodeURIComponent(recallBody.version)}`,
        );
        const restartBody = afterRestart.json() as { unchanged: boolean; version: string; messages?: unknown[] };
        expect(restartBody.unchanged).toBe(false);
        expect(restartBody.messages?.length).toBe(801);
      } finally {
        await restartedApp.close();
      }
    } finally {
      await app.close();
    }
  });
});

//M 2026-11-15 00:46 EST：引擎原地改写解密缓存、不加锁，同一账号的引擎进程不能并发。exec 换成假的，不起 python。
describe('Reader 按账号排队', () => {
  test('同一账号同时两次：第二个等第一个结束才起；失败不卡后面；不同账号并行', async () => {
    const reader = new Reader('.', 'x', '');
    const log: string[] = [];
    let running = 0, peak = 0;
    const gates = new Map<string, () => void>();
    reader['exec'] = (account: string, args: string[]): Promise<string> => {
      const name = `${account}:${args[0] ?? ''}`;
      log.push(`起 ${name}`);
      running += 1; peak = Math.max(peak, running);
      return new Promise<string>((resolve, reject) => {
        gates.set(name, () => {
          running -= 1;
          log.push(`完 ${name}`);
          if (args[0] === 'bad') {
            reject(new Error('坏了'));
            return;
          }
          resolve('[]');
        });
      });
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const call = (account: string, command: string) => reader['run'](account, [command]);

    const a1 = call('acc1', 'bad');
    const a2 = call('acc1', 'second');
    const b1 = call('acc2', 'other');
    await tick();
    expect(log).toEqual(['起 acc1:bad', '起 acc2:other']);
    expect(peak).toBe(2);
    gates.get('acc1:bad')!();
    await expect(a1).rejects.toThrow('坏了');
    await tick();
    expect(log).toEqual(['起 acc1:bad', '起 acc2:other', '完 acc1:bad', '起 acc1:second']);
    gates.get('acc1:second')!();
    gates.get('acc2:other')!();
    expect(await a2).toBe('[]');
    expect(await b1).toBe('[]');
    expect(peak).toBe(2);
  });
});
