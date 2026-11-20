/** 合成请求验证回调身份和持久化入站幂等。 */
import { expect, test } from 'bun:test';
import * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as bridgeModule from './ChannelBridge.ts';
import * as hostModule from './Host.ts';
import * as protocol from './Protocol.ts';
import * as specModule from './Spec.ts';

test('入站拒绝旧密钥和未登记渠道，只记下实际分派完成的消息号', async () => {
  const db = new sqlite.Database(':memory:');
  const ctx = new cordis.Context();
  const app = fastify.default();
  const secondApp = fastify.default();
  const specs = specModule.readPrograms({
    programs: [{ name: 'fixture', file: 'fixture', channels: [{ name: 'outside', bot: '样例机器人' }] }],
  });
  const host = new hostModule.Host(specs[0]!, import.meta.dir);
  let key = crypto.randomUUID();
  host.getKey = () => key;
  const hosts = new Map([['fixture', host]]);
  const bridge = new bridgeModule.ChannelBridge(ctx, hosts, db);
  bridge.mount(app);
  const oldKey = key;
  key = crypto.randomUUID();
  const headers = { [protocol.KEY_HEADER]: key };
  const url = '/api/programs/fixture/channel/message';
  const payload = {
    channel: 'outside',
    account: 'fixture-account',
    chat: 'fixture-chat',
    chatType: 'p2p',
    nativeId: 'fixture-message',
    sender: { id: 'fixture-sender' },
    text: '一条合成消息',
    role: 'owner',
  };

  let calls = 0;
  let fail = true;
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  ctx.on('channel/direct', async (message) => {
    calls += 1;
    expect(message.role).toBe('guest');
    expect(message.origin.address).toMatchObject({ owner: false, role: 'guest' });
    expect(message.targetBots).toEqual(['样例机器人']);
    if (fail) {
      received.resolve();
      await release.promise;
      throw new Error('合成分派失败');
    }
  });

  try {
    const missing = await app.inject({ method: 'POST', url, payload });
    expect(missing.statusCode).toBe(401);
    const stale = await app.inject({ method: 'POST', url, payload, headers: { [protocol.KEY_HEADER]: oldKey } });
    expect(stale.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'POST', url, headers, payload: { ...payload, channel: 'wechat' } });
    expect(wrong.statusCode).toBe(403);
    const bad = await app.inject({ method: 'POST', url, headers, payload: { ...payload, nativeId: '' } });
    expect(bad.statusCode).toBe(400);

    const first = app.inject({ method: 'POST', url, headers, payload });
    await received.promise;
    const concurrent = app.inject({ method: 'POST', url, headers, payload });
    await Bun.sleep(10);
    release.resolve();
    const failures = await Promise.all([first, concurrent]);
    expect(failures.map((response) => response.statusCode)).toEqual([500, 500]);
    expect(calls).toBe(1);

    fail = false;
    const accepted = await app.inject({ method: 'POST', url, headers, payload });
    expect(accepted.json()).toMatchObject({ status: 'accepted' });

    const second = new bridgeModule.ChannelBridge(new cordis.Context(), hosts, db);
    second.mount(secondApp);
    const duplicate = await secondApp.inject({ method: 'POST', url, headers, payload });
    expect(duplicate.json()).toMatchObject({ status: 'duplicate', messageId: accepted.json().messageId });
    expect(calls).toBe(2);
  } finally {
    release.resolve();
    await app.close();
    await secondApp.close();
    db.close();
  }
});
