/**
 * 飞书多应用去重隔离（feishu_seen 复合主键迁移 + 并发/先后互不吞消息）与全 AI 群防死循环（sender_type === 'app'）离线单测。
 * 跑法：bun test ./src7/plugins/feishu/DedupAndLoopGuard.test.ts
 */
import * as bunTest from 'bun:test';
import * as sqlite from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as dispatchModule from '../bots/Dispatch.ts';
import * as frontDeskModule from '../bots/FrontDesk.ts';
import type { ReceiveEvent } from '../bots/index.ts';
import type * as protocol from '../channels/index.ts';
import * as dbModule from '../db/index.ts';
import * as relayModule from '../relay/index.ts';
import * as configModule from './Config.ts';
import * as feishuModule from './index.ts';
import type { ReceiveData } from './Inbound.ts';

const tempRoots: string[] = [];
const disposers: Array<() => Promise<unknown> | void> = [];

bunTest.afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) {
    await close();
  }
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const APP_A = 'cli_1111111111111111';
const APP_B = 'cli_2222222222222222';
const BOT_A = '韩信';
const BOT_B = '周小灵';
const BOT_A_OPEN = 'ou_bot_hanxin';
const BOT_B_OPEN = 'ou_bot_zhou';
const OWNER_OPEN = 'ou_owner';
const OTHER_BOT_OPEN = 'ou_other_bot';
const GROUP_ALL = 'oc_ai_group_all';
const GROUP_JUDGE = 'oc_ai_group_judge';
const GROUP_PLAIN = 'oc_ai_group_plain';

interface DualWorld {
  db: sqlite.Database;
  feishu: feishuModule.Feishu;
  traces: Array<{ site: string; summary: string; vars: Record<string, unknown> }>;
  emitted: Array<{ event: protocol.InboundEvent; targetBots: string[]; address: Record<string, unknown> }>;
  delivered: Array<{ bot: string; kind: string; text: string; address: Record<string, unknown> }>;
  typingCalls: Array<{ appId: string; messageId: string }>;
  decisionAsked: unknown[];
  push: (appId: string, data: ReceiveData) => Promise<void>;
}

/** 构造挂双飞书应用 + 真实 db 迁移账本 + relay + FrontDesk(含真实 GroupBatch) 的全离线测试环境。 */
function createDualAppWorld(options?: { existingDb?: sqlite.Database; reactionDelayMs?: number }): DualWorld {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-feishu-dual-'));
  tempRoots.push(dir);
  const db = options?.existingDb ?? new sqlite.Database(':memory:');
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const sessions = new Map<string, {
    id: string;
    row: Record<string, unknown> & { id: string; bot: string; kind: string; customer?: string; state: string; messages: unknown[] };
    save: () => void;
    run: () => Promise<void>;
  }>();
  const traces: DualWorld['traces'] = [];
  const emitted: DualWorld['emitted'] = [];
  const delivered: DualWorld['delivered'] = [];
  const typingCalls: DualWorld['typingCalls'] = [];
  const decisionAsked: unknown[] = [];
  let serial = 0;

  const dbService = new dbModule.Db(new cordis.Context(), db);
  const botsByName = new Map([
    [BOT_A, { name: BOT_A, config: {} }],
    [BOT_B, { name: BOT_B, config: {} }],
  ]);

  const dispatchRef: { current?: dispatchModule.Dispatch } = {};

  const fake = {
    db: dbService,
    resources: {
      db,
      root: dir,
      raw: {},
      config: { providers: {}, plugins: [] },
      ensureRuntimeDir: (...parts: string[]): string => {
        const full = path.join(dir, ...parts);
        fs.mkdirSync(full, { recursive: true });
        return full;
      },
    },
    tools: { register: () => undefined },
    sessions: {
      find: (where: Record<string, unknown>) => [...sessions.values()]
        .filter((one) => Object.entries(where).every(([key, value]) => {
          const found = key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], one.row);
          return found === value;
        }))
        .map((one) => one.row),
      create: (input: { bot: string; kind: string; customer?: string }) => {
        serial += 1;
        const id = `s_${String(serial)}`;
        const session = {
          id,
          row: { id, state: 'done', messages: [], ...input },
          save: () => undefined,
          run: () => Promise.resolve(),
        };
        sessions.set(id, session);
        return session;
      },
      open: (id: string) => sessions.get(id),
    },
    bots: {
      list: () => [...botsByName.values()],
      get: (name: string) => botsByName.get(name),
      channel: () => () => undefined,
      route: () => undefined,
      say: () => undefined,
      receive: async (_channel: string, botName: string, text: string, address: Record<string, unknown>): Promise<void> => {
        const target = botsByName.get(botName);
        if (target === undefined) {
          throw new Error(`没有机器人 ${botName}`);
        }

        const event: {
          bot: typeof target;
          message: { channel: string; text: string; address: unknown };
          session?: { id: string; row: { kind: string; channel?: string; address?: unknown } };
          handled?: boolean;
        } = { bot: target, message: { channel: 'feishu', text, address } };
        for (const handler of handlers.get('bot/receive') ?? []) {
          await handler(event);
        }
        await dispatchRef.current?.receive(event as unknown as ReceiveEvent);
        if (event.handled === true) return;
        if (event.session === undefined) return;

        event.session.row.channel = 'feishu';
        event.session.row.address = address;
        delivered.push({ bot: botName, kind: event.session.row.kind, text, address });
      },
    },
    on: (eventName: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
      return () => undefined;
    },
    serial: async (eventName: string, ...args: unknown[]) => {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler(...args);
      }
    },
    emit: (eventName: string, ...args: unknown[]) => {
      if (eventName === 'trace') {
        const [site, summary, , vars] = args as [string, string, string, Record<string, unknown>];
        traces.push({ site, summary, vars });
      }
      for (const handler of handlers.get(eventName) ?? []) {
        void handler(...args);
      }
    },
    effect: (open: () => (() => void) | undefined) => {
      const close = open();
      if (close !== undefined) {
        disposers.push(close);
      }
    },
    get: (service: string) => {
      if (service === 'db') return dbService;
      if (service === 'decision') {
        return {
          judge: (input: unknown) => {
            decisionAsked.push(input);
            return Promise.resolve({ verdict: 'allow', score: 0.95, reason: 'test', results: [] });
          },
        };
      }
      return undefined;
    },
    inject: () => Promise.resolve(),
    reflect: { provide: () => undefined },
  };
  const ctx = fake as unknown as cordis.Context;

  relayModule.apply(ctx, { helpers: [{ name: 'Claude', prefixes: ['cc', '哈基米'] }] });
  const desk = new frontDeskModule.FrontDesk(ctx, { recent: 50 });
  dispatchRef.current = new dispatchModule.Dispatch(ctx, desk, { quiet_seconds: 0.01, max_lines: 1, daily_limit: 10 });

  const bridge = (event: protocol.InboundEvent) => async (rawMsg: unknown, rawControl: unknown): Promise<void> => {
    const message = rawMsg as protocol.ChannelMessage;
    const control = rawControl as protocol.ChannelMessageControl | undefined;
    emitted.push({ event, targetBots: [...message.targetBots], address: structuredClone(message.origin.address) });
    const listen = event === 'channel/listen';
    for (const botName of message.targetBots) {
      const originAddress = structuredClone(message.origin.address);
      if (listen) {
        originAddress['listenOnly'] = true;
      }
      await fake.bots.receive(message.channel, botName, message.text, originAddress);
      const deliveredItem = delivered.findLast((item) => item.address === originAddress);
      if (deliveredItem !== undefined) {
        control?.claims.push({
          bot: botName,
          claimKey: JSON.stringify([message.messageId, botName]),
          status: deliveredItem.kind === 'relay' ? 'relay' : 'claimed',
          sessionKind: deliveredItem.kind,
        });
        continue;
      }
      if (listen) {
        control?.claims.push({
          bot: botName,
          claimKey: JSON.stringify([message.messageId, botName]),
          status: 'listen',
        });
      }
    }
  };
  for (const eventName of ['channel/direct', 'channel/mention', 'channel/listen'] as const) {
    handlers.set(eventName, [bridge(eventName)]);
  }

  const config: configModule.FeishuConfig = {
    domain: 'http://127.0.0.1:9',
    apps: [
      { appId: APP_A, appSecret: 'secret_a', bot: BOT_A },
      { appId: APP_B, appSecret: 'secret_b', bot: BOT_B },
    ],
    people: new Map<string, configModule.FeishuPerson>([
      [OWNER_OPEN, { openId: OWNER_OPEN, name: '老板', role: 'owner', dir: '' }],
    ]),
    groups: new Map<string, configModule.FeishuGroup>([
      [GROUP_ALL, { chatId: GROUP_ALL, name: 'AI指挥部', listen: 'all', relay: 'model', trusted: true }],
      [GROUP_JUDGE, { chatId: GROUP_JUDGE, name: 'AI判断群', listen: 'judge', relay: 'direct', trusted: true, judgeThreshold: 0.7 }],
    ]),
    historyOnJoin: 0,
  };
  const feishu = new feishuModule.Feishu(ctx, config);
  disposers.push(() => db.close());

  const appPairs: Array<[string, string]> = [[APP_A, BOT_A_OPEN], [APP_B, BOT_B_OPEN]];
  for (const [appId, botOpenId] of appPairs) {
    const app = feishu.apps.get(appId);
    if (app === undefined) {
      throw new Error(`应用 ${appId} 未初始化`);
    }
    app.botOpenId = botOpenId;
    (app.client.im.v1.messageReaction as unknown as Record<string, unknown>)['create'] = async (arg: { path: { message_id: string } }) => {
      if ((options?.reactionDelayMs ?? 0) > 0) {
        await Bun.sleep(options!.reactionDelayMs!);
      }
      typingCalls.push({ appId, messageId: arg.path.message_id });
      return { data: { reaction_id: `r_${appId}` } };
    };
    (app.client.im.v1.messageReaction as unknown as Record<string, unknown>)['delete'] = () => Promise.resolve({});
    (app.client.im.v1.message as unknown as Record<string, unknown>)['get'] = () => Promise.resolve({ data: { items: [] } });
  }

  const members = new Map([
    [OWNER_OPEN, '老板'],
    [OTHER_BOT_OPEN, '外援AI'],
  ]);
  for (const [chatId, chatName] of [[GROUP_ALL, 'AI指挥部'], [GROUP_JUDGE, 'AI判断群'], [GROUP_PLAIN, '普通群']] as const) {
    feishu.chats.set(chatId, { name: chatName, members, at: Date.now() });
  }

  return {
    db,
    feishu,
    traces,
    emitted,
    delivered,
    typingCalls,
    decisionAsked,
    push: (appId, data) => feishu.inbound.onMessage(appId, data),
  };
}

bunTest.describe('feishu_seen 迁移兼容与多应用并发去重隔离', () => {
  bunTest.test('旧版单主键 feishu_seen 带存量数据无损升级为 (message_id, app_id) 复合主键，重启幂等且兼容旧记录', async () => {
    const legacyDb = new sqlite.Database(':memory:');
    legacyDb.exec('CREATE TABLE feishu_seen (message_id TEXT PRIMARY KEY, app_id TEXT, kind TEXT, at INTEGER)');
    legacyDb.exec('CREATE TABLE feishu_p2p (app_id TEXT PRIMARY KEY, chat_id TEXT, open_id TEXT, message_id TEXT, at INTEGER)');
    legacyDb.exec('CREATE TABLE feishu_cards (card_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, ended INTEGER, at INTEGER)');
    const now = Date.now();
    legacyDb.query('INSERT INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)').run('om_old_null', null, 'in', now);
    legacyDb.query('INSERT INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)').run('om_old_empty', '', 'in', now);
    legacyDb.query('INSERT INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)').run('om_old_app_a', APP_A, 'in', now);
    legacyDb.query('INSERT INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)').run('om_old_card', APP_A, 'card', now);

    const w = createDualAppWorld({ existingDb: legacyDb });

    //M 验证表结构升级为 (message_id, app_id) 复合主键，临时表已清理，迁移账本已记版本 1 与 2。
    const columns = legacyDb.query('PRAGMA table_info(feishu_seen)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const msgCol = columns.find((col) => col.name === 'message_id');
    const appCol = columns.find((col) => col.name === 'app_id');
    bunTest.expect(msgCol?.pk).toBe(1);
    bunTest.expect(appCol?.pk).toBe(2);
    bunTest.expect(appCol?.notnull).toBe(1);
    bunTest.expect(appCol?.dflt_value).toBe("''");

    const v2Exists = legacyDb.query("SELECT 1 FROM sqlite_master WHERE name = 'feishu_seen_v2'").get();
    bunTest.expect(v2Exists).toBeNull();
    const ledger = legacyDb.query("SELECT version FROM db_migrations WHERE plugin = 'feishu' ORDER BY version").all() as Array<{ version: number }>;
    bunTest.expect(ledger.map((row) => row.version)).toEqual([1, 2]);

    //M 验证存量行全量保留：NULL 已归一为 ''。
    const rows = legacyDb.query('SELECT message_id, app_id, kind FROM feishu_seen ORDER BY message_id').all();
    bunTest.expect(rows).toEqual([
      { message_id: 'om_old_app_a', app_id: APP_A, kind: 'in' },
      { message_id: 'om_old_card', app_id: APP_A, kind: 'card' },
      { message_id: 'om_old_empty', app_id: '', kind: 'in' },
      { message_id: 'om_old_null', app_id: '', kind: 'in' },
    ]);

    //M 模拟服务重启：再次跑 migrate 幂等无错，存量不受影响。
    const dbAgain = new dbModule.Db(new cordis.Context(), legacyDb);
    bunTest.expect(() => dbAgain.migrate(feishuModule.feishuMigrations)).not.toThrow();

    //M 旧数据 app_id='' 在重启后仍挡住重复推送；而旧记录仅属于 APP_A 的消息不阻挡 APP_B。
    await w.push(APP_B, {
      sender: { sender_id: { open_id: OWNER_OPEN }, sender_type: 'user' },
      message: {
        message_id: 'om_old_null',
        chat_id: GROUP_PLAIN,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 旧消息重推' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_B_OPEN }, name: BOT_B }],
      },
    });
    bunTest.expect(w.delivered).toHaveLength(0);
    bunTest.expect(w.traces.some((t) => t.summary === 'trace.feishu.duplicateMessage' && t.vars['nativeId'] === 'om_old_null')).toBe(true);

    //M 仅记过 APP_A 的旧消息号推给 APP_A 拦截，推给 APP_B 必须放行！
    await w.push(APP_A, {
      sender: { sender_id: { open_id: OWNER_OPEN }, sender_type: 'user' },
      message: {
        message_id: 'om_old_app_a',
        chat_id: GROUP_PLAIN,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 重复给韩信' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_A_OPEN }, name: BOT_A }],
      },
    });
    bunTest.expect(w.delivered).toHaveLength(0);

    await w.push(APP_B, {
      sender: { sender_id: { open_id: OWNER_OPEN }, sender_type: 'user' },
      message: {
        message_id: 'om_old_app_a',
        chat_id: GROUP_PLAIN,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 给周小灵放行' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_B_OPEN }, name: BOT_B }],
      },
    });
    bunTest.expect(w.delivered).toHaveLength(1);
    bunTest.expect(w.delivered[0]?.bot).toBe(BOT_B);
  });

  bunTest.test('同群双应用并发与先后收同条 message_id 互不吞消息；同应用重推精准拦截', async () => {
    const w = createDualAppWorld({ reactionDelayMs: 15 });
    const makeGroupMsg = (targetOpenId: string, targetName: string): ReceiveData => ({
      sender: { sender_id: { open_id: OWNER_OPEN }, sender_type: 'user' },
      message: {
        message_id: 'om_shared_concurrent',
        chat_id: GROUP_ALL,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: `@_user_1 你好，请处理` }),
        mentions: [{ key: '@_user_1', id: { open_id: targetOpenId }, name: targetName }],
      },
    });

    //M 两个飞书应用（韩信 + 周小灵）同时在途处理同一 message_id，双方都必须放行！
    await Promise.all([
      w.push(APP_A, makeGroupMsg(BOT_A_OPEN, BOT_A)),
      w.push(APP_B, makeGroupMsg(BOT_B_OPEN, BOT_B)),
    ]);

    bunTest.expect(w.delivered).toHaveLength(2);
    bunTest.expect(w.delivered.map((d) => d.bot).sort()).toEqual([BOT_A, BOT_B].sort());
    bunTest.expect(w.traces.filter((t) => t.summary === 'trace.feishu.duplicateMessage')).toHaveLength(0);

    const seenRows = w.db.query("SELECT app_id, kind FROM feishu_seen WHERE message_id = 'om_shared_concurrent' ORDER BY app_id").all();
    bunTest.expect(seenRows).toEqual([
      { app_id: APP_A, kind: 'in' },
      { app_id: APP_B, kind: 'in' },
    ]);

    //M 同一个 (app_A, message_id) 再次推送必须精准拦截为 duplicateMessage，不反复派发。
    await w.push(APP_A, makeGroupMsg(BOT_A_OPEN, BOT_A));
    bunTest.expect(w.delivered).toHaveLength(2);
    const dupTraces = w.traces.filter((t) => t.summary === 'trace.feishu.duplicateMessage');
    bunTest.expect(dupTraces).toHaveLength(1);
    bunTest.expect(dupTraces[0]?.vars['appId']).toBe(APP_A);
    bunTest.expect(dupTraces[0]?.vars['nativeId']).toBe('om_shared_concurrent');

    //M 先后顺序推给两个应用（先 APP_A 写库完成后再推 APP_B），APP_B 仍正常放行。
    const makeSeqMsg = (targetOpenId: string, targetName: string): ReceiveData => ({
      sender: { sender_id: { open_id: OWNER_OPEN }, sender_type: 'user' },
      message: {
        message_id: 'om_shared_seq',
        chat_id: GROUP_ALL,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: `@_user_1 顺序多应用消息` }),
        mentions: [{ key: '@_user_1', id: { open_id: targetOpenId }, name: targetName }],
      },
    });
    await w.push(APP_A, makeSeqMsg(BOT_A_OPEN, BOT_A));
    await w.push(APP_B, makeSeqMsg(BOT_B_OPEN, BOT_B));
    bunTest.expect(w.delivered).toHaveLength(4);
    bunTest.expect(w.delivered.slice(2).map((d) => d.bot)).toEqual([BOT_A, BOT_B]);
  });
});

bunTest.describe('全 AI 群与私聊防 sender_type === app 死循环守卫', () => {
  bunTest.test('sender_type === app 携带 @机器人、cc、哈基米或引用机器人发言时，绝不置 called、绝不进 FrontDesk / relay / GroupBatch', async () => {
    const w = createDualAppWorld();

    //M 0. 先落一条人类私聊与一条机器人群回复日志，用于验证：(1) 机器人私聊不覆盖 feishu_p2p；(2) 机器人引用我方历史也不触发 called。
    await w.push(APP_A, {
      sender: { sender_id: { open_id: OWNER_OPEN }, sender_type: 'user' },
      message: {
        message_id: 'om_human_p2p',
        chat_id: 'oc_human_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'cc 帮我查下状态' }),
      },
    });
    bunTest.expect(w.delivered).toHaveLength(1);
    w.feishu.history.appendChatLog(APP_A, GROUP_JUDGE, {
      messageId: JSON.stringify(['feishu', APP_A, 'om_bot_prev']),
      nativeId: 'om_bot_prev',
      appId: APP_A,
      chatId: GROUP_JUDGE,
      direction: 'bot',
      createdAt: Date.now() - 1000,
      sender: { id: BOT_A_OPEN, name: BOT_A },
      text: '已收到，正在处理',
      mentions: [],
      attachments: [],
    });

    const deliveredCountBefore = w.delivered.length;
    const emittedCountBefore = w.emitted.length;
    const typingCountBefore = w.typingCalls.length;

    //M 1. 未登记群 + sender_type: 'app' + @本机器人 + cc 前缀。
    await w.push(APP_A, {
      sender: { sender_id: { open_id: OTHER_BOT_OPEN }, sender_type: 'app' },
      message: {
        message_id: 'om_loop_plain_at_cc',
        chat_id: GROUP_PLAIN,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 cc 互相转圈测试' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_A_OPEN }, name: BOT_A }],
      },
    });

    //M 2. listen: 'all' 群 + sender_type: 'app' + 哈基米：前缀（绝不能以 listenOnly 进入 relay）。
    await w.push(APP_A, {
      sender: { sender_id: { open_id: OTHER_BOT_OPEN }, sender_type: 'app' },
      message: {
        message_id: 'om_loop_all_hjm',
        chat_id: GROUP_ALL,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '哈基米：请替我再跑一遍' }),
      },
    });

    //M 3. listen: 'judge' 群 + sender_type: 'app' + 引用我方机器人回复（绝不能触发 called 或 GroupBatch）。
    await w.push(APP_A, {
      sender: { sender_id: { open_id: OTHER_BOT_OPEN }, sender_type: 'app' },
      message: {
        message_id: 'om_loop_judge_quote',
        parent_id: 'om_bot_prev',
        chat_id: GROUP_JUDGE,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 收到，继续跟进' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_A_OPEN }, name: BOT_A }],
      },
    });

    //M 4. 私聊 + sender_type: 'app'（绝不能触发回复且绝不覆盖 feishu_p2p）。
    await w.push(APP_A, {
      sender: { sender_id: { open_id: OTHER_BOT_OPEN }, sender_type: 'app' },
      message: {
        message_id: 'om_loop_p2p',
        chat_id: 'oc_bot_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '机器人发来的私聊测试' }),
      },
    });

    await Bun.sleep(30);

    //M 核心断言：没有任何 emitInbound / Typing / FrontDesk / relay / GroupBatch 触发！
    bunTest.expect(w.delivered).toHaveLength(deliveredCountBefore);
    bunTest.expect(w.emitted).toHaveLength(emittedCountBefore);
    bunTest.expect(w.typingCalls).toHaveLength(typingCountBefore);
    bunTest.expect(w.decisionAsked).toHaveLength(0);

    //M 所有 receiveMessage 跟踪点上 called 均为 false、bot 为空。
    const appLoopMsgIds = new Set([
      JSON.stringify(['feishu', APP_A, 'om_loop_plain_at_cc']),
      JSON.stringify(['feishu', APP_A, 'om_loop_all_hjm']),
      JSON.stringify(['feishu', APP_A, 'om_loop_judge_quote']),
      JSON.stringify(['feishu', APP_A, 'om_loop_p2p']),
    ]);
    const receiveTraces = w.traces.filter(
      (t) => t.summary === 'trace.feishu.receiveMessage' && appLoopMsgIds.has(String(t.vars['messageId'])),
    );
    bunTest.expect(receiveTraces).toHaveLength(4);
    for (const trace of receiveTraces) {
      bunTest.expect(trace.vars['called']).toBe(false);
      bunTest.expect(trace.vars['bot']).toBe('');
    }

    //M 人类私聊映射未被机器人私聊覆盖。
    bunTest.expect(w.feishu.lastPrivate(APP_A)).toMatchObject({ chatId: 'oc_human_p2p', openId: OWNER_OPEN });

    //M 群聊天日志保留了机器人发言原文供真人后续引用，来往流水记为「忽略机器人消息」且 atMe=false。
    bunTest.expect(w.feishu.history.readChatLog(APP_A, GROUP_ALL).some((e) => e.nativeId === 'om_loop_all_hjm')).toBe(true);
    bunTest.expect(w.feishu.history.readChatLog(APP_A, GROUP_PLAIN).some((e) => e.nativeId === 'om_loop_plain_at_cc')).toBe(true);
    const contacts = w.feishu.contacts.list(10);
    const ignored = contacts.filter((c) => c.outcome === '忽略机器人消息');
    bunTest.expect(ignored).toHaveLength(4);
    bunTest.expect(ignored.every((c) => c.atMe === false)).toBe(true);

    //M 同一条机器人消息重推时仍受 feishu_seen 拦截。
    await w.push(APP_A, {
      sender: { sender_id: { open_id: OTHER_BOT_OPEN }, sender_type: 'app' },
      message: {
        message_id: 'om_loop_all_hjm',
        chat_id: GROUP_ALL,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '哈基米：请替我再跑一遍' }),
      },
    });
    bunTest.expect(w.traces.some((t) => t.summary === 'trace.feishu.duplicateMessage' && t.vars['nativeId'] === 'om_loop_all_hjm')).toBe(true);
  });
});
