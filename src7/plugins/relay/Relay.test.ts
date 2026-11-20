/**
 * relay 接多个外部助手的离线测试（2026-11-16，按任务书 20261116_relay多助手和runs编译.md 第 2 步补）。
 * 跑法：bun test ./src7/plugins/relay/Relay.test.ts（test:src7 跑 ./src7/plugins 时一起跑到）。
 * 不起整个服务：用一个假的 ctx（内存库、假机器人、假会话），接口用真的 fastify inject 调；
 * A 的 webhook 是本机临时起的假服务，只记收到几次。
 * 查的是：前缀转给对的助手、回执和回信的署名、inbox 的 helper 筛选、webhook 只推配了的那个、
 * 旧库补 helper 栏、helpers 写错 apply 抛错、chat 主动发挂到对的助手上、带附件的话三处都给 files、
 * 前缀不分大小写且后面可跟标点或汉字；
 * 0.7.16：收件的 owner、sender、chat、chatName（入库、接口、jsonl、webhook、老库补栏；都读飞书写进地址的），
 * 飞书群登记了 relay: model 的会话才有 relay_send，机器人写的 relay 照旧，旧的按聊天种类写法抛错。
 */
import { afterAll, describe, expect, test, vi } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import fastify from 'fastify';
import * as events from '../../utils/RequestEvent.ts';
import type * as dispatchModule from '../bots/Dispatch.ts';
import * as channels from '../channels/index.ts';
import * as dbModule from '../db/index.ts';
import * as decisionModule from '../work-decision/index.ts';
import type * as decisionTypes from '../work-decision/Types.ts';
import * as relayModule from './index.ts';

/** 临时运行时目录。 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-relay-'));

/** A 的假 webhook：记下收到的每一次。 */
const hooks: Record<string, unknown>[] = [];
const hookServer = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    hooks.push(await request.json() as Record<string, unknown>);
    return Response.json({ ok: true });
  },
});

/** 测完要关的东西：假 webhook、relay 的定时器。 */
const closers: (() => void)[] = [() => { void hookServer.stop(true); }];
afterAll(() => {
  for (const close of closers) close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 两个助手：A 配了假 webhook，B 不配。 */
const HELPERS = [
  { name: 'A', prefixes: ['a '], webhook_url: `http://127.0.0.1:${String(hookServer.port)}/hook` },
  { name: 'B', prefixes: ['b '] },
];

/** 测试机器人名：普通机器人（不是 relay 机器人），靠前缀转话。 */
const BOT = '测试机器人';

/** 一场假会话。 */
interface FakeSession {
  id: string;
  row: {
    id: string; bot: string; kind: string; parent?: string; state: string; channel?: string; address?: unknown;
    customer?: string; messages: { role: string; content: unknown; timestamp: number; [key: string]: unknown }[];
    /** 这一轮最后的话（骨架一轮结束时写）。 */
    reply?: string;
    /** relay 标了它，bots 就不替它自动发。 */
    quiet?: boolean;
  };
  run: () => Promise<void>;
}

/**
 * 假机器人结果队列。监听后同键回 duplicate，首次接收回 queued。
 */
interface FakeResultQueue {
  /** 排进来的结果，按先后。 */
  accepted: dispatchModule.ResultInput[];
  /** 下一次主动拒绝。 */
  failNext: boolean;
  /** 开始监听投递事件。 */
  listen: () => void;
}

/** 模拟断电：beforeWrite 回答还没写进对话就停；afterWrite 写进对话、存了，还没发 session/change 就停。用一次就回 none。 */
type CrashMode = 'none' | 'beforeWrite' | 'afterWrite';

/** 一套假的运行环境。 */
interface World {
  ctx: cordis.Context;
  db: Database;
  app: ReturnType<typeof fastify>;
  sessions: Map<string, FakeSession>;
  /** 打开过的会话号，包括找不到的。 */
  openedSessions: string[];
  /** 每一步填进 request.answer 的话，按先后。 */
  answers: string[];
  /** 用户发一句话：走 bot/receive，再推那场会话一步；回这一步的回答。 */
  say: (text: string, address?: unknown) => Promise<string>;
  /** 测试机器人；改它的 config 再 apply。 */
  bot: { name: string; config: Record<string, unknown> };
  /** relay 登记的工具。 */
  tools: { definition: { name: string; description: string }; run: (args: Record<string, unknown>, session: unknown) => unknown }[];
  /** 新开一场会话（不走 bot/receive）。 */
  open: (options: { bot: string; kind: string; customer?: string }) => FakeSession;
  /** 照骨架给这场会话备一步请求（带 relay_send 和别的工具），挨个问 session/before-model；回问完的工具名和系统提示词。 */
  ask: (session: FakeSession) => { tools: string[]; system: string[] };
  /** 走模型的会话把回信排到这里。 */
  resultQueue: FakeResultQueue;
  /** 下一步怎么断电。 */
  crash: { mode: CrashMode };
  /** 发出过的事件（按顺序）。 */
  emitted: { name: string; args: unknown[] }[];
  /** 各事件的监听（测试里挂假飞书用）。 */
  handlers: Map<string, ((...args: unknown[]) => void)[]>;
  /** 模拟重启：发一次 ready（relay 在 ready 时把没送的回信再送一遍）。 */
  restart: () => void;
}

/**
 * 搭一套假的 ctx。
 * @param db 用哪个库（旧库测试先在里面建好老表）。
 * @returns 假环境；还没 apply relay。
 */
function world(db = new Database(':memory:')): World {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const sessions = new Map<string, FakeSession>();
  const openedSessions: string[] = [];
  const answers: string[] = [];
  const emitted: { name: string; args: unknown[] }[] = [];
  const app = fastify();
  let serial = 0;

  const crash: { mode: CrashMode } = { mode: 'none' };

  /**
   * 推一步：照骨架的样子发 session/before-model，插件填了 answer 就原样接进对话（Session.append 接的就是 answer 本身，
   * 带着插件加的字段，比如 relayReplyId），再改状态、发 session/change。crash 照它停在半路。
   */
  const step = async (session: FakeSession): Promise<void> => {
    session.row.state = 'running';
    const request: { session: FakeSession; answer?: { content: { type: string; text: string }[]; [key: string]: unknown } } = { session };
    for (const handler of handlers.get('session/before-model') ?? []) handler(request);

    //M 断电在写进对话之前：什么都没留下。
    if (crash.mode === 'beforeWrite') {
      crash.mode = 'none';
      return;
    }

    const said = request.answer?.content.map((part) => part.text).join('') ?? '';
    answers.push(said);
    session.row.messages.push({ ...request.answer, role: 'assistant', content: request.answer?.content ?? [], timestamp: Date.now() });

    //M 断电在写进对话之后、改状态之前：回答在对话里，session/change 没发。
    if (crash.mode === 'afterWrite') {
      crash.mode = 'none';
      return;
    }

    //M 照骨架：一轮结束写下最后的话，再改状态、发 session/change。
    session.row.reply = said;
    session.row.state = 'done';
    for (const handler of handlers.get('session/change') ?? []) handler(session);
    await Promise.resolve();
  };

  const make = (options: { bot: string; kind: string; customer?: string }): FakeSession => {
    serial += 1;
    const id = `s${String(serial)}`;
    const session: FakeSession = {
      id,
      row: { id, bot: options.bot, kind: options.kind, state: 'done', messages: [], ...(options.customer === undefined ? {} : { customer: options.customer }) },
      run: () => step(session),
    };
    sessions.set(id, session);
    return session;
  };

  const bot = { name: BOT, config: {} as Record<string, unknown>, hand: () => undefined };
  const tools: World['tools'] = [];
  const dbService = new dbModule.Db(new cordis.Context(), db);
  const fake = {
    db: dbService,
    http: { app },
    resources: {
      db,
      root,
      get raw() {
        const config = { ...bot.config, name: bot.name };
        return { bots: [config] };
      },
      ensureRuntimeDir: (...parts: string[]): string => {
        const full = path.join(root, ...parts);
        fs.mkdirSync(full, { recursive: true });
        return full;
      },
    },
    tools: { register: (spec: World['tools'][number]) => { tools.push(spec); } },
    sessions: {
      find: (where: { bot: string; kind: string; customer?: string }) => [...sessions.values()]
        .filter((one) => one.row.bot === where.bot && one.row.kind === where.kind && one.row.customer === where.customer)
        .map((one) => one.row),
      create: make,
      open: (id: string) => {
        openedSessions.push(id);
        const found = sessions.get(id);
        if (found === undefined) throw new Error(`没有这场会话：${id}`);
        return found;
      },
    },
    bots: {
      list: () => [bot],
      get: (name: string) => (name === BOT ? bot : undefined),
      route: (session: FakeSession, origin: { channel?: string; address?: unknown }) => {
        if (origin.channel !== undefined) session.row.channel = origin.channel;
        if (origin.address !== undefined) session.row.address = origin.address;
      },
      say: () => undefined,
    },
    on: (name: string, handler: (...args: unknown[]) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {
        handlers.set(name, (handlers.get(name) ?? []).filter((one) => one !== handler));
        return true;
      };
    },
    //M 记下发出的事件，同时叫醒挂了同名监听的（发文件请求的回执靠它回到 relay）。
    emit: (name: string, ...args: unknown[]) => {
      emitted.push({ name, args });
      for (const handler of handlers.get(name) ?? []) handler(...args);
    },
  //M 串行派发：非空回执结束派发，模拟 Cordis 交给一个接收方。
    serial: async (name: string, ...args: unknown[]) => {
      for (const handler of handlers.get(name) ?? []) {
        const result: unknown = await handler(...args);
        if (result !== undefined && result !== null && result !== false) return result;
      }
      return undefined;
    },
    effect: (open: () => () => void) => {
      closers.push(open());
    },
    //M 可选服务：http 给 app，其他未挂。
    get: (name: string) => {
      if (name === 'http') return { app };

      return undefined;
    },
    //M 没挂 flow：可选依赖不接。
    inject: () => Promise.resolve(),
  };

  const ctx = fake as unknown as cordis.Context;
  const resultQueue: FakeResultQueue = {
    accepted: [],
    failNext: false,
    listen() {
      //M 模拟机器人对投递的拒绝、入队与重复回执。
      events.onRequestEvent(ctx, 'bot/request', 'bot/result', (request) => {
        if (request.action !== 'accept-result') return { ok: false };

        if (resultQueue.failNext) {
          resultQueue.failNext = false;
          return { ok: false, error: '模拟：排不进结果队列' };
        }

        const { input } = request;
        const known = resultQueue.accepted.some((one) => one.key === input.key);
        if (known) return { ok: true, receipt: { status: 'duplicate', key: input.key } } as const;

        resultQueue.accepted.push(input);
        return { ok: true, receipt: { status: 'queued', key: input.key } } as const;
      });
    },
  };

  const say = async (text: string, address: unknown = { chatId: 'oc_test', openId: 'ou_test' }): Promise<string> => {
    const event: { bot: typeof bot; message: { text: string; address: unknown }; session?: FakeSession } = {
      bot, message: { text, address },
    };
    for (const handler of handlers.get('bot/receive') ?? []) handler(event);
    const session = event.session;
    if (session === undefined) throw new Error('relay 没接这句话');
    session.row.channel = 'feishu';
    session.row.address = address;
    session.row.messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() + serial });
    await step(session);
    return answers.at(-1) ?? '';
  };

  const ask = (session: FakeSession): { tools: string[]; system: string[] } => {
    const request = { session, system: [] as string[], tools: [{ name: 'relay_send' }, { name: 'read' }] };
    for (const handler of handlers.get('session/before-model') ?? []) handler(request);
    return { tools: request.tools.map((tool) => tool.name), system: request.system };
  };

  //M 模拟重启：挨个调 ready 的监听（relay 在这里把没送的回信再送一遍）。
  const restart = (): void => {
    for (const handler of handlers.get('ready') ?? []) handler();
  };

  return {
    ctx, emitted, handlers, db, app, sessions, openedSessions, answers, say, bot, tools,
    open: make, ask, resultQueue, crash, restart,
  };
}

/** 头一次 fastify ready / inject 在 130 的共享盘上要加载很久（几十秒），两条走接口的测试放宽超时。 */
const SLOW = 180_000;

/** 等一会儿：webhook 是异步推的，回信送达是 setTimeout 0。 */
const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 挂好 relay 的一套环境。
 * @param helpers 配哪些助手；不写是 HELPERS。
 */
async function ready(helpers: unknown[] = HELPERS, more: Record<string, unknown> = {}): Promise<World> {
  const made = world();
  made.db.exec('CREATE TABLE web_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT, channel TEXT, address TEXT)');
  //M more：别的配置（bots 这类）；写了 relay 就是测试机器人名单项的 relay。
  const { relay, ...config } = more;
  if (relay !== undefined) made.bot.config['relay'] = relay;
  relayModule.apply(made.ctx, { helpers, ...config });
  await made.app.ready();
  closers.push(() => { void made.app.close(); });
  return made;
}

describe('relay 接两个助手', () => {
  test('发 b 你好：回执写 B，只进 B 的收件箱，不推 A 的 webhook；回“收到”署 B', async () => {
    const made = await ready();
    //M 两条测试共用一个假 webhook：只看这个聊天（oc_test）推来的。
    const mine = (): Record<string, unknown>[] => hooks.filter((hook) => hook['chat'] === 'oc_test');

    const receipt = await made.say('b 你好');
    expect(receipt).toBe('已转给 B（#1），等回复。');

    const forB = await made.app.inject({ method: 'GET', url: `/api/relay/inbox?helper=${encodeURIComponent('B')}` });
    expect(forB.statusCode).toBe(200);
    const listB = forB.json() as { items: { id: number; helper: string; text: string }[] };
    expect(listB.items.map((item) => [item.id, item.helper])).toEqual([[1, 'B']]);
    expect(listB.items[0]?.text).toBe('b 你好');

    const forA = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=A' });
    expect((forA.json() as { items: unknown[] }).items).toEqual([]);

    await settle();
    expect(mine()).toEqual([]);

    //M 对照：发给 A 的确实会推到 A 的 webhook（证明上面的“没推”不是假 webhook 坏了）。
    expect(await made.say('a 在吗')).toBe('已转给 A（#2），等回复。');
    await settle();
    expect(mine().length).toBe(1);
    expect(mine()[0]?.['id']).toBe(2);
    expect(mine()[0]?.['text']).toBe('a 在吗');

    //G 给了收件号又写了别的助手：对不上就 400，不悄悄照收件的助手署名。
    const mismatch = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, helper: 'A', text: 'x' } });
    expect(mismatch.statusCode).toBe(400);

    //M B 回信：回给用户的话署 B。
    const replied = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, text: '收到' } });
    expect(replied.statusCode).toBe(200);
    expect((replied.json() as { item: { helper: string; state: string } }).item).toMatchObject({ helper: 'B', state: 'replied' });
    await settle();
    expect(made.answers.at(-1)).toBe('B：收到');
  }, SLOW);

  test('chat 加 helper: B 主动发：挂在 B 的收件上，不挂到 A 的', async () => {
    const made = await ready();
    const address = { chatId: 'oc_both', openId: 'ou_test' };

    //M 这个聊天只有 A 的收件时：B 主动发要新开一条 B 的收件，不能挂到 A 的 #1 上（地址借 A 那条记的，不再去 web_messages 找）。
    expect(await made.say('a 第一句', address)).toBe('已转给 A（#1），等回复。');
    const first = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { chat: 'oc_both', helper: 'B', text: 'B 主动说一句' } });
    expect(first.statusCode).toBe(200);
    const made1 = (first.json() as { item: { id: number; helper: string } }).item;
    expect(made1.helper).toBe('B');
    expect(made1.id).not.toBe(1);
    await settle();
    expect(made.answers.at(-1)).toBe('B：B 主动说一句');

    //M 再发一条 B 的，再主动发：挂到 B 最近的那条，A 的 #1 还是没回。
    const receipt = await made.say('b 第二句', address);
    const bId = Number(/#(\d+)/u.exec(receipt)?.[1]);
    const second = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { chat: 'oc_both', helper: 'B', text: '又来' } });
    expect((second.json() as { item: { id: number; helper: string } }).item).toMatchObject({ id: bId, helper: 'B' });

    const forA = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=A' });
    expect((forA.json() as { items: { id: number; state: string }[] }).items).toEqual([expect.objectContaining({ id: 1, state: 'pending' })]);

    //M helper 写了不认识的名字：400。
    const wrong = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { chat: 'oc_both', helper: 'C', text: 'x' } });
    expect(wrong.statusCode).toBe(400);
  }, SLOW);

  test('回答由 relay 自己发 channel/reply：“已转给”发到会话现在的地址，回信发到收件当时的地址，不改会话记的地址', async () => {
    const made = await ready();
    const first = { chatId: 'oc_first', openId: 'ou_test' };
    const second = { chatId: 'oc_second', openId: 'ou_test' };

    //M 假飞书渠道：接 channel/reply，记下正文、确切地址和会话号，回 sent。
    const sent: { text: string; address: unknown; sessionId: string | undefined; kind: string }[] = [];
    made.handlers.set('channel/reply', [(...args: unknown[]) => {
      const request = args[0] as channels.ChannelReplyRequest;
      if (request.channel !== 'feishu') return;

      request.handled = true;
      const text = request.parts.map((part) => part.text ?? '').join('');
      sent.push({ text, address: request.target?.address, sessionId: request.sessionId, kind: request.kind });
      const receipt = channels.getReceipt(request, 'sent');
      channels.emitReplied(made.ctx, request, receipt);
    }]);

    //M 两个聊天各转一句：同一场 relay 会话，会话记的地址最后停在第二个聊天。
    expect(await made.say('a 第一句', first)).toBe('已转给 A（#1），等回复。');
    expect(await made.say('b 第二句', second)).toBe('已转给 B（#2），等回复。');
    await settle();
    expect(sent.map((one) => [one.text, one.address])).toEqual([
      ['已转给 A（#1），等回复。', first],
      ['已转给 B（#2），等回复。', second],
    ]);
    const session = [...made.sessions.values()].find((one) => one.row.kind === 'relay');
    expect(session?.row.quiet).toBe(true);

    //M A 回 #1：回信发到第一个聊天（收件当时的地址），会话记的地址还是第二个聊天。
    const replied = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, text: '收到' } });
    expect(replied.statusCode).toBe(200);
    await settle();
    expect(sent.at(-1)).toMatchObject({ text: 'A：收到', address: first, sessionId: session?.id, kind: 'final' });
    expect(session?.row.address).toEqual(second);
  }, SLOW);

  test('按 chat 回信只认一字不差的聊天号：相似的、open_id、只在 web_messages 里见过的都 404，不留半截收件', async () => {
    const made = await ready();
    const count = (table: string): number => (made.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    //M 聊天 oc1same 里有 A 的 #1。
    expect(await made.say('a 你好', { chatId: 'oc1same', openId: 'ou_same' })).toBe('已转给 A（#1），等回复。');

    //G 相似的聊天号 oc_same（旧的 LIKE 里 _ 能顶任意一个字，会认成 oc1same）、说话人的 open_id、web_messages 里有的别的聊天：都 404。
    made.db.query('INSERT INTO web_messages (bot, channel, address) VALUES (?, ?, ?)').run(BOT, 'feishu', JSON.stringify({ chatId: 'oc_web' }));
    for (const chat of ['oc_same', 'ou_same', 'oc_web', 'oc1sam']) {
      const missed = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { chat, helper: 'A', text: '回错人了' } });
      expect(missed.statusCode).toBe(404);
    }
    expect(count('relay_items')).toBe(1);
    expect(count('relay_replies')).toBe(0);

    //M 一字不差的聊天号：挂到 #1。
    const hit = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { chat: 'oc1same', helper: 'A', text: '对了' } });
    expect(hit.statusCode).toBe(200);
    expect((hit.json() as { item: { id: number } }).item.id).toBe(1);
  }, SLOW);

  test('回信带的文件：只许 relay 给这个机器人的目录（或它的工作区）里的；../ 出去、别处的绝对路径 400，回信不记', async () => {
    const made = await ready();
    const count = (): number => (made.db.query('SELECT COUNT(*) AS n FROM relay_replies').get() as { n: number }).n;
    expect(await made.say('a 发个文件', { chatId: 'oc_file', openId: 'ou_test' })).toBe('已转给 A（#1），等回复。');

    //M 范围外的两个文件：数据目录上一层（../）、系统临时目录里别处的绝对路径。
    const outside = path.join(path.dirname(root), `jm-relay-outside-${String(Date.now())}.txt`);
    fs.writeFileSync(outside, '不该发出去');
    closers.push(() => { fs.rmSync(outside, { force: true }); });
    for (const file of [`../${path.basename(outside)}`, outside, 'integrations/relay/../../outside.txt']) {
      const refused = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, text: '附件', file } });
      expect(refused.statusCode).toBe(400);
    }
    expect(count()).toBe(0);

    //M 范围里的：relay 给这个机器人的目录 integrations/relay/<机器人>/。收下（飞书没挂，发文件只记 trace）。
    const inside = path.join(root, 'integrations', 'relay', BOT, 'ok.txt');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, '可以发');
    const accepted = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, text: '附件', file: `integrations/relay/${BOT}/ok.txt` } });
    expect(accepted.statusCode).toBe(200);
    expect(count()).toBe(1);
  }, SLOW);

  test('回信带文件发给飞书，分别记录发送成功、无人接单和执行结果不确定', async () => {
    const made = await ready();
    expect(await made.say('a 发个文件', { chatId: 'oc_send', openId: 'ou_test' })).toBe('已转给 A（#1），等回复。');
    const inside = path.join(root, 'integrations', 'relay', BOT, 'send.txt');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, '要发的');
    const payload = { id: 1, text: '附件', file: `integrations/relay/${BOT}/send.txt` };
    const sent = (): string[] => made.emitted
      .filter((one) => one.name === 'trace' && one.args[1] === 'trace.relay.sendFile')
      .map((one) => String((one.args[3] as { result: string }).result));

    //M 没人答：没有任何监听者接 feishu/send-file，立即退回，trace 写没发出去。
    const nobody = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload });
    expect(nobody.statusCode).toBe(200);
    await settle();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('没发出去');

    const handlers = made.handlers;
    //M 飞书接单后未回执就抛错，trace 只记录结果不确定。
    handlers.set('feishu/send-file', [(request: unknown) => {
      const asked = request as { handled?: boolean };
      asked.handled = true;
      throw new Error('模拟飞书处理抛错');
    }]);
    const uncertain = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload });
    expect(uncertain.statusCode).toBe(200);
    await settle();
    expect(sent()[1]).toBe('飞书文件发送结果不确定：飞书处理时出错 模拟飞书处理抛错');

    //M 飞书接单后一直没回，等待到第 30 秒时也只记录结果不确定。
    handlers.set('feishu/send-file', [(request: unknown) => {
      const asked = request as { handled?: boolean };
      asked.handled = true;
    }]);
    vi.useFakeTimers();
    try {
      const waiting = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload });
      expect(waiting.statusCode).toBe(200);
      vi.advanceTimersByTime(30_000);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(sent()[2]).toBe('飞书文件发送结果不确定：等待回执超时');

    //M 假飞书接单并回 ok: true：trace 写已发和新消息号。
    handlers.set('feishu/send-file', [(request: unknown) => {
      const asked = request as { requestId: string; handled?: boolean };
      asked.handled = true;
      made.ctx.emit('feishu/send-file-result', { requestId: asked.requestId, ok: true, messageId: 'om_sent' });
    }]);
    const answered = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload });
    expect(answered.statusCode).toBe(200);
    await settle();
    expect(sent()).toHaveLength(4);
    expect(sent()[3]).toBe('已发 om_sent');
  }, SLOW);

  test('带附件的话转出去：inbox.jsonl、GET /api/relay/inbox、webhook 都带 files（相对运行时目录）', async () => {
    const made = await ready();
    const address = { chatId: 'oc_files', openId: 'ou_test' };
    const mine = (): Record<string, unknown>[] => hooks.filter((hook) => hook['chat'] === 'oc_files');

    //M 照渠道的写法：saveFile 存进工作区 inbox/，话里写 @绝对路径，有空白的写 @"路径"。
    const inbox = path.join(root, 'bots', BOT, 'workspace', 'inbox', '2026-11-16');
    fs.mkdirSync(inbox, { recursive: true });
    const image = path.join(inbox, '093005123_a.png');
    const spaced = path.join(inbox, '093005124_b c.pdf');
    fs.writeFileSync(image, 'png');
    fs.writeFileSync(spaced, 'pdf');
    const outside = path.join(os.tmpdir(), 'jm-relay-outside.png');
    const text = `a 看看这两个 @某人\n@${image}\n@"${spaced}"\n@${outside}\n@${image}`;
    const wanted = [
      `bots/${BOT}/workspace/inbox/2026-11-16/093005123_a.png`,
      `bots/${BOT}/workspace/inbox/2026-11-16/093005124_b c.pdf`,
    ];

    expect(await made.say(text, address)).toBe('已转给 A（#1），等回复。');
    await settle();

    //M 收件箱文件最后一行就是这条（几条测试共用一个运行时目录，按顺序跑）。
    const lines = fs.readFileSync(path.join(root, 'integrations', 'relay', BOT, 'inbox.jsonl'), 'utf8').trim().split('\n');
    expect((JSON.parse(lines.at(-1) ?? '{}') as { files?: unknown }).files).toEqual(wanted);

    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=A' });
    expect((listed.json() as { items: { files: string[] }[] }).items[0]?.files).toEqual(wanted);

    expect(mine().length).toBe(1);
    expect(mine()[0]?.['files']).toEqual(wanted);

    //M 不带附件的：files 是 []。
    expect(await made.say('a 没有附件', address)).toBe('已转给 A（#2），等回复。');
    await settle();
    expect(mine()[1]?.['files']).toEqual([]);
  }, SLOW);

  test('前缀不分大小写，后面可跟空白、标点、汉字；ccc、cctv 不算', async () => {
    //M 照 config.yaml 现在的写法：带空格的 'cc '、'CC '。
    const made = await ready([{ name: 'Claude', prefixes: ['cc ', 'CC '] }]);

    for (const text of ['cc 你好', 'CC你好', 'Cc，你好', 'cc：你好', 'cc,你好']) {
      expect(await made.say(text)).toMatch(/^已转给 Claude（#\d+），等回复。$/u);
    }
    for (const text of ['ccc 你好', 'cctv 好看']) {
      await expect(made.say(text)).rejects.toThrow('relay 没接这句话');
    }
  }, SLOW);

  test('飞书先贴图再写字：开头的附件标记跳过再认前缀', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc ', 'CC '] }]);

    for (const text of ['[图片]cc 你好', '[图片][图片]CC，你好']) {
      expect(await made.say(text)).toMatch(/^已转给 Claude（#\d+），等回复。$/u);
    }
  }, SLOW);

  test('只有附件标记、后面不是前缀的不转', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc ', 'CC '] }]);

    await expect(made.say('[图片]你好')).rejects.toThrow('relay 没接这句话');
  }, SLOW);

  test('引用后面的 cc 要转给对应助手，收件保留完整引用', async () => {
    const made = await ready([...HELPERS, { name: 'Claude', prefixes: ['cc '] }]);

    //M 引用可以跨行，前后也可以带附件标记；只按正文里的前缀选助手。
    const quote = '【回复的消息：【说明】上一条的第一行\n第二行里提到了 b 这个前缀】';
    const texts = [
      `${quote}\ncc 看一下这条回复`,
      `[图片]\n${quote}\n[图片]CC，再看这张图`,
    ];
    for (const text of texts) {
      expect(await made.say(text)).toMatch(/^已转给 Claude（#\d+），等回复。$/u);
    }

    //M 只在识别前缀时跳过引用，真正交给助手的收件仍是用户的完整原话。
    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=Claude' });
    const items = (listed.json() as { items: { text: string }[] }).items;
    expect(items.map((item) => item.text)).toEqual(texts);
  }, SLOW);

  test('只有引用里含 cc、正文不是前缀开头的不转', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc '] }]);

    //M 引用中的 cc 属于旧消息，普通正文、附件和 cctv 都不能被当成新指令。
    for (const text of [
      '【回复的消息：cc 这是上一条指令】\n这次只是在聊天',
      '【回复的消息：【说明】cc 仍然是引用里的旧指令】\n这次只是在聊天',
      '[图片]【回复的消息：第一行\nCC，上次说过的话】\n[图片]你好',
      '【回复的消息：cc 看一下】\ncctv 好看',
    ]) {
      await expect(made.say(text)).rejects.toThrow('relay 没接这句话');
    }

    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=Claude' });
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
  }, SLOW);
});

describe('收件记下谁、在哪说的', () => {
  test('群里本人、私聊别人：入库，inbox 接口、inbox.jsonl、webhook 都带 owner、sender、chat', async () => {
    const made = await ready();
    //M owner、名字、群名都是飞书插件照 people、groups 写进地址的，relay 只读。
    const group = {
      chatId: 'oc_who_g', openId: 'ou_owner', customer: 'feishu:group:oc_who_g', senderName: 'leon', chatName: '测试群', owner: true,
    };
    const p2p = { chatId: 'oc_who_p', openId: 'ou_friend123456', customer: 'feishu:ou_friend123456', owner: false };
    const noName = { chatId: 'oc_who_n', openId: 'ou_friend123456', customer: 'feishu:group:oc_who_n' };

    await made.say('a 群里说的', group);
    await made.say('a 私聊说的', p2p);
    await made.say('a 群名没查到', noName);
    await settle();

    const wanted = [
      { owner: true, sender: 'leon', chat: 'group', chatName: '测试群' },
      { owner: false, sender: '123456', chat: 'p2p', chatName: '' },
      { owner: false, sender: '123456', chat: 'group', chatName: 'oc_who_n' },
    ];
    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=A' });
    const items = (listed.json() as { items: Record<string, unknown>[] }).items;
    expect(items.map((item) => ({ owner: item['owner'], sender: item['sender'], chat: item['chat'], chatName: item['chatName'] })))
      .toEqual(wanted);
    //G HTTP 轮询公开本人标志，渠道原始发话人标识留在内部回话地址。
    expect(listed.body).not.toContain(group.openId);
    expect(listed.body).not.toContain(p2p.openId);
    for (const item of items) {
      expect(item).not.toHaveProperty('address');
      expect(item).not.toHaveProperty('sender_open_id');
    }

    const lines = fs.readFileSync(path.join(root, 'integrations', 'relay', BOT, 'inbox.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-3) ?? '{}')).toMatchObject(wanted[0] ?? {});

    const hook = hooks.find((one) => one['chat'] === 'oc_who_g');
    expect(hook).toMatchObject({ owner: true, sender: 'leon', chat_type: 'group', chat_name: '测试群', sender_open_id: 'ou_owner' });
  }, SLOW);
});

describe('飞书群登记的 relay、机器人的 relay', () => {
  const front = { bot: BOT, kind: 'front', customer: 'feishu:group:oc_g' };
  /** 飞书插件给登记了 relay: model 的群写的地址。 */
  const modelGroup = { chatId: 'oc_g', openId: 'ou_x', customer: 'feishu:group:oc_g', relay: 'model' };

  test('群登记了 relay: model：这个群的会话有 relay_send 和提示；没登记的群、私聊没有，调了也拒', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc '] }]);
    expect(made.tools.map((tool) => tool.definition.name)).toEqual(['relay_send']);
    expect(made.tools[0]?.definition.description).toContain('一般技术解释、资料查询、定方案、闲聊、打招呼都自己答');
    expect(made.tools[0]?.definition.description).toContain('必须动项目代码时');

    const inModel = made.open(front);
    inModel.row.address = modelGroup;
    const asked = made.ask(inModel);
    expect(asked.tools).toEqual(['relay_send', 'read']);
    expect(asked.system.join('\n')).toContain('这是群聊');
    expect(asked.system.join('\n')).toContain('只有对方明确要外部助手');
    expect(asked.system.join('\n')).toContain('以 cc 开头的话已经直接转给外部助手了');

    //M 群登记的 direct 和没登记一样：只认前缀，不给 relay_send。
    for (const address of [{ ...modelGroup, relay: 'direct' }, { chatId: 'oc_p', openId: 'ou_x', customer: 'feishu:ou_x' }]) {
      const other = made.open(front);
      other.row.address = address;
      expect(made.ask(other)).toEqual({ tools: ['read'], system: [] });
      expect(() => made.tools[0]?.run({ text: '查一下' }, other)).toThrow('不能用 relay_send');
    }

    //M 登记的群里调：登记一条收件，记成群里说的。
    expect(made.tools[0]?.run({ text: '查一下' }, inModel)).toMatch(/^已转给 Claude（#1）/u);
    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox' });
    expect((listed.json() as { items: Record<string, unknown>[] }).items[0]).toMatchObject({ chat: 'group', text: '查一下' });
  }, SLOW);

  test('机器人写 relay: model 照旧哪都有 relay_send；relay: direct 平常话也转，只听的话只认前缀', async () => {
    const model = await ready([{ name: 'Claude', prefixes: ['cc '] }], { relay: 'model' });
    expect(model.ask(model.open(front)).tools).toEqual(['relay_send', 'read']);

    const direct = await ready([{ name: 'Claude', prefixes: ['cc '] }], { relay: 'direct' });
    const group = { chatId: 'oc_g', openId: 'ou_x', customer: 'feishu:group:oc_g' };
    expect(await direct.say('你好', { chatId: 'oc_p', openId: 'ou_x', customer: 'feishu:ou_x' }))
      .toBe('已转给 Claude（#1），等回复。');
    await expect(direct.say('随便聊聊', { ...group, listenOnly: true })).rejects.toThrow('relay 没接这句话');
    expect(await direct.say('cc 看一下', { ...group, listenOnly: true })).toMatch(/^已转给 Claude/u);
  }, SLOW);

  test('名单项 relay 写错（含旧的按聊天种类写法）：apply 抛错', () => {
    for (const relay of ['auto', { group: 'model' }, ['model'], null]) {
      const made = world();
      made.bot.config['relay'] = relay;
      expect(() => relayModule.apply(made.ctx, { helpers: HELPERS })).toThrow('relay 只能写');
    }
  });
});

describe('relay 旧库和配置', () => {
  test('旧库 relay_items 没有 helper 栏：启动补上，旧收件都归第一个助手', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE relay_items (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,'
      + ' session_id TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,'
      + " last_msg_at INTEGER, state TEXT NOT NULL DEFAULT 'pending', reminded INTEGER NOT NULL DEFAULT 0, replied_at INTEGER)");
    for (const text of ['旧的一句', '旧的两句']) {
      db.query("INSERT INTO relay_items (bot, session_id, channel, address, text, at) VALUES (?, 's0', 'feishu', 'null', ?, 1)").run(BOT, text);
    }
    //M 群里的旧收件：谁、在哪说的照记的地址补。旧地址没有 owner 这项，算不是本人。
    const groupAddress = JSON.stringify({ chatId: 'oc_old', openId: 'ou_owner_abcdef', customer: 'feishu:group:oc_old' });
    db.query("INSERT INTO relay_items (bot, session_id, channel, address, text, at) VALUES (?, 's0', 'feishu', ?, '群里的', 1)")
      .run(BOT, groupAddress);
    const made = world(db);
    relayModule.apply(made.ctx, { helpers: HELPERS });

    const columns = db.query('PRAGMA table_info(relay_items)').all() as { name: string }[];
    for (const name of ['helper', 'owner', 'sender', 'chat', 'chat_name']) {
      expect(columns.some((column) => column.name === name)).toBe(true);
    }
    const rows = db.query('SELECT helper, owner, sender, chat, chat_name FROM relay_items ORDER BY id').all();
    expect(rows).toEqual([
      { helper: 'A', owner: 0, sender: '', chat: 'p2p', chat_name: '' },
      { helper: 'A', owner: 0, sender: '', chat: 'p2p', chat_name: '' },
      { helper: 'A', owner: 0, sender: 'abcdef', chat: 'group', chat_name: 'oc_old' },
    ]);
  });

  test('已经有 helper 栏的库（0.7.15）：只补谁、在哪说的几栏，helper 不动', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE relay_items (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,'
      + ' session_id TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,'
      + " last_msg_at INTEGER, state TEXT NOT NULL DEFAULT 'pending', reminded INTEGER NOT NULL DEFAULT 0, replied_at INTEGER,"
      + " helper TEXT NOT NULL DEFAULT '')");
    db.query("INSERT INTO relay_items (bot, session_id, channel, address, text, at, helper) VALUES (?, 's0', 'feishu', 'null', 'x', 1, 'B')")
      .run(BOT);
    relayModule.apply(world(db).ctx, { helpers: HELPERS });

    expect(db.query('SELECT helper, chat FROM relay_items').all()).toEqual([{ helper: 'B', chat: 'p2p' }]);
    const versions = db.query("SELECT version FROM db_migrations WHERE plugin = 'relay' ORDER BY version").all() as { version: number }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  test('已有全部新栏的存量库（尚未登记迁移账本）：adoptColumn 直接接管，已有字段保持原样', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE relay_items (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,'
      + " helper TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL,"
      + " owner INTEGER NOT NULL DEFAULT 0, sender TEXT NOT NULL DEFAULT '', chat TEXT NOT NULL DEFAULT 'p2p',"
      + " chat_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, at INTEGER NOT NULL, last_msg_at INTEGER,"
      + " state TEXT NOT NULL DEFAULT 'pending', reminded INTEGER NOT NULL DEFAULT 0, replied_at INTEGER)");
    db.query("INSERT INTO relay_items (bot, helper, session_id, channel, address, owner, sender, chat, chat_name, text, at) VALUES (?, 'B', 's1', 'http', 'null', 1, '', 'p2p', '', '存量网页收件', 1)")
      .run(BOT);
    relayModule.apply(world(db).ctx, { helpers: HELPERS });

    expect(db.query('SELECT helper, owner, sender, chat, chat_name FROM relay_items').all()).toEqual([
      { helper: 'B', owner: 1, sender: '', chat: 'p2p', chat_name: '' },
    ]);
    const versions = db.query("SELECT version FROM db_migrations WHERE plugin = 'relay' ORDER BY version").all() as { version: number }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  test('helpers 写了但是空的、名字重复、前缀有空串：apply 抛错', () => {
    const bad: unknown[] = [
      [],
      [{ name: 'A', prefixes: ['a '] }, { name: 'A', prefixes: ['b '] }],
      [{ name: 'A', prefixes: ['a ', ''] }],
      [{ name: 'A', prefixes: ['  '] }],
    ];
    for (const helpers of bad) {
      const made = world();
      expect(() => relayModule.apply(made.ctx, { helpers })).toThrow();
    }
  });

  test('helpers 没写且 http 未就绪：不登记工具；tasks.scan_ms 写错抛错', () => {
    //M 缺省配置和空配置都能启动，未启用转话时不认领 bot/receive。
    for (const config of [undefined, {}]) {
      const made = world();
      relayModule.apply(made.ctx, config);
      expect(made.tools.map((tool) => tool.definition.name)).toEqual([]);
    }

    //M 任务通道的扫描间隔小于 1 秒：整个插件不挂。
    expect(() => relayModule.apply(world().ctx, { tasks: { scan_ms: 10 } })).toThrow('scan_ms');
  });

  test('写了 helpers 且 http 未就绪：只登记 relay_send', async () => {
    const made = await ready();
    const names = made.tools.map((tool) => tool.definition.name);
    expect(names).toEqual(['relay_send']);
  });
});


test('relay 按原目标回到留言带井号的节点，重启按回信号去重，缺精确目标的留待核对', async () => {
  const made = world();
  const helper = { name: 'A', prefixes: ['a '] };
  const prefix = '/api/work-decision';
  //M 用实际的两个插件和 Fastify 接口穿过整条链。
  relayModule.apply(made.ctx, { helpers: [helper] });
  decisionModule.apply(made.ctx, { relay_helper: helper.name });
  closers.push(() => { void made.app.close(); });
  const node = 'release#part';
  const nodes = [
    { id: 'goal', kind: 'goal', title: '目标', status: 'working' },
    {
      id: node, kind: 'pending', title: '发版', parent: 'goal', status: 'open',
      options: [{ id: 'yes', text: '发' }, { id: 'later', text: '等' }],
    },
  ];
  const draft = { method: 'PUT', url: prefix + '/nodes', payload: { nodes } } as const;
  const published = await made.app.inject(draft);
  expect(published.statusCode).toBe(200);

  const noteDraft = { node, text: '先看看验证结果' };
  const noteInput = { method: 'POST', url: prefix + '/note', payload: noteDraft } as const;
  const posted = await made.app.inject(noteInput);
  expect(posted.statusCode).toBe(200);
  const added = posted.json() as { delivery: { relayId: number }; note: { id: string } };
  const inbox = await made.app.inject('/api/relay/inbox?helper=A&state=pending');
  expect(inbox.json().items).toMatchObject([{ id: added.delivery.relayId, channel: 'work-decision' }]);

  const replyDraft = { id: added.delivery.relayId, text: '验证通过' };
  const replyInput = { method: 'POST', url: '/api/relay/reply', payload: replyDraft } as const;
  const replied = await made.app.inject(replyInput);
  expect(replied.statusCode).toBe(200);
  await settle();

  const graphUrl = prefix + '/graph';
  const first = (await made.app.inject(graphUrl)).json() as decisionTypes.DecisionGraph;
  const stored = first.nodes.find((item) => item.id === node);
  expect(stored?.notes).toMatchObject([
    { id: added.note.id, repliedAt: expect.any(Number) },
    { author: 'central', text: '验证通过', replyTo: added.note.id },
  ]);
  const deliverySql = 'SELECT delivered FROM relay_replies ORDER BY id';
  expect(made.db.query(deliverySql).all()).toEqual([{ delivered: 1 }]);

  //M 模拟图已存盘而 relay 尚未写回执，同时保留旧渠道标签下的精确回信目标。
  made.db.exec('UPDATE relay_replies SET delivered = 0');
  const choose = { method: 'POST', url: prefix + '/choose', payload: { node, option: 'yes' } } as const;
  const picked = (await made.app.inject(choose)).json() as { delivery: { relayId: number } };
  const insert = 'INSERT INTO relay_replies (item_id, session_id, text, done, at, via) VALUES (?, ?, ?, 1, ?, ?)';
  const oldKey = `decision-map:${node}`;
  made.db.query("UPDATE relay_items SET channel = 'decision-map', session_id = ? WHERE id = ?")
    .run(oldKey, picked.delivery.relayId);
  made.db.query(insert).run(picked.delivery.relayId, oldKey, '收到你的选择', Date.now(), 'http');
  made.restart();
  await settle();

  const recovered = (await made.app.inject(graphUrl)).json() as decisionTypes.DecisionGraph;
  const after = recovered.nodes.find((item) => item.id === node);
  expect(after?.notes).toHaveLength(3);
  expect(after?.notes?.[2]).toMatchObject({ author: 'central', text: '收到你的选择' });
  expect(after?.notes?.[2]?.replyTo).toBeUndefined();
  expect(made.db.query(deliverySql).all()).toEqual([{ delivered: 1 }, { delivered: 1 }]);

  //G 缺精确目标时，即使旧收件键看起来是个节点号，也保持未投递。
  const update = 'UPDATE relay_items SET address = ? WHERE id = ?';
  const missingTarget = '{"owner":true}';
  made.db.query(update).run(missingTarget, picked.delivery.relayId);
  made.db.query(insert).run(picked.delivery.relayId, oldKey, '缺少精确目标', Date.now(), 'http');
  made.restart();
  await settle();

  const unchanged = (await made.app.inject(graphUrl)).json() as decisionTypes.DecisionGraph;
  expect(unchanged.nodes.find((item) => item.id === node)?.notes).toEqual(after?.notes);
  expect(made.db.query(deliverySql).all()).toEqual([{ delivered: 1 }, { delivered: 1 }, { delivered: 0 }]);
  expect(made.openedSessions).toEqual([]);
}, SLOW);


test('relay 入口拒绝旧本人清单并提示改用飞书 role', () => {
  const ctx = new cordis.Context();
  const config = { tasks: {}, owner_open_ids: ['ou_legacy'] };
  expect(() => relayModule.apply(ctx, config)).toThrow('owner_open_ids 已不用');
});


describe('回信送进会话：先写进对话再标已送，走模型的会话排进结果队列', () => {
  /** 最新一条回信的回信号。 */
  const lastReplyId = (made: World): number => {
    const row = made.db.query('SELECT id FROM relay_replies ORDER BY id DESC LIMIT 1').get() as { id: number };
    return row.id;
  };

  /** 一条回信标没标已送：1 标了，0 没标。 */
  const delivered = (made: World, replyId: number): number => {
    const row = made.db.query('SELECT delivered FROM relay_replies WHERE id = ?').get(replyId) as { delivered: number };
    return row.delivered;
  };

  /** 对话里带着这条回信号的回答有几条。 */
  const written = (session: FakeSession, replyId: number): number => {
    return session.row.messages.filter((message) => message['relayReplyId'] === replyId).length;
  };

  /** 这个环境里那场 relay 会话（前缀转话开的）。 */
  const relaySession = (made: World): FakeSession => {
    return [...made.sessions.values()].find((one) => one.row.kind === 'relay')!;
  };

  test('direct：写进对话之前断电，重启后送到；再重启不重复', async () => {
    const made = await ready();
    expect(await made.say('b 你好')).toBe('已转给 B（#1），等回复。');

    //M 断电在回答写进对话之前：没留下，也没标已送。
    made.crash.mode = 'beforeWrite';
    const posted = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, text: '收到' } });
    expect(posted.statusCode).toBe(200);
    await settle();
    const replyId = lastReplyId(made);
    const session = relaySession(made);
    expect(written(session, replyId)).toBe(0);
    expect(delivered(made, replyId)).toBe(0);

    //M 重启：送到一次，标已送。
    made.restart();
    await settle();
    expect(made.answers.at(-1)).toBe('B：收到');
    expect(written(session, replyId)).toBe(1);
    expect(delivered(made, replyId)).toBe(1);

    //M 再重启两次：同一条回信不再进对话，也不多一句“没有新消息”。
    const answered = made.answers.length;
    made.restart();
    made.restart();
    await settle();
    expect(made.answers.length).toBe(answered);
    expect(written(session, replyId)).toBe(1);
  }, SLOW);

  test('direct：写进对话之后、标已送之前断电，重启只补标，不再送一次', async () => {
    const made = await ready();
    expect(await made.say('b 你好')).toBe('已转给 B（#1），等回复。');

    //M 断电在回答写进对话之后：对话里有了，还没标已送。
    made.crash.mode = 'afterWrite';
    await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, text: '收到' } });
    await settle();
    const replyId = lastReplyId(made);
    const session = relaySession(made);
    expect(written(session, replyId)).toBe(1);
    expect(delivered(made, replyId)).toBe(0);

    //M 重启：对账补标已送，不推会话（不多一句回答）。
    const answered = made.answers.length;
    made.restart();
    await settle();
    expect(delivered(made, replyId)).toBe(1);
    expect(made.answers.length).toBe(answered);
    expect(written(session, replyId)).toBe(1);
  }, SLOW);

  test('走模型的前台：回信排进结果队列，键 relay:<回信号>、回话地址是收件当时的；排不上不标已送，重启再排，排上一次', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc '] }], { relay: 'model' });
    const front = made.open({ bot: BOT, kind: 'front', customer: 'feishu:ou_x' });
    front.row.channel = 'feishu';
    front.row.address = { chatId: 'oc_m', openId: 'ou_x' };
    expect(made.tools[0]?.run({ text: '查一下' }, front)).toMatch(/^已转给 Claude（#1）/u);

    //M 第一次无人应答，保留待送状态。
    const posted = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, text: '查到了' } });
    expect(posted.statusCode).toBe(200);
    await settle();
    const replyId = lastReplyId(made);
    expect(made.resultQueue.accepted).toEqual([]);
    expect(delivered(made, replyId)).toBe(0);

    //M 接通后第一次收到失败回执，也保持待送。
    made.resultQueue.failNext = true;
    made.resultQueue.listen();
    made.restart();
    await settle();
    expect(made.resultQueue.accepted).toEqual([]);
    expect(delivered(made, replyId)).toBe(0);

    //M 再重试，收到成功回执后才标已送。
    made.restart();
    await settle();
    expect(made.resultQueue.accepted.length).toBe(1);
    const queued = made.resultQueue.accepted[0]!;
    expect(queued.key).toBe(`relay:${String(replyId)}`);
    expect(queued.source).toEqual({ type: 'relay', id: 'Claude' });
    expect(queued.sessionId).toBe(front.id);
    expect(queued.origin).toEqual({ channel: 'feishu', address: { chatId: 'oc_m', openId: 'ou_x' } });
    expect(queued.payload.text).toBe('Claude 回复（#1）：查到了');
    expect(delivered(made, replyId)).toBe(1);
    expect(front.row.messages).toEqual([]);

    //M 模拟已入队但还没标已送，重复回执也能补上源记录。
    const reset = 'UPDATE relay_replies SET delivered = 0 WHERE id = ?';
    made.db.query(reset).run(replyId);
    made.restart();
    await settle();
    expect(made.resultQueue.accepted.length).toBe(1);
    expect(delivered(made, replyId)).toBe(1);
  }, SLOW);

  test('helpers 配置 title 时：对外展示名用 title，收件表与 API 查询核对仍用内部 name', async () => {
    const made = await ready([{ name: 'Claude', title: 'Antigravity', prefixes: ['cc '] }], { relay: 'model' });
    made.resultQueue.listen();

    //M 前缀直转：回执显示 Antigravity，但库和接口筛选仍是 Claude。
    expect(await made.say('cc 看一下')).toBe('已转给 Antigravity（#1），等回复。');
    const byName = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=Claude' });
    const nameItems = (byName.json() as { items: { id: number; helper: string }[] }).items;
    expect(nameItems.map((one) => [one.id, one.helper])).toEqual([[1, 'Claude']]);
    const byTitle = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=Antigravity' });
    expect((byTitle.json() as { items: unknown[] }).items).toEqual([]);

    //M 直转回信署名显示 Antigravity，回信校验仍认 helper: Claude。
    const replied = await made.app.inject({
      method: 'POST',
      url: '/api/relay/reply',
      payload: { id: 1, helper: 'Claude', text: '修好了' },
    });
    expect(replied.statusCode).toBe(200);
    await settle();
    expect(made.answers.at(-1)).toBe('Antigravity：修好了');

    //M model 模式工具描述、系统提示词和结果入队正文都显示 Antigravity，source.id 仍留 Claude。
    const front = made.open({ bot: BOT, kind: 'front', customer: 'feishu:ou_x' });
    front.row.channel = 'feishu';
    front.row.address = { chatId: 'oc_m', openId: 'ou_x' };
    const asked = made.ask(front);
    expect(asked.system[0]).toContain('Antigravity');
    expect(made.tools[0]?.definition.description).toContain('Antigravity');
    expect(made.tools[0]?.run({ text: '再查一下' }, front)).toMatch(/^已转给 Antigravity（#2）/u);

    await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 2, text: '查完了' } });
    await settle();
    expect(made.resultQueue.accepted[0]).toMatchObject({
      source: { type: 'relay', id: 'Claude' },
      payload: { text: 'Antigravity 回复（#2）：查完了' },
    });
  }, SLOW);

  test('address.relayHelper 群攒批转交：无前缀也认领进群 relay 会话并静默入箱，回信时才往群里发声', async () => {
    const made = await ready([
      { name: 'jm开发', prefixes: ['jm '] },
      { name: 'Claude', title: 'Antigravity', prefixes: ['cc '] },
    ]);
    const channelReplies: channels.ChannelReplyRequest[] = [];
    made.ctx.on('channel/reply', (request: channels.ChannelReplyRequest) => {
      request.handled = true;
      channelReplies.push(request);
      channels.emitReplied(made.ctx, request, channels.getReceipt(request, 'sent'));
    });

    const groupAddr = {
      chatId: 'oc_paper',
      openId: 'ou_member',
      customer: 'feishu:group:oc_paper',
      relayHelper: 'Claude',
    };
    //M 自动转交：当轮回答为空串，不发任何 channel/reply，收件落到排第二位的 Claude 名下。
    expect(await made.say('Game 1 的归约损失怎么算', groupAddr)).toBe('');
    await settle();
    expect(channelReplies).toEqual([]);

    const inbox = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=Claude' });
    const claudeItems = (inbox.json() as { items: { id: number; helper: string; chat: string; text: string }[] }).items;
    expect(claudeItems).toMatchObject([{ id: 1, helper: 'Claude', chat: 'group', text: 'Game 1 的归约损失怎么算' }]);

    //M 中控回信后才向原群发出带展示名署名的最终回复。
    const post = await made.app.inject({
      method: 'POST',
      url: '/api/relay/reply',
      payload: { id: 1, helper: 'Claude', text: '限定 G=O(1) 即可多项式归约' },
    });
    expect(post.statusCode).toBe(200);
    await settle();
    expect(made.answers.at(-1)).toBe('Antigravity：限定 G=O(1) 即可多项式归约');
    expect(channelReplies).toHaveLength(1);
    expect(channelReplies[0]?.parts[0]?.text).toBe('Antigravity：限定 G=O(1) 即可多项式归约');
    expect(channelReplies[0]?.target).toMatchObject({ channel: 'feishu', chat: 'oc_paper' });

    //M 话里显式带了别的助手前缀时，前缀优先于 relayHelper。
    expect(await made.say('jm 顺手跑下脚本', groupAddr)).toBe('');
    const jmInbox = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=jm%E5%BC%80%E5%8F%91' });
    const jmItems = (jmInbox.json() as { items: { id: number; helper: string }[] }).items;
    expect(jmItems.map((one) => [one.id, one.helper])).toEqual([[2, 'jm开发']]);
  }, SLOW);
});
