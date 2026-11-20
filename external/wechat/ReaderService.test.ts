/** 合成引擎验证多账号归档、群提及过滤及历史补录边界。 */
import { expect, test } from 'bun:test';
import * as sqlite from 'bun:sqlite';
import * as util from 'node:util';
import * as fastify from 'fastify';
import * as historyModule from './HistoryCache.ts';
import * as protocol from './Protocol.ts';
import * as optionsModule from './ReadOptions.ts';
import * as serviceModule from './ReaderService.ts';
import * as readerModule from './read/PureReader.ts';
import * as stores from './read/Store.ts';

function message(localId: number, at: number, text: string, atMe = false, self = false): readerModule.RawMessage {
  return {
    source: 'fragment',
    local_id: localId,
    local_type: 1,
    create_time: at,
    from_self: self,
    at_me: atMe,
    view: { kind: 'text', text, sender: '合成发信人' },
  };
}

class FixtureReader extends readerModule.Reader {
  readonly history = new Map<string, readerModule.RawMessage[]>();
  readonly calls: Array<{ account: string; until: number }> = [];
  readonly limits: number[] = [];
  round = 0;
  failedAccount = '';
  failedHistory = false;

  constructor() {
    super('', '', '');
  }

  override accounts(): readerModule.Account[] {
    return ['a', 'b'].map((id) => ({ id, nickname: id, wxid: id }));
  }

  override async sessions(_account: string, limit: number): Promise<readerModule.ChatItem[]> {
    this.limits.push(limit);
    return ['group', 'archive-only'].map((chat) => ({
      username: chat, chat, is_group: true, unread: 0, last_message: '', timestamp: 100 + this.round,
    }));
  }

  override async syncBatch(
    account: string,
    chats: { chat: string; since: number | null }[],
  ): Promise<readerModule.SyncResult[]> {
    return chats.map(({ chat, since }) => {
      const messages = [message(1, 100, account + ' 存量', true)];
      if (this.round > 0) {
        messages.push(
          message(2, 101, account + ' 群里没提及'),
          message(3, 102, account + ' 按昵称提及', true),
          message(4, 103, account + ' 自己发的', true, true),
        );
      }
      return {
        chat,
        missing: false,
        error: account === this.failedAccount ? '合成错误，仅引擎内部' : undefined,
        is_group: true,
        messages: messages.filter((row) => since === null || row.create_time > since),
      };
    });
  }

  override async backfill(account: string, chat: string, until: number, limit: number): Promise<readerModule.SyncResult> {
    this.calls.push({ account, until });
    if (this.failedHistory) return { chat, missing: false, error: '模拟解密错误' };
    const rows = this.history.get(account + ':' + chat) ?? [];
    return { chat, missing: false, messages: rows.filter((row) => row.create_time < until).slice(-limit) };
  }
}

test('读取选项保留默认值，允许禁轮询及额外昵称，拒绝无效节拍和会话上限', () => {
  const values = util.parseArgs({
    args: ['--archive-all', '--interval-ms', '0', '--chat-limit', '7', '--at-names', '甲,乙'],
    options: optionsModule.READ_FLAGS,
  }).values;
  expect(optionsModule.getReadOptions(values)).toEqual({
    atNames: '甲,乙', config: { intervalMs: 0, chatLimit: 7, archiveAll: true },
  });
  expect(optionsModule.getReadOptions({}).config).toEqual({
    intervalMs: 3000, chatLimit: 5000, archiveAll: false,
  });
  expect(() => optionsModule.getReadOptions({ 'chat-limit': '0' })).toThrow('--chat-limit');
  expect(() => optionsModule.getReadOptions({ 'interval-ms': '2147483648' })).toThrow('--interval-ms');
});

test('归档与监听不会串账号，首轮、非监听、群未提及和自己发的只落库', async () => {
  const db = new sqlite.Database(':memory:');
  const reader = new FixtureReader();
  const service = new serviceModule.ReaderService(reader, db, { archiveAll: true, chatLimit: 7, intervalMs: 250 });
  const app = fastify.default();
  const received: protocol.InboundMessage[] = [];
  const signal = new AbortController().signal;
  reader.history.set('a:group', [message(9, 60, '已监听的更早历史'), message(4, 103, '同步边界外')]);
  app.post('/fake/channel/message', (request) => {
    received.push(request.body as protocol.InboundMessage);
    return { ok: true, status: 'accepted' };
  });
  try {
    const ready = await app.listen({ port: 0, host: '127.0.0.1' });
    //M 监听路由需要在 Fastify 开始监听前登记，独立应用复用同一套读取服务。
    const routes = fastify.default();
    try {
      service.connect(routes, 'wechat-test', ready + '/fake', crypto.randomUUID());
      for (const account of ['a', 'b']) {
        const watch = await routes.inject({
          method: 'PUT', url: '/api/wechat-kefu/watch', payload: { account, chat: 'group', watch: true },
        });
        expect(watch.statusCode).toBe(200);
      }
      await service.pollWatched(signal);
      expect(received).toEqual([]);
      const archived = db.query("SELECT text FROM wechat_messages WHERE account = 'a' AND chat = 'group' ORDER BY at");
      expect(archived.all()).toEqual([{ text: '已监听的更早历史' }, { text: 'a 存量' }]);

      reader.round = 1;
      await service.pollWatched(signal);
      expect(reader.limits).toEqual([7, 7, 7, 7]);
      expect(received.map((row) => [row.account, row.chat, row.text])).toEqual([
        ['a', 'group', 'a 按昵称提及'], ['b', 'group', 'b 按昵称提及'],
      ]);
      const records = db.query('SELECT account,chat,COUNT(*) AS n FROM wechat_messages GROUP BY account,chat');
      expect(records.all()).toEqual([
        { account: 'a', chat: 'archive-only', n: 4 }, { account: 'a', chat: 'group', n: 5 },
        { account: 'b', chat: 'archive-only', n: 4 }, { account: 'b', chat: 'group', n: 4 },
      ]);

      reader.failedAccount = 'a';
      await service.pollWatched(signal);
      expect(service.status.lastError).toContain('读取');
      expect(service.status.lastError).not.toContain('仅引擎内部');
      expect(received).toHaveLength(2);
    } finally {
      await routes.close();
    }
  } finally {
    await app.close();
    db.close();
  }
});

test('补录跨页覆盖秒级交界与零散缓存，错误可重试，真实空历史才标齐', async () => {
  const db = new sqlite.Database(':memory:');
  const reader = new FixtureReader();
  const store = new stores.Store(db);
  const history = new historyModule.HistoryCache(db, reader, store);
  const chat = 'scope';
  try {
    const archive = Array.from({ length: 505 }, (_, id) => {
      let at = id + 200;
      if (id === 4) at = 205;
      return message(id + 10, at, '合成历史');
    });
    reader.history.set('a:' + chat, archive);
    const oldest = message(1, 100, '已经缓存的一条更旧消息');
    const latest = message(800, 800, '已缓存最新消息');
    store.save('a', chat, oldest);
    store.save('a', chat, latest);
    store.save('b', chat, message(800, 800, '另一个账号'));

    await Promise.all([history.fill('a', chat), history.fill('a', chat)]);
    expect(reader.calls).toEqual([{ account: 'a', until: 801 }]);
    expect(history.isComplete('a', chat)).toBe(false);

    reader.failedHistory = true;
    await expect(history.fill('a', chat)).rejects.toMatchObject({ code: 'history_error' });
    expect(history.isComplete('a', chat)).toBe(false);
    const failed = reader.calls.at(-1);
    reader.failedHistory = false;
    await history.fill('a', chat);
    expect(reader.calls.at(-1)).toEqual(failed);
    expect(history.isComplete('a', chat)).toBe(true);
    const count = db.query('SELECT COUNT(*) AS n FROM wechat_messages WHERE account = ? AND chat = ?');
    expect(count.get('a', chat)).toEqual({ n: 507 });
    expect(count.get('b', chat)).toEqual({ n: 1 });

    await history.fill('b', 'empty');
    expect(history.isComplete('b', 'empty')).toBe(true);
    expect(count.get('b', 'empty')).toEqual({ n: 0 });
    await expect(history.fill('unknown', chat)).rejects.toMatchObject({ code: 'account_unavailable' });

    const dense = Array.from({ length: 501 }, (_, id) => message(id, 100, '同秒历史'));
    reader.history.set('a:dense', dense);
    await history.fill('a', 'dense');
    await expect(history.fill('a', 'dense')).rejects.toMatchObject({ code: 'history_incomplete' });
    expect(history.isComplete('a', 'dense')).toBe(false);
  } finally {
    db.close();
  }
});

test('历史回调补缓存不足的页，明确区分失败和空历史', async () => {
  const db = new sqlite.Database(':memory:');
  const reader = new FixtureReader();
  const app = fastify.default();
  const service = new serviceModule.ReaderService(reader, db);
  const key = crypto.randomUUID();
  const channel = 'wechat-test';
  const headers = { [protocol.KEY_HEADER]: key };
  const url = '/jmbots/v1/channel/history';
  const query = { channel, account: 'a', chat: 'scope', limit: 1, senderId: '合成发信人' };
  service.connect(app, channel, 'http://127.0.0.1:9', key);
  try {
    reader.failedHistory = true;
    const failed = await app.inject({ method: 'POST', url, headers, payload: query });
    expect(failed.json()).toMatchObject({ ok: false, error: { code: 'history_error' } });

    reader.failedHistory = false;
    reader.history.set('a:scope', [message(1, 100, '早一条'), message(2, 100, '晚一条')]);
    const first = await app.inject({ method: 'POST', url, headers, payload: query });
    expect(first.json()).toMatchObject({ ok: true, items: [{ text: '晚一条' }] });
    const before = first.json<{ next: string }>().next;
    expect(before).toBeString();
    const next = await app.inject({ method: 'POST', url, headers, payload: { ...query, before } });
    expect(next.json()).toMatchObject({ ok: true, items: [{ text: '早一条' }], next: null });

    const cross = { ...query, account: 'b', before };
    const denied = await app.inject({ method: 'POST', url, headers, payload: cross });
    expect(denied.json()).toMatchObject({ ok: false, error: { code: 'invalid_cursor' } });
    const empty = await app.inject({ method: 'POST', url, headers, payload: { ...query, account: 'b' } });
    expect(empty.json()).toMatchObject({ ok: true, account: 'b', items: [], next: null });
    await service.pollWatched(new AbortController().signal);
    expect(reader.limits).toEqual([]);
  } finally {
    await service.drain();
    await app.close();
    db.close();
  }
});
