/** 外置客服确认入口与 AI 起草回调的合成验证（零跨目录 `src7/` 引用，Fastify 注入不会连接真实微信）。 */
import * as sqlite from 'bun:sqlite';
import * as fastify from 'fastify';
import { expect, spyOn, test } from 'bun:test';
import * as approved from './ApprovedSend.ts';
import * as kefu from './KefuRoutes.ts';
import * as protocol from './Protocol.ts';
import * as store from './read/Store.ts';


const api = '/api/wechat-kefu';
const key = 'synthetic-key';
const headers = { [protocol.KEY_HEADER]: key };
const account = 'synthetic-account';
const chat = 'synthetic-chat';
const text = '合成草稿';
const callback = 'http://127.0.0.1:1/api/programs/synthetic';

/** 创建内存数据库和带回执的合成发件器，沿实际批准入口挂载。 */
function setup(confirmed: boolean) {
  const app = fastify.default();
  const db = new sqlite.Database(':memory:');
  new store.Store(db);
  const watch = 'INSERT INTO wechat_watch (account, chat, name, auto) VALUES (?, ?, ?, 0)';
  db.query(watch).run(account, chat, '合成会话');
  const draft = 'INSERT INTO wechat_outbox (account, chat, name, text, state, note, at) VALUES (?, ?, ?, ?, ?, ?, 1)';
  db.query(draft).run(account, chat, '合成会话', text, 'draft', '');
  app.put(`${api}/watch`, () => ({ ok: true }));

  const calls: unknown[] = [];
  const sender = {
    async send(target: { account: string; chat: string }, body: string) {
      calls.push({ account: target.account, chat: target.chat, text: body });
      return { confirmed };
    },
    close() {},
  };
  const reader = { accounts: () => [{ id: account, wxid: 'mock', nickname: '合成账号' }] };
  const bridge = { key, channel: 'synthetic-wechat', callback, send: { enabled: true } };
  const service = new approved.ApprovedSend(db, bridge.channel, reader, sender);
  service.mount(app, key);
  kefu.mountKefu(app, db, bridge);
  return {
    app,
    calls,
    db,
    async close() {
      await app.close();
      await service.close();
      db.close();
    },
  };
}

test('客服页只把经宿主核验的明确操作交给主站，旧单步确认无法发出', async () => {
  const { app, calls, close } = setup(true);
  const sent: unknown[] = [];
  const mock = async (...[input, options]: Parameters<typeof fetch>): Promise<Response> => {
    expect(String(input)).toBe(callback + '/channel/approval');
    const received = new Headers(options?.headers);
    expect(received.get(protocol.KEY_HEADER) === key).toBe(true);
    const payload = JSON.parse(String(options?.body)) as { action: string };
    sent.push(payload);
    if (payload.action === 'prepare') {
      return Response.json({ intent: { intentId: 'intent-1', digest: 'digest-1', account, chat, text } });
    }
    return Response.json({ intent: { status: 'sent', intentId: 'intent-1' } });
  };
  const stub = spyOn(globalThis, 'fetch').mockImplementation(mock as typeof fetch);
  try {
    const capabilities = `${api}/capabilities`;
    const url = `${api}/outbox/send`;
    const payload = { id: 1, account: 'other', chat: 'other', text: '不能覆盖原文' };
    const direct = await app.inject(capabilities);
    expect(direct.json<{ channel: string; watch: boolean; send: string }>()).toEqual({
      channel: 'synthetic-wechat', watch: false, send: 'approval',
    });
    const host = await app.inject({ url: capabilities, headers });
    expect(host.json<{ channel: string; watch: boolean; send: string }>()).toEqual({
      channel: 'synthetic-wechat', watch: true, send: 'ready',
    });
    const denied = await app.inject({ method: 'POST', url, payload });
    expect(denied.statusCode).toBe(401);
    const watchUrl = `${api}/watch`;
    const watchDenied = await app.inject({ method: 'PUT', url: watchUrl });
    expect(watchDenied.statusCode).toBe(401);
    const watches = await app.inject(watchUrl);
    expect(watches.json()).toMatchObject([{ account, chat }]);
    expect(calls).toEqual([]);

    const legacy = { method: 'POST', url, headers, payload } as const;
    expect((await app.inject(legacy)).statusCode).toBe(409);
    expect(sent).toEqual([]);

    const prepare = { ...legacy, payload: { action: 'prepare', draftId: 1 } };
    const prepared = await app.inject(prepare);
    expect(prepared.json()).toMatchObject({ intent: { intentId: 'intent-1', account, chat, text } });
    const confirm = {
      action: 'confirm',
      intentId: 'intent-1',
      observedIntentDigest: 'digest-1',
      interactionId: 'click-1',
      decision: 'approve',
    };
    const approvedRes = await app.inject({ ...legacy, payload: confirm });
    expect(approvedRes.json()).toMatchObject({ intent: { status: 'sent', intentId: 'intent-1' } });
    expect(sent).toEqual([prepare.payload, confirm]);
    expect(calls).toEqual([]);
  } finally {
    stub.mockRestore();
    await close();
  }
});

test('主站断线时外置客服不回退本地批准，原意图仍可只读核对', async () => {
  const { app, calls, db, close } = setup(false);
  let connected = false;
  const mock = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    expect(String(input)).toBe(callback + '/channel/approval');
    if (!connected) throw new Error('合成断线');

    return Response.json({ intent: { status: 'uncertain', intentId: 'intent-1' } });
  };
  const stub = spyOn(globalThis, 'fetch').mockImplementation(mock as typeof fetch);
  try {
    const url = `${api}/outbox/send`;
    const method = 'POST' as const;
    const confirm = { method, url, headers, payload: { action: 'confirm', intentId: 'intent-1' } };
    expect((await app.inject(confirm)).statusCode).toBe(503);
    connected = true;
    const status = { method, url, headers, payload: { action: 'status', intentId: 'intent-1' } };
    expect((await app.inject(status)).json()).toMatchObject({ intent: { status: 'uncertain' } });

    const insert = 'INSERT INTO wechat_send_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    db.query(insert).run(
      'synthetic-wechat', 'kefu-draft:1:main-uuid', 'approval-1', 1,
      account, chat, text, 'uncertain', '待核对', 1, 1,
    );
    const drafts = await app.inject(`${api}/drafts`);
    expect(drafts.json()).toMatchObject([{ id: 1, state: 'uncertain', note: '待核对' }]);
    expect(calls).toEqual([]);
  } finally {
    stub.mockRestore();
    await close();
  }
});

test('仅已监听会话能让主站无工具起草，结果只写外置草稿表', async () => {
  const { app, db, calls, close } = setup(true);
  const main = fastify.default();
  const draftedRequests: Array<{ channel?: unknown; lines?: unknown }> = [];
  main.post('/api/programs/synthetic/channel/draft', (request, reply) => {
    if (!protocol.isSameKey(key, request.headers[protocol.KEY_HEADER])) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as { channel?: unknown; lines?: unknown };
    draftedRequests.push(body);
    return { text: '这是合成建议。' };
  });
  await main.ready();

  const message = 'INSERT INTO wechat_messages (account,chat,source,local_id,at,from_self,kind,sender,text)'
    + ' VALUES (?,?,?,?,?,?,?,?,?)';
  const insert = db.query(message);
  insert.run(account, chat, 'fixture', 1, 1, 0, 'text', '对面', '这是当前会话。');
  insert.run(account, chat, 'fixture', 2, 2, 1, 'text', '', '这是本人的记录。');
  insert.run(account, 'another-chat', 'fixture', 3, 3, 0, 'text', '另一位', '不应送入模型。');

  const mock = async (...[input, options]: Parameters<typeof fetch>): Promise<Response> => {
    expect(String(input)).toBe(callback + '/channel/draft');
    const payload = JSON.parse(String(options?.body)) as object;
    const given = new Headers(options?.headers);
    const reply = await main.inject({
      method: 'POST',
      url: '/api/programs/synthetic/channel/draft',
      payload,
      headers: { [protocol.KEY_HEADER]: given.get(protocol.KEY_HEADER) ?? '' },
    });
    return new Response(reply.body, { status: reply.statusCode });
  };
  const stub = spyOn(globalThis, 'fetch').mockImplementation(mock as typeof fetch);
  try {
    const url = `${api}/draft`;
    const post = { method: 'POST' as const, url, payload: { account, chat } };
    expect((await app.inject(post)).statusCode).toBe(401);
    const unwatched = { ...post, headers, payload: { account, chat: 'another-chat' } };
    expect((await app.inject(unwatched)).statusCode).toBe(400);
    expect(draftedRequests).toEqual([]);

    const created = await app.inject({ ...post, headers });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: 2, text: '这是合成建议。', account, chat, state: 'draft' });
    expect(draftedRequests).toEqual([{
      channel: 'synthetic-wechat',
      lines: ['对面：这是当前会话。', '我方：这是本人的记录。'],
    }]);
    expect(calls).toEqual([]);
    const count = db.query('SELECT COUNT(*) AS n FROM wechat_send_requests').get();
    expect(count).toEqual({ n: 0 });
  } finally {
    stub.mockRestore();
    await close();
    await main.close();
  }
});
