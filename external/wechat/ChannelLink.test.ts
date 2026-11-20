/** 合成缓存验证微信草稿和历史遵守渠道身份、会话范围和请求号。 */
import { expect, test } from 'bun:test';
import * as sqlite from 'bun:sqlite';
import * as fastify from 'fastify';
import * as linkModule from './ChannelLink.ts';
import * as protocol from './Protocol.ts';
import * as storeModule from './read/Store.ts';

test('微信草稿按请求号去重，历史按账号、会话和发送者稳定分页', async () => {
  const db = new sqlite.Database(':memory:');
  const app = fastify.default();
  const store = new storeModule.Store(db);
  const key = crypto.randomUUID();
  const headers = { [protocol.KEY_HEADER]: key };
  const channel = 'wechat-external';
  const link = new linkModule.ChannelLink(db, channel, 'http://127.0.0.1:9', key);
  link.mount(app);
  db.exec("INSERT INTO wechat_watch (account,chat,name,auto,last_time) VALUES ('a','chat','测试',0,1)");
  const common = { source: 's', create_time: 1, local_type: 1, at_me: false, from_self: false };
  store.save('a', 'chat', { ...common, local_id: 1, view: { sender: '甲', text: '第一条' } });
  store.save('a', 'chat', { ...common, local_id: 2, view: { sender: '乙', text: '第二条' } });
  store.save('a', 'chat', { ...common, local_id: 3, view: { sender: '甲', text: '第三条' } });
  store.save('a', 'other', { ...common, local_id: 3, view: { sender: '甲', text: '其他会话' } });
  store.save('b', 'chat', { ...common, local_id: 3, view: { sender: '甲', text: '其他账号' } });

  const reply = { channel, account: 'a', chat: 'chat', text: '草稿正文', requestId: 'reply-1' };
  const replyUrl = '/jmbots/v1/channel/reply';
  const historyUrl = '/jmbots/v1/channel/history';
  const history = { channel, account: 'a', chat: 'chat', limit: 1, senderId: '甲' };
  try {
    const missing = await app.inject({ method: 'POST', url: historyUrl, payload: history });
    expect(missing.statusCode).toBe(401);
    const wrong = { ...reply, channel: 'wechat' };
    const wrongChannel = await app.inject({ method: 'POST', url: replyUrl, headers, payload: wrong });
    expect(wrongChannel.statusCode).toBe(403);

    for (const draft of [reply, reply]) {
      const saved = await app.inject({ method: 'POST', url: replyUrl, headers, payload: draft });
      expect(saved.json<{ status: protocol.ReplyCallStatus }>()).toEqual({ status: 'draft' });
    }
    const conflict = { ...reply, text: '更改正文' };
    const refused = await app.inject({ method: 'POST', url: replyUrl, headers, payload: conflict });
    expect(refused.json()).toMatchObject({ status: 'failed' });
    const outbox = db.query('SELECT state, text FROM wechat_outbox').all();
    expect(outbox).toEqual([{ state: 'draft', text: '草稿正文' }]);

    const first = await app.inject({ method: 'POST', url: historyUrl, headers, payload: history });
    expect(first.json()).toMatchObject({
      ok: true, account: 'a', chat: 'chat', items: [{ nativeId: '["chat","s",3]', text: '第三条' }],
    });
    const before = first.json().next;
    expect(before).toBeString();
    const older = { ...history, before };
    const second = await app.inject({ method: 'POST', url: historyUrl, headers, payload: older });
    expect(second.json()).toMatchObject({ ok: true, items: [{ text: '第一条' }], next: null });

    for (const other of [{ ...older, chat: 'other' }, { ...older, account: 'b' }]) {
      const mismatch = await app.inject({ method: 'POST', url: historyUrl, headers, payload: other });
      expect(mismatch.json()).toMatchObject({ ok: false, error: { code: 'invalid_cursor' } });
    }
  } finally {
    await app.close();
    db.close();
  }
});
