/** 只用合成账号、窗口发送器与本地测试数据库验收批准发件。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as stream from 'node:stream';
import * as sqlite from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as fastify from 'fastify';
import * as sendModule from './ApprovedSend.ts';
import * as linkModule from './ChannelLink.ts';
import * as licenseModule from './License.ts';
import * as protocol from './Protocol.ts';
import * as storeModule from './read/Store.ts';


const channel = 'synthetic-wechat';
const key = 'synthetic-host-key';
const account = 'mock-account';
const room = 'mock-room';
const bodyText = '合成消息正文';
type Outcome = { status: protocol.ReplyCallStatus; reason?: string };
const localClosers: (() => Promise<void> | void)[] = [];


afterEach(async () => {
  for (const close of localClosers.splice(0).reverse()) {
    await close();
  }
});


/** 构造宿主批准包，不访问真实账号或审批服务。 */
function makeCall(requestId: string, expiresAt = Date.now() + 60_000) {
  const approvalId = `approval-${requestId}`;
  const approval = { id: approvalId, state: 'approved', expiresAt };
  return { requestId, channel, account, chat: room, text: bodyText, approval };
}


/** 挂合成监听、账号和可控发送器，现有草稿接口共用同一测试库。 */
function fixture(options: {
  db?: sqlite.Database;
  enabled?: boolean;
  perform?: () => Promise<Record<string, unknown>>;
} = {}) {
  const db = options.db ?? new sqlite.Database(':memory:');
  if (options.db === undefined) {
    //M 独立拥有库的夹具最后关闭它，借用库的夹具只关闭自己的路由和队列。
    localClosers.push(() => db.close());
    new storeModule.Store(db);
    const insert = 'INSERT INTO wechat_watch (account, chat, name, auto) VALUES (?, ?, ?, 0)';
    db.query(insert).run(account, room, '合成房间');
  }

  const connected = [{ id: account, wxid: 'mock-wxid', nickname: '合成账号' }];
  const reader = { accounts: () => connected };
  const calls: { target: { account: string; chat: string; name: string; nickname: string }; text: string; id: string }[] = [];
  let closed = false;
  const mock = {
    async send(target: (typeof calls)[number]['target'], text: string, id: string) {
      calls.push({ target, text, id });
      if (options.perform !== undefined) return options.perform();

      return { confirmed: true };
    },
    close: () => { closed = true; },
  };
  let sender: typeof mock | undefined = mock;
  if (options.enabled === false) {
    sender = undefined;
  }

  //M 使用同一真实 HTTP 路由与 SQLite 查询，但把所有窗口操作替换为本地函数。
  const app = fastify.default({ logger: false });
  const service = new sendModule.ApprovedSend(db, channel, reader, sender);
  service.mount(app, key);
  localClosers.push(async () => {
    await service.close();
    await app.close();
  });

  const submit = (payload: unknown, token = key) => {
    const headers = { [protocol.KEY_HEADER]: token, 'content-type': 'application/json' };
    const json = JSON.stringify(payload);
    //M Fastify 注入不监听端口，也不会调用宿主或真实微信。
    return app.inject({ method: 'POST', url: sendModule.SEND_ROUTE, headers, payload: json });
  };
  return { db, app, service, submit, calls, connected, getClosed: () => closed };
}


/** 等请求已经占用发件号，再改变名单或关停，保证测试覆盖排队后的复查。 */
async function waitReserved(db: sqlite.Database, requestId: string): Promise<void> {
  const sql = 'SELECT 1 FROM wechat_send_requests WHERE request_id = ?';
  const row = db.query(sql);
  const deadline = Date.now() + 1500;
  while (row.get(requestId) === null && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(row.get(requestId)).not.toBeNull();
}


test('默认只起草，普通 reply 与发送批准入口彼此隔离', async () => {
  const world = fixture({ enabled: false });
  const link = new linkModule.ChannelLink(world.db, channel, 'http://127.0.0.1:1', key);
  link.mount(world.app);
  const headers = { [protocol.KEY_HEADER]: key };
  const call = makeCall('draft');
  const request = { method: 'POST', url: '/jmbots/v1/channel/reply', headers, payload: call } as const;

  //M 即使正文里含批准字段，现有回复路由仍只写草稿。
  const drafted = await world.app.inject(request);
  expect(drafted.json<Outcome>()).toEqual({ status: 'draft' });
  const result = await world.submit(call);
  expect(result.json<Outcome>()).toEqual({ status: 'failed', reason: '本实例只存草稿' });
  const outbox = world.db.query('SELECT state, text FROM wechat_outbox').all();
  expect(outbox).toEqual([{ state: 'draft', text: bodyText }]);
  expect(world.calls).toHaveLength(0);
});


test('拒绝冒名、其他渠道、普通回复、未批准和模糊账号', async () => {
  const world = fixture();
  const call = makeCall('deny');
  const unauthorized = await world.submit(call, 'wrong-key');
  expect(unauthorized.statusCode).toBe(401);
  const wrongChannel = await world.submit({ ...call, channel: 'other' });
  expect(wrongChannel.statusCode).toBe(403);
  const noApproval = await world.submit({ ...call, approval: undefined, kind: 'final' });
  expect(noApproval.statusCode).toBe(400);
  const declined = { ...call.approval, state: 'rejected' };
  const unapproved = await world.submit({ ...call, approval: declined });
  expect(unapproved.statusCode).toBe(400);
  const noAccount = await world.submit({ ...call, account: '' });
  expect(noAccount.statusCode).toBe(400);
  expect(world.calls).toHaveLength(0);
  expect(world.db.query('SELECT state FROM wechat_send_requests').all()).toEqual([]);
});


test('已回读请求跨实例再查返回原结果，不能替换目标、正文或复用批准号', async () => {
  const world = fixture();
  const call = makeCall('sent');
  const sent = await world.submit(call);
  expect(sent.json<Outcome>()).toEqual({ status: 'sent' });
  expect(world.calls).toEqual([{
    target: { account, chat: room, name: '合成房间', nickname: '合成账号' },
    text: bodyText,
    id: expect.stringMatching(/^jmbots-external-wechat-[0-9a-f]{64}$/u),
  }]);

  //M 另建队列复用已持久化的库，原请求无需连接账号或窗口也可取回终态。
  const restarted = fixture({ db: world.db });
  restarted.connected.length = 0;
  const replay = await restarted.submit(call);
  expect(replay.json<Outcome>()).toEqual({ status: 'sent' });
  const differentText = await restarted.submit({ ...call, text: '换掉原文' });
  const differentChat = await restarted.submit({ ...call, chat: 'mock-other-room' });
  const reusedApproval = await restarted.submit({ ...call, requestId: 'different' });
  expect(differentText.json<Outcome>()).toMatchObject({ status: 'failed' });
  expect(differentChat.json<Outcome>()).toMatchObject({ status: 'failed' });
  expect(reusedApproval.json<Outcome>()).toMatchObject({ status: 'failed' });
  expect(restarted.calls).toHaveLength(0);
});


test('无回读和工具异常均保存不确定，重试与中断后的占位都不会重发', async () => {
  const world = fixture({ perform: async () => ({ confirmed: false }) });
  const first = makeCall('no-confirmation');
  const unconfirmed = await world.submit(first);
  expect(unconfirmed.json<Outcome>()).toMatchObject({ status: 'uncertain' });
  const replay = await world.submit(first);
  expect(replay.json<Outcome>()).toEqual(unconfirmed.json<Outcome>());
  expect(world.calls).toHaveLength(1);

  const broken = fixture({ db: world.db, perform: async () => { throw new Error('fake worker timeout'); } });
  const second = makeCall('worker-timeout');
  const lost = await broken.submit(second);
  expect(lost.json<Outcome>()).toMatchObject({ status: 'uncertain' });
  expect(broken.calls).toHaveLength(1);

  //M 模拟在已占用发送号但尚未写回时丢失进程，重启只查结论。
  const sql = "UPDATE wechat_send_requests SET state = 'sending' WHERE request_id = ?";
  world.db.query(sql).run(second.requestId);
  const restarted = fixture({ db: world.db });
  const stale = await restarted.submit(second);
  expect(stale.json<Outcome>()).toMatchObject({ status: 'uncertain' });
  expect(restarted.calls).toHaveLength(0);
});


test('排到发送时复查监听名单、账号与批准期限', async () => {
  const latch = Promise.withResolvers<Record<string, unknown>>();
  const world = fixture({ perform: () => latch.promise });
  const first = world.submit(makeCall('holding'));
  const invalidated = world.submit(makeCall('withdrawn'));
  try {
    await waitReserved(world.db, 'withdrawn');
    const remove = 'DELETE FROM wechat_watch WHERE account = ? AND chat = ?';
    world.db.query(remove).run(account, room);
  } finally {
    latch.resolve({ confirmed: true });
  }
  expect((await first).json<Outcome>()).toEqual({ status: 'sent' });
  expect((await invalidated).json<Outcome>()).toEqual({ status: 'failed', reason: '微信会话已不在监听名单' });
  const expired = makeCall('expired', Date.now() - 1);
  expect((await world.submit(expired)).json<Outcome>()).toEqual({ status: 'failed', reason: '发送批准已过期' });
  const watched = 'INSERT INTO wechat_watch (account, chat, name, auto) VALUES (?, ?, ?, 0)';
  world.db.query(watched).run(account, room, '合成房间');
  world.connected.length = 0;
  const offline = await world.submit(makeCall('offline'));
  expect(offline.json<Outcome>()).toEqual({ status: 'failed', reason: '微信账号尚未连接' });
  expect(world.calls).toHaveLength(1);
});


test('并发重试共用一次发送，关停等待在途、拒绝排队和新请求', async () => {
  const latch = Promise.withResolvers<Record<string, unknown>>();
  const world = fixture({ perform: () => latch.promise });
  const call = makeCall('in-flight');
  const first = world.submit(call);
  const duplicate = world.submit(call);
  const queued = world.submit(makeCall('queued'));
  let drained: Promise<void> | undefined;
  try {
    await waitReserved(world.db, 'queued');
    drained = world.service.close();
    expect(world.getClosed()).toBe(false);
    const afterStop = await world.submit(makeCall('after-stop'));
    expect(afterStop.json<Outcome>()).toEqual({ status: 'failed', reason: '微信发送正在关停' });
  } finally {
    latch.resolve({ confirmed: true });
  }
  expect((await first).json<Outcome>()).toEqual({ status: 'sent' });
  expect((await duplicate).json<Outcome>()).toEqual({ status: 'sent' });
  expect((await queued).json<Outcome>()).toEqual({ status: 'failed', reason: '微信发送正在关停' });
  await drained;
  expect(world.getClosed()).toBe(true);
  expect(world.calls).toHaveLength(1);
});

test('独立进程只在已登记渠道挂批准接口，显式启用仍需合成监听与账号', async () => {
  const root = fs.mkdtempSync(path.join(import.meta.dir, '.approved-send-process-test-'));
  const database = path.join(root, 'wechat.db');
  const db = new sqlite.Database(database);
  const page = path.join(root, 'index.html');
  const entry = path.join(import.meta.dir, 'Main.ts');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubHex = licenseModule.exportPublicKeyHex(publicKey);
  const testToken = licenseModule.signLicenseToken({
    product: licenseModule.LICENSE_PRODUCT_ID,
    licenseId: 'lic-approved-send-test',
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 3_600_000,
    features: [licenseModule.REQUIRED_FEATURE],
  }, privateKey);
  fs.writeFileSync(path.join(root, 'license.json'), JSON.stringify({ token: testToken }), 'utf8');
  const env = { ...process.env, [protocol.KEY_ENV]: key, [protocol.CALLBACK_ENV]: 'http://127.0.0.1:1' };
  const argv = [
    process.execPath,
    entry,
    '--data',
    root,
    '--page',
    page,
    '--channel',
    channel,
    '--send',
    '--license-pubkey',
    pubHex,
  ];
  let child: Bun.Subprocess<'ignore', 'pipe', 'inherit'> | undefined;
  let lines: readline.Interface | undefined;
  try {
    //M 只在测试目录放模拟监听，从未注册的引擎目录启动，账号检查挡住窗口调用。
    new storeModule.Store(db);
    const insert = 'INSERT INTO wechat_watch (account, chat, name, auto) VALUES (?, ?, ?, 0)';
    db.query(insert).run(account, room, '合成房间');
    db.close();
    fs.writeFileSync(page, '<!doctype html><title>合成发送测试</title>');
    const options = { env, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', windowsHide: true } as const;
    child = Bun.spawn(argv, options);
    const raw = child.stdout as unknown as Parameters<typeof stream.Readable.fromWeb>[0];
    const input = stream.Readable.fromWeb(raw);
    lines = readline.createInterface({ input });
    const output = lines;
    const first = await Promise.race([
      new Promise<string>((resolve) => output.once('line', resolve)),
      child.exited.then((code) => { throw new Error(`外置发送测试进程提前退出 ${code}`); }),
    ]);
    const ready = JSON.parse(first) as { port: number };

    //M 使用真实独立进程的环回接口验证参数接线，真实引擎不在这个测试目录。
    const base = `http://127.0.0.1:${ready.port}`;
    const route = `${base}${sendModule.SEND_ROUTE}`;
    const headers = { [protocol.KEY_HEADER]: key, 'content-type': 'application/json' };
    const payload = makeCall('entry');
    const request = { method: 'POST', headers, body: JSON.stringify(payload) };
    const refused = await fetch(route, request);
    expect(await refused.json()).toEqual({ status: 'failed', reason: '微信账号尚未连接' });
    const exit = await fetch(`${base}/jmbots/v1/exit`, { method: 'POST' });
    expect(await exit.json()).toEqual({ ok: true });
    expect(await child.exited).toBe(0);
  } finally {
    //M 只回收这个测试自己启动的子进程和创建的隔离目录。
    lines?.close();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    await child?.exited;
    db.close();
    const resolved = path.resolve(root);
    const prefix = path.join(import.meta.dir, '.approved-send-process-test-');
    if (resolved.startsWith(prefix)) fs.rmSync(resolved, { recursive: true, force: true });
  }
}, 15_000);
