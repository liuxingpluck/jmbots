/**
 * 飞书群：登记的人和群、来往流水、只听的话（2026-11-17，0.7.16）。
 * 跑法：bun test ./src7/plugins/feishu/GroupListen.test.ts
 * 不连飞书：真的 Feishu 类（不 apply、不连长连接）+ 真的 relay 插件、真的前台（bots/FrontDesk.ts、bots/Dispatch.ts），接在一个假的 ctx 上；
 * 假 bots.receive 照 plugins/bots/index.ts 的 Bot.receive 走一遍 bot/receive，再交给前台（Dispatch.receive），交给会话时照 bots.route 记下渠道和地址。
 * 渠道发的三个事件 channel/direct、channel/mention、channel/listen 挂同一个假处理，照 bots 的 onChannelMessage：targetBots 里每个机器人各认领一次，
 * channel/listen 来的才在地址副本上标 listenOnly（渠道的原地址不带）；发了哪个事件、投给谁记在 World.emitted。
 * 飞书查到的群名、群成员名字预先填进 Feishu 的缓存，挂表情的接口换成假的，所以不发任何请求。
 * 查的是：登记 listen: all 的群不 @ 的普通话发 channel/listen、只记不回、cc 开头的进 relay，@ 了发 channel/mention、只投被叫到的机器人；
 * 群里引用机器人发的那条算叫了那个机器人（channel/mention），引用人说的话不算；
 * 没登记的群不 @ 的话也发 channel/listen（targetBots 空、没有会话接），流水记“只记”，@ 的照常交给会话；
 * 会话正在转时来的先排着；来往流水每种情况都记（交给会话、转外部助手、只记、没处理成）；
 * listen: judge 的群：不 @ 的话发 channel/listen、地址带 judge 和阈值；这条旧路的前台只记不判断，不问决策模型（攒批判断在 bots/GroupBatch.test.ts）；
 * 群里发的话 @名字 换成 <at user_id>、回信开头 @ 最后说话的人；checkConfig 认 judge、judge_threshold；
 * people 登记的名字优先，role: owner 才是本人，没登记是访客；checkConfig 核对 people、groups 并拒绝旧身份键。
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as events from '../../utils/RequestEvent.ts';
import { Dispatch } from '../bots/Dispatch.ts';
import { FrontDesk } from '../bots/FrontDesk.ts';
import type { ReceiveEvent } from '../bots/index.ts';
import type * as protocol from '../channels/index.ts';
import * as dbModule from '../db/index.ts';
import * as relayModule from '../relay/index.ts';
import type { FeishuChatLogEntry } from './ChatLog.ts';
import * as feishuModule from './index.ts';

/** 临时运行时目录；每套环境在里面再开一个，流水文件不串。 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-feishu-listen-'));

/** 测完要关的：relay 的定时器。 */
const closers: (() => void)[] = [];
afterAll(() => {
  for (const close of closers) close();
  fs.rmSync(root, { recursive: true, force: true });
});

const BOT = '测试机器人';
const APP_ID = 'cli_0123456789abcdef';
const BOT_OPEN_ID = 'ou_bot';
/** 登记了 listen: all、relay: model 的群。 */
const LISTENED = 'oc_listened';
/** 没登记的群。 */
const PLAIN = 'oc_plain';
const OWNER = 'ou_owner';
const FRIEND = 'ou_friend';
const STRANGER = 'ou_stranger_abcdef';
/** 登记了 listen: judge、judge_threshold: 0.8、judge_helper: Claude 的群。 */
const JUDGED = 'oc_judged';

const BUILDER = 'ou_builder';
const BUILDER_DIR = path.join(root, 'guests', '小王');
/** 同一个飞书应用还允许认领的另一个机器人（world 的 extraBots 里传）。 */
const OTHER_BOT = '别的机器人';

/** 登记：本人 leon、朋友周周（guest）、小王（builder）；一个 listen: all 的群。 */
const PEOPLE = new Map<string, feishuModule.FeishuPerson>([
  [OWNER, { openId: OWNER, name: 'leon', role: 'owner', dir: '' }],
  [FRIEND, { openId: FRIEND, name: '周周', role: 'guest', dir: '' }],
  [BUILDER, { openId: BUILDER, name: '小王', role: 'builder', dir: BUILDER_DIR }],
]);
const GROUPS = new Map<string, feishuModule.FeishuGroup>([
  [LISTENED, { chatId: LISTENED, name: '周-论文实现', listen: 'all', relay: 'model', trusted: false }],
  [JUDGED, {
    chatId: JUDGED, name: '判断群', listen: 'judge', relay: 'direct', trusted: false, judgeThreshold: 0.8, judgeHelper: 'Claude',
  }],
]);

/** 挂真实文件投递事件，不触发 ready；各测试用模拟 SDK 完成文件操作。 */
function createFileChannel(ctx: cordis.Context): feishuModule.Feishu {
  const db = new Database(':memory:');
  ctx.provide('resources', { db });
  ctx.provide('bots', { channel: () => () => undefined });
  ctx.effect(() => () => db.close());
  const config = {
    domain: 'http://127.0.0.1:9',
    apps: [{ appId: APP_ID, appSecret: 'x', bot: BOT }],
    people: PEOPLE,
    groups: GROUPS,
    historyOnJoin: 0,
  };
  return new feishuModule.Feishu(ctx, config);
}

const fileEventOptions = {
  timeoutMs: 1000,
  onFallback: (reason: events.FallbackReason) => ({ requestId: '', ok: false, error: reason }),
};

test('飞书投递事件上传文件、引用原消息并回传新消息号', async () => {
  const ctx = new cordis.Context();
  try {
    const feishu = createFileChannel(ctx);
    const sdk = feishu.client(APP_ID);
    const upload = spyOn(sdk.im.v1.file, 'create').mockResolvedValue({ file_key: 'file_test' });
    const reply = spyOn(sdk.im.v1.message, 'reply').mockResolvedValue({ data: { message_id: 'om_file' } });
    const filePath = path.join(root, 'event.png');
    fs.writeFileSync(filePath, '测试文件');
    const input = { bot: BOT, chatId: PLAIN, filePath, appId: APP_ID, kind: 'file', messageId: 'om_origin' } as const;

    const result = await events.requestEvent(ctx, 'feishu/send-file', 'feishu/send-file-result', input, fileEventOptions);
    expect(result).toMatchObject({ ok: true, messageId: 'om_file' });
    expect(upload).toHaveBeenCalledWith({ data: { file_type: 'stream', file_name: 'event.png', file: Buffer.from('测试文件') } });
    expect(reply).toHaveBeenCalledWith({
      path: { message_id: 'om_origin' },
      data: { msg_type: 'file', content: '{"file_key":"file_test"}' },
    });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('飞书投递发送失败时回执错误', async () => {
  const ctx = new cordis.Context();
  try {
    const feishu = createFileChannel(ctx);
    const sdk = feishu.client(APP_ID);
    spyOn(sdk.im.v1.file, 'create').mockResolvedValue({ file_key: 'file_test' });
    const send = spyOn(sdk.im.v1.message, 'create').mockRejectedValue(new Error('测试发送失败'));
    const filePath = path.join(root, 'failed-event.txt');
    fs.writeFileSync(filePath, '测试文件');
    const input = { bot: BOT, chatId: PLAIN, filePath } as const;

    const result = await events.requestEvent(ctx, 'feishu/send-file', 'feishu/send-file-result', input, fileEventOptions);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('测试发送失败') });
    expect(result.requestId).toStartWith('req_');
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    await ctx.fiber.dispose();
  }
});

/** 假决策模型：每次 judge 照顺序给一个结论，记下问的题。 */
interface FakeDecision {
  verdicts: { verdict: 'allow' | 'deny' | 'unsure'; score?: number }[];
  asked: { kind: string; allowAt?: number; state: Record<string, unknown>; question: { instructions: string } }[];
}

/** 一场假会话。 */
interface FakeSession {
  id: string;
  row: { id: string; bot: string; kind: string; customer?: string; state: string; channel?: string; address?: unknown;
    messages: { role: string; content: unknown; timestamp: number }[] };
  save: () => void;
  run?: () => Promise<void>;
}

/** 一套假的运行环境。 */
interface World {
  feishu: feishuModule.Feishu;
  sessions: Map<string, FakeSession>;
  /** 交给会话的话（照真的 Bot.receive 会 add + run 的）：哪场、什么话、地址。 */
  delivered: { session: FakeSession; text: string; address: Record<string, unknown> }[];
  /** 渠道发出的三个进来的事件（照先后，一条消息只发一个）：哪个事件、投给哪些机器人、渠道原地址（listenOnly 是 bots 在自己的副本上标的，这里没有）。 */
  emitted: { event: protocol.InboundEvent; targetBots: string[]; address: Record<string, unknown> }[];
  /** 发一条消息：哪个聊天、说什么、有没有 @ 机器人、谁说的、引用（回复）哪条消息。私聊给 chatType p2p。 */
  send: (
    chatId: string,
    text: string,
    options?: { atMe?: boolean; sender?: string; chatType?: string; parentId?: string },
  ) => Promise<void>;
  /** 飞书发出去的话（回复接口收到的文字）。 */
  said: string[];
  /** 被推着往下跑的会话号（session.run）。 */
  ran: string[];
  /** 照骨架发一次 session/change。 */
  change: (session: FakeSession) => void;
}

let messageNo = 0;

/**
 * 搭一套：假 ctx 上挂真的 relay、前台（FrontDesk、Dispatch），再建一个真的 Feishu。
 * @param decision 假决策模型；不传就是没挂决策模型。
 * @param extraBots 同一个飞书应用除了 BOT 还允许认领的机器人名；不传就只有 BOT。
 */
function world(decision?: FakeDecision, extraBots: string[] = []): World {
  const dir = fs.mkdtempSync(path.join(root, 'w-'));
  const db = new Database(':memory:');
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const sessions = new Map<string, FakeSession>();
  const delivered: World['delivered'] = [];
  const emitted: World['emitted'] = [];
  const said: string[] = [];
  const ran: string[] = [];
  let serial = 0;

  const bot = { name: BOT, config: {} as Record<string, unknown> };
  //M 假机器人按名字取：BOT 加上 extraBots 里的（都一样，只是名字不同）。
  const botsByName = new Map([[BOT, bot]]);
  for (const name of extraBots) {
    botsByName.set(name, { name, config: {} });
  }
  /** 前台派后台（真的 Dispatch）：下面建好前台再填；假 bots.receive 问完 bot/receive 交给它。 */
  let dispatch: Dispatch | undefined;
  //M relay 的表经 db 插件的迁移账本建（ctx.db.migrate），照 Relay.test.ts 挂一个真的 Db 服务。
  const dbService = new dbModule.Db(new cordis.Context(), db);
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
      //M 照 Sessions.find：每一项按 json 路径比，address.messageId 这种嵌套的也认。
      find: (where: Record<string, unknown>) => [...sessions.values()]
        .filter((one) => Object.entries(where).every(([key, value]) => {
          const found = key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], one.row);
          return found === value;
        }))
        .map((one) => one.row),
      create: (input: { bot: string; kind: string; customer?: string }) => {
        serial += 1;
        const id = `s${String(serial)}`;
        const session: FakeSession = {
          id, row: { id, state: 'done', messages: [], ...input }, save: () => undefined,
          run: () => { ran.push(id); return Promise.resolve(); },
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
      //M 照 Bot.receive：挨个问 bot/receive，没人认领的交给前台（Dispatch.receive）；处理掉了就算了，定了会话就照 bots.route 记下渠道和地址，交给它。
      receive: async (_channel: string, botName: string, text: string, address: Record<string, unknown>): Promise<void> => {
        const target = botsByName.get(botName);
        if (target === undefined) throw new Error(`没有机器人 ${botName}`);

        const event: { bot: typeof bot; message: { channel: string; text: string; address: unknown };
          session?: FakeSession; handled?: boolean } = { bot: target, message: { channel: 'feishu', text, address } };
        for (const handler of handlers.get('bot/receive') ?? []) await handler(event);
        await dispatch?.receive(event as unknown as ReceiveEvent);
        if (event.handled === true) return;
        if (event.session === undefined) throw new Error('没有插件管分派');
        event.session.row.channel = 'feishu';
        event.session.row.address = address;
        delivered.push({ session: event.session, text: event.message.text, address });
      },
    },
    on: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    //M 照 Cordis：serial 挨个 await 监听函数。
    serial: async (name: string, ...args: unknown[]) => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(...args);
      }
    },
    //M 照 Cordis：事件发给听它的；trace 没人听。
    emit: (name: string, ...args: unknown[]) => {
      for (const handler of handlers.get(name) ?? []) void handler(...args);
    },
    effect: (open: () => (() => void) | undefined) => {
      const close = open();
      if (close !== undefined) closers.push(close);
    },
    get: (service: string) => {
      if (service !== 'decision' || decision === undefined) return undefined;
      return {
        judge: (input: FakeDecision['asked'][number]) => {
          decision.asked.push(input);
          return Promise.resolve({ reason: '假的', results: [], ...(decision.verdicts.shift() ?? { verdict: 'unsure' }) });
        },
      };
    },
    inject: () => Promise.resolve(),
    //M 照 Cordis：前台的 Dispatch 是服务（ctx.frontDesk），建服务时调 reflect.provide 登记；这里用不到，空着。
    reflect: { provide: () => undefined },
  };
  const ctx = fake as unknown as cordis.Context;

  //M relay 听 bot/receive；前台不听，由假 bots.receive 问完 bot/receive 再交给它（照 Bot.receive）。
  relayModule.apply(ctx, { helpers: [{ name: 'Claude', prefixes: ['cc'] }] });
  const desk = new FrontDesk(ctx, { recent: 50 });
  dispatch = new Dispatch(ctx, desk, undefined);
  //M 桥接渠道发的三个进来的事件到现有假环境（不启动真 Bots 服务）：三个事件挂同一个处理，照 Bots.onChannelMessage。
  const bridge = (event: protocol.InboundEvent) => async (rawMsg: unknown, rawControl: unknown): Promise<void> => {
    const message = rawMsg as protocol.ChannelMessage;
    const control = rawControl as protocol.ChannelMessageControl | undefined;
    emitted.push({ event, targetBots: [...message.targetBots], address: structuredClone(message.origin.address) });

    //M 只有 channel/listen 来的是只听的话：地址副本上标 listenOnly，前台、relay 读它。
    const listen = event === 'channel/listen';
    for (const botName of message.targetBots) {
      const originAddress = structuredClone(message.origin.address);
      if (listen) {
        originAddress['listenOnly'] = true;
      }
      await fake.bots.receive(message.channel, botName, message.text, originAddress);
      const judged = typeof originAddress['judged'] === 'string' ? originAddress['judged'] : undefined;
      const deliveredItem = delivered.findLast((d) => d.address === originAddress);
      if (deliveredItem !== undefined) {
        control?.claims.push({
          bot: botName,
          claimKey: JSON.stringify([message.messageId, botName]),
          status: deliveredItem.session.row.kind === 'relay' ? 'relay' : 'claimed',
          sessionKind: deliveredItem.session.row.kind,
          sessionId: deliveredItem.session.id,
          ...(judged === undefined ? {} : { judged }),
        });
        continue;
      }
      if (judged !== undefined || listen) {
        control?.claims.push({
          bot: botName,
          claimKey: JSON.stringify([message.messageId, botName]),
          status: 'listen',
          ...(judged === undefined ? {} : { judged }),
        });
      }
    }
  };
  for (const eventName of ['channel/direct', 'channel/mention', 'channel/listen'] as const) {
    handlers.set(eventName, [bridge(eventName)]);
  }
  const appConfig: feishuModule.FeishuApp = { appId: APP_ID, appSecret: 'x', bot: BOT, bots: extraBots };
  const config = {
    domain: 'http://127.0.0.1:9', apps: [appConfig], people: PEOPLE, groups: GROUPS, historyOnJoin: 0,
  };
  const feishu = new feishuModule.Feishu(ctx, config);

  //M 不连飞书：自己的 open_id、两个群的群名和成员直接填（名字故意和登记的不一样）；挂表情换成假的。
  const inside = feishu as unknown as {
    apps: Map<string, { botOpenId?: string; client: { im: { v1: { messageReaction: Record<string, unknown> } } } }>;
    chats: Map<string, unknown>;
    inbound: { onMessage: (appId: string, data: unknown) => Promise<void> };
  };
  const app = inside.apps.get(APP_ID);
  if (app === undefined) throw new Error('应用没建起来');
  app.botOpenId = BOT_OPEN_ID;
  app.client.im.v1.messageReaction['create'] = () => Promise.resolve({ data: { reaction_id: 'r1' } });
  app.client.im.v1.messageReaction['delete'] = () => Promise.resolve({});
  (app.client.im.v1 as unknown as { message: Record<string, unknown> }).message = {
    reply: (input: { data: { content: string } }) => {
      said.push((JSON.parse(input.data.content) as { text: string }).text);
      return Promise.resolve({ data: { message_id: 'om_reply' } });
    },
    //M 引用别的消息时入站会去飞书取被引那条的原文（media.related）：这里取不到，正文里记“回复的消息未取到”，不连飞书。
    get: () => Promise.resolve({ data: { items: [] } }),
  };
  const members = new Map([[FRIEND, '飞书上的名字'], [STRANGER, '陌生人']]);
  const groups: [string, string][] = [[LISTENED, '飞书群名'], [PLAIN, '普通群'], [JUDGED, '飞书判断群']];
  for (const [chatId, name] of groups) {
    inside.chats.set(chatId, { name, members, at: Date.now() });
  }

  const send: World['send'] = async (chatId, text, options = {}) => {
    messageNo += 1;
    const atMe = options.atMe ?? false;
    const mentions = atMe ? [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: BOT }] : [];
    const data = {
      sender: { sender_id: { open_id: options.sender ?? FRIEND }, sender_type: 'user' },
      message: {
        message_id: `om_${String(messageNo)}`, chat_id: chatId, chat_type: options.chatType ?? 'group', message_type: 'text',
        content: JSON.stringify({ text: atMe ? `@_user_1 ${text}` : text }), mentions,
        //M 引用（回复）的那条：不引用时是 undefined，入站当没引用。
        parent_id: options.parentId,
      },
    };
    await inside.inbound.onMessage(APP_ID, data);
  };
  const change = (session: FakeSession): void => {
    for (const handler of handlers.get('session/change') ?? []) handler(session);
  };
  return { feishu, sessions, delivered, emitted, said, ran, send, change };
}

/** 这场会话里存下的用户话。 */
const userTexts = (session: FakeSession | undefined): unknown[] => (session?.row.messages ?? [])
  .filter((message) => message.role === 'user').map((message) => message.content);

/** 这个群的前台会话。 */
const getFront = (made: World, chatId: string): FakeSession | undefined => [...made.sessions.values()]
  .find((one) => one.row.kind === 'front' && one.row.customer === `feishu:group:${chatId}`);

/** 流水里每条的处理结果，按先后。 */
const outcomes = (made: World): string[] => made.feishu.contacts.list(100).reverse().map((line) => line.outcome);

describe('登记了 listen: all 的群', () => {
  test('不 @ 的普通话只记进群的前台会话（登记的名字优先），不交给会话跑；流水记“只记”', async () => {
    const made = world();

    await made.send(LISTENED, '今天中午吃啥');
    await made.send(LISTENED, '随便', { sender: STRANGER });

    expect(made.delivered).toEqual([]);
    //M 周周登记过，用登记的名字；陌生人没登记，用飞书查到的。
    expect(userTexts(getFront(made, LISTENED))).toEqual(['周周：今天中午吃啥', '陌生人：随便']);
    expect(outcomes(made)).toEqual(['只记', '只记']);
  });

  test('cc 开头的不 @ 也进 relay；@ 机器人的交给前台会话，前面记下的群聊还在；地址带登记的群名、relay: model', async () => {
    const made = world();

    await made.send(LISTENED, 'cc 帮我看下日志');
    expect(made.delivered[0]?.session.row.kind).toBe('relay');
    expect(made.delivered[0]?.address).toMatchObject({ senderName: '周周', chatName: '周-论文实现', owner: false });

    //M 没叫机器人：发的是 channel/listen；渠道的原地址不带 listenOnly，交给 relay 的是 bots 在自己地址副本上标了 listenOnly 的那份。
    expect(made.emitted[0]?.event).toBe('channel/listen');
    expect(made.emitted[0]?.address['listenOnly']).toBeUndefined();
    expect(made.delivered[0]?.address['listenOnly']).toBe(true);

    await made.send(LISTENED, '先聊着');
    await made.send(LISTENED, '你怎么看', { atMe: true });
    const front = made.delivered[1];
    expect(front?.session.row.kind).toBe('front');
    expect(front?.text.trim()).toBe('你怎么看');
    //M @ 了机器人：发的是 channel/mention，地址副本不标 listenOnly。
    expect(made.emitted[2]?.event).toBe('channel/mention');
    expect(front?.address['listenOnly']).toBeUndefined();
    expect(front?.address['relay']).toBe('model');
    expect(userTexts(front?.session)).toEqual(['周周：先聊着']);

    expect(outcomes(made)).toEqual(['转外部助手', '只记', '交给会话']);
  });

  test('@ 了机器人 A：只发 channel/mention、只投 A；同应用的别的机器人 B 收不到这句（前面没叫的那句两个都当背景记）', async () => {
    const made = world(undefined, [OTHER_BOT]);

    await made.send(LISTENED, '先聊着');
    await made.send(LISTENED, '帮我看下', { atMe: true });

    //M 没叫的那句：群登记了 listen: all，本应用的两个机器人都收，发 channel/listen。
    //M @ 了 BOT 的那句：只发 channel/mention，targetBots 只有被叫到的 BOT，登记了 listen: all 也不再投给别的机器人。
    expect(made.emitted.map((one) => [one.event, one.targetBots])).toEqual([
      ['channel/listen', [BOT, OTHER_BOT]],
      ['channel/mention', [BOT]],
    ]);

    //M 交给会话的只有 BOT 一场前台；OTHER_BOT 只有第一句当背景，没有收到 @ 的那句。
    expect(made.delivered).toHaveLength(1);
    expect(made.delivered[0]?.session.row.bot).toBe(BOT);
    expect(made.delivered[0]?.text.trim()).toBe('帮我看下');
    const otherFront = [...made.sessions.values()].find((one) => one.row.bot === OTHER_BOT);
    expect(otherFront?.row.kind).toBe('front');
    expect(userTexts(otherFront)).toEqual(['周周：先聊着']);
    expect(outcomes(made)).toEqual(['只记', '交给会话']);
  });

  test('前台会话正在转时来的普通话先排着，这一轮结束再记', async () => {
    const made = world();
    await made.send(LISTENED, '第一句');
    const front = getFront(made, LISTENED);
    if (front === undefined) throw new Error('没开前台会话');

    front.row.state = 'running';
    await made.send(LISTENED, '转的时候说的');
    expect(userTexts(front)).toEqual(['周周：第一句']);

    front.row.state = 'done';
    made.change(front);
    expect(userTexts(front)).toEqual(['周周：第一句', '周周：转的时候说的']);
    expect(made.delivered).toEqual([]);
  });
});

describe('没登记的群、私聊', () => {
  test('原始日志落盘失败时记下消息号和原因、流水写“没处理成”，只听的话不往群里报错，下一条继续认领', async () => {
    const made = world();
    const reason = '模拟原始聊天日志写入失败';
    const append = spyOn(made.feishu.history, 'appendChatLog').mockImplementationOnce(() => {
      throw new Error(reason);
    });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      //M 未登记群且没 @ 的话也走完整入站：保存原文失败时记日志和流水，只听的话不往群里发报错，本次入站结束。
      const messageId = `om_${String(messageNo + 1)}`;
      await made.send(PLAIN, '本次写不进去');
      expect(errors.mock.calls).toHaveLength(1);
      expect(errors.mock.calls[0]?.[0]).toContain(`飞书：消息 ${messageId} 没处理成：${reason}`);
      expect(made.delivered).toEqual([]);
      expect(made.emitted).toEqual([]);
      expect(made.said).toEqual([]);

      //M 下一条由当前应用正常完成分派并写入认领流水。
      await made.send(PLAIN, '下一条照常收到', { atMe: true });
      expect(made.delivered).toHaveLength(1);
      expect(made.delivered[0]?.text).toContain('下一条照常收到');
      expect(outcomes(made)).toEqual([`没处理成：${reason}`, '交给会话']);
      expect(errors.mock.calls).toHaveLength(1);
    } finally {
      errors.mockRestore();
      append.mockRestore();
    }
  });

  test('没登记的群：不 @ 的（cc 开头的也一样）发 channel/listen（targetBots 空）、不进任何会话，流水记“只记”；@ 的照常交下去', async () => {
    const made = world();

    await made.send(PLAIN, '今天中午吃啥');
    await made.send(PLAIN, 'cc 帮我看下日志');

    //M 没登记的群没人叫：原件照存、照发 channel/listen 给记录类插件，targetBots 是空的，所以没有机器人认领、没有会话。
    expect(made.emitted.map((one) => [one.event, one.targetBots])).toEqual([
      ['channel/listen', []],
      ['channel/listen', []],
    ]);
    expect(made.delivered).toEqual([]);
    expect(made.sessions.size).toBe(0);
    expect(getFront(made, PLAIN)).toBeUndefined();

    await made.send(PLAIN, '你好', { atMe: true });
    expect(made.emitted[2]).toMatchObject({ event: 'channel/mention', targetBots: [BOT] });
    expect(made.delivered[0]?.session.row.kind).toBe('front');
    //M 没登记的群用飞书查到的群名，不带 relay。
    expect(made.delivered[0]?.address).toMatchObject({ chatName: '普通群', senderName: '周周' });
    expect(made.delivered[0]?.address['relay']).toBeUndefined();

    expect(outcomes(made)).toEqual(['只记', '只记', '交给会话']);
  });

  test('群里引用了机器人发的那条：算叫了发那条的机器人（没登记的群也一样），发 channel/mention，targetBots 只有它', async () => {
    const made = world(undefined, [OTHER_BOT]);

    //M 聊天日志里记着 OTHER_BOT 在这个群发过一条：和 Reply.ts 发完记日志的样子一样，direction 是 bot，sender.name 是机器人名。
    const botNativeId = 'om_bot_said';
    const botSaid: FeishuChatLogEntry = {
      messageId: JSON.stringify(['feishu', APP_ID, botNativeId]),
      nativeId: botNativeId,
      appId: APP_ID,
      chatId: PLAIN,
      direction: 'bot',
      createdAt: Date.now(),
      sender: { id: BOT_OPEN_ID, name: OTHER_BOT },
      text: '我是别的机器人发的',
      mentions: [],
      attachments: [],
    };
    made.feishu.history.appendChatLog(APP_ID, PLAIN, botSaid);

    //M 没 @ 任何机器人，只是引用（回复）了那一条。
    await made.send(PLAIN, '你说得对', { parentId: botNativeId });

    expect(made.emitted.map((one) => [one.event, one.targetBots])).toEqual([['channel/mention', [OTHER_BOT]]]);
    expect(made.delivered).toHaveLength(1);
    expect(made.delivered[0]?.session.row.bot).toBe(OTHER_BOT);
    expect(made.delivered[0]?.session.row.kind).toBe('front');
    expect(outcomes(made)).toEqual(['交给会话']);
  });

  test('引用的是人说的话（不是机器人发的）：不算叫了机器人，没登记的群照旧发 channel/listen（targetBots 空）', async () => {
    const made = world();

    //M 先有一句人说的话落进聊天日志，再引用它。
    const userNativeId = `om_${String(messageNo + 1)}`;
    await made.send(PLAIN, '随便说一句');
    await made.send(PLAIN, '我同意', { parentId: userNativeId });

    expect(made.emitted.map((one) => [one.event, one.targetBots])).toEqual([
      ['channel/listen', []],
      ['channel/listen', []],
    ]);
    expect(made.delivered).toEqual([]);
    expect(outcomes(made)).toEqual(['只记', '只记']);
  });

  test('流水一行的样子：时间、应用、聊天、群名、说话人、有没有 @、话的前 80 字；私聊也记', async () => {
    const made = world();
    await made.send(PLAIN, '长'.repeat(100));
    await made.send('oc_p2p', '在吗', { chatType: 'p2p', sender: OWNER });

    //M 没登记的群没 @ 的发 channel/listen，私聊发 channel/direct。
    expect(made.emitted.map((one) => one.event)).toEqual(['channel/listen', 'channel/direct']);

    const [p2p, listened] = made.feishu.contacts.list(10);
    expect(listened).toMatchObject({
      app: APP_ID, chatType: 'group', chatId: PLAIN, chatName: '普通群', openId: FRIEND, sender: '周周', atMe: false, outcome: '只记',
    });
    expect(listened?.text).toBe(`${'长'.repeat(80)}…`);
    expect(listened?.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    expect(p2p).toMatchObject({ chatType: 'p2p', openId: OWNER, sender: 'leon', atMe: true, text: '在吗', outcome: '交给会话' });
    //M 只要最近 1 行：就是上面最近 10 行里的第一行（私聊那行）。
    const latest = made.feishu.contacts.list(10).slice(0, 1);
    expect(made.feishu.contacts.list(1)).toEqual(latest);
  });

  test('owner、role、workspace：照 people 写；没登记的是 guest；builder 带他的目录，guest 没写目录的用 guests/_guest/', async () => {
    const made = world();
    await made.send(PLAIN, '我', { atMe: true, sender: OWNER });
    await made.send(PLAIN, '朋友', { atMe: true, sender: FRIEND });
    await made.send(PLAIN, '路人', { atMe: true, sender: STRANGER });
    await made.send(PLAIN, '帮我写个脚本', { atMe: true, sender: BUILDER });

    const roles = made.delivered.map((one) => [one.address['owner'], one.address['role'], one.address['workspace']]);
    expect(roles).toEqual([
      [true, 'owner', undefined],
      [false, 'guest', expect.stringContaining(path.join('guests', '_guest'))],
      [false, 'guest', expect.stringContaining(path.join('guests', '_guest'))],
      [false, 'builder', BUILDER_DIR],
    ]);
  });
});

describe('checkConfig 收登记', () => {
  /** 照 config.yaml 拼一个应用和飞书插件配置。 */
  const getConfig = (own: Record<string, unknown>): ReturnType<typeof feishuModule.checkConfig> => {
    const ctx = {
      resources: {
        root,
        raw: { bots: [{ name: BOT }], channels: { feishu: [{ app_id: APP_ID, app_secret: 'x', bot: BOT }] } },
      },
      bots: { get: (name: string) => (name === BOT ? { name } : undefined) },
    } as unknown as cordis.Context;
    return feishuModule.checkConfig(ctx, own);
  };

  test('按 role 登记本人，缺省是访客，按设置创建 builder、guest 目录', () => {
    const config = getConfig({
      people: [
        { open_id: OWNER, name: 'leon', role: 'owner' },
        { open_id: FRIEND, name: '周周' },
        { open_id: BUILDER, name: '小王', role: 'builder' },
        { open_id: 'ou_b2', name: '老李', role: 'builder', dir: 'guests/lee-project' },
      ],
      groups: [{ chat_id: LISTENED, name: '周-论文实现', listen: 'all', relay: 'model', trusted: true }, { chat_id: PLAIN }],
    });

    const leeDir = path.join(root, 'guests', 'lee-project');
    expect([...config.people.values()]).toEqual([
      { openId: OWNER, name: 'leon', role: 'owner', dir: '' },
      { openId: FRIEND, name: '周周', role: 'guest', dir: path.join(root, 'guests', '周周') },
      { openId: BUILDER, name: '小王', role: 'builder', dir: BUILDER_DIR },
      { openId: 'ou_b2', name: '老李', role: 'builder', dir: leeDir },
    ]);
    expect(fs.existsSync(BUILDER_DIR) && fs.existsSync(leeDir)).toBe(true);
    expect(config.groups.get(PLAIN)).toEqual({ chatId: PLAIN, name: '', listen: 'mention', relay: 'direct', trusted: false });
    expect(config.groups.get(LISTENED)?.listen).toBe('all');
    expect(config.groups.get(LISTENED)?.trusted).toBe(true);
    expect(getConfig({}).people.size).toBe(0);
  });

  test('写错的抛错', () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ people: [{ open_id: OWNER }] }, 'open_id 和 name'],
      [{ people: [{ open_id: OWNER, name: 'a', owner: true }] }, 'role: owner'],
      [{ people: [{ open_id: OWNER, name: 'a', owner: false, role: 'guest' }] }, 'people[].owner 已不用'],
      [{ people: [{ open_id: OWNER, name: 'a', role: 'admin' }] }, 'role'],
      [{ people: [{ open_id: OWNER, name: '../x', role: 'builder' }] }, '目录名'],
      [{ people: [{ open_id: OWNER, name: 'a' }, { open_id: OWNER, name: 'b' }] }, '写了两次'],
      [{ groups: [{ chat_id: PLAIN, listen: 'everything' }] }, 'listen'],
      [{ groups: [{ chat_id: PLAIN, relay: 'auto' }] }, 'relay'],
      [{ groups: [{ chat_id: PLAIN, trusted: 'yes' }] }, 'trusted'],
      [{ groups: { chat_id: PLAIN } }, '清单'],
    ];
    for (const [own, message] of bad) {
      expect(() => getConfig(own)).toThrow(message);
    }
  });
});


/** 一套带假决策模型的环境。 */
const judgeWorld = (verdicts: FakeDecision['verdicts']): { made: World; decision: FakeDecision } => {
  const decision: FakeDecision = { verdicts, asked: [] };
  return { made: world(decision), decision };
};

describe('listen: judge 的群', () => {
  test('不 @ 的话发 channel/listen，地址带 judge 和阈值；这条旧路（Bot.receive → 前台）只记不判断，判断归 bots 的群攒批（bots/GroupBatch.test.ts）', async () => {
    const { made, decision } = judgeWorld([{ verdict: 'allow', score: 0.9 }]);

    await made.send(JUDGED, '谁知道周报模板在哪');

    //M 渠道这一侧：发 channel/listen，地址带 judge 和群登记的阈值，给 bots 的群攒批读。
    expect(made.emitted.map((one) => one.event)).toEqual(['channel/listen']);
    expect(made.emitted[0]?.address['judge']).toBe(true);
    expect(made.emitted[0]?.address['judgeThreshold']).toBe(0.8);
    //M 登记了 judge_helper：地址带 judgeHelper，群攒批判定要接话时转给它。
    expect(made.emitted[0]?.address['judgeHelper']).toBe('Claude');

    //M 旧路的前台：只记进群的前台会话当背景，不问决策模型、不交给会话跑，流水写“只记”。
    expect(made.delivered).toEqual([]);
    expect(userTexts(getFront(made, JUDGED))).toEqual(['周周：谁知道周报模板在哪']);
    expect(decision.asked).toEqual([]);
    expect(outcomes(made)).toEqual(['只记']);
  });

  test('cc 开头的照转外部助手，不问决策模型；@ 机器人的照旧交给会话', async () => {
    const { made, decision } = judgeWorld([]);
    await made.send(JUDGED, 'cc 帮我看下日志');
    await made.send(JUDGED, '你好', { atMe: true });
    expect(made.delivered.map((one) => one.session.row.kind)).toEqual(['relay', 'front']);
    expect(decision.asked).toEqual([]);
  });
});

describe('群里发的话 @ 人', () => {
  /** 群里最后说话的人的回话地址。 */
  const getAddress = (chatId: string, openId: string, chatType = 'group'): feishuModule.FeishuAddress => ({
    appId: APP_ID, chatId, messageId: 'om_x', openId, chatType,
    customer: feishuModule.feishuCustomer(chatType, chatId, openId),
  });

  test('文字里的 @名字 换成 <at user_id>：先 people，再群成员；认不出的原样留着；私聊不动', async () => {
    const made = world();
    await made.feishu.sendText(getAddress(PLAIN, FRIEND), '@leon 你看下，@陌生人 也看下，@不认识 别管');
    await made.feishu.sendText(getAddress('oc_p2p', OWNER, 'p2p'), '@leon 你看下');

    expect(made.said[0]).toBe('<at user_id="ou_owner">leon</at> 你看下，<at user_id="ou_stranger_abcdef">陌生人</at> 也看下，@不认识 别管');
    expect(made.said[1]).toBe('@leon 你看下');
  });

  test('流水里见过的说话人也认（群成员里没有的）', async () => {
    const made = world();
    await made.send(PLAIN, '我来了', { sender: 'ou_newcomer_1' });
    await made.feishu.sendText(getAddress(PLAIN, FRIEND), '@周周 看下');
    expect(made.said[0]).toBe('<at user_id="ou_friend">周周</at> 看下');

    //M 流水里这个人名字是飞书查不到的 ''，认不出；换个有名字的。
    (made.feishu as unknown as { chats: Map<string, { members: Map<string, string> }> }).chats.get(PLAIN)?.members.set('ou_newcomer_1', '新来的');
    await made.send(PLAIN, '我又来了', { sender: 'ou_newcomer_1' });
    await made.feishu.sendText(getAddress(PLAIN, FRIEND), '@新来的 欢迎');
    expect(made.said[1]).toBe('<at user_id="ou_newcomer_1">新来的</at> 欢迎');
  });

  test('群里的回信开头 @ 最后说话的人（登记的名字）；话里已经 @ 了他不重复；私聊不加', async () => {
    const made = world();
    const front = (address: feishuModule.FeishuAddress): FakeSession => ({
      id: 'sx', row: { id: 'sx', bot: BOT, kind: 'front', state: 'done', messages: [], address }, save: () => undefined,
    });
    //M 会话一轮结束的旧路回话：照 Bots.send 的样子发 channel/reply（没有来源快照，target 带会话记的地址，开 atFiles），直接交飞书的回复处理。
    const replier = made.feishu.reply as unknown as { onChannelReply: (request: protocol.ChannelReplyRequest) => Promise<void> };
    let callNo = 0;
    const send = (session: FakeSession, reply = '好的，已经查了'): Promise<void> => {
      callNo += 1;
      const address = session.row.address as Record<string, unknown>;
      const request: protocol.ChannelReplyRequest = {
        requestId: `rep_${String(callNo)}`,
        channel: 'feishu',
        bot: BOT,
        replyRequestKey: `legacy-${String(callNo)}`,
        replyRoundKey: 'legacy-round',
        replyIndex: 0,
        kind: 'final',
        mode: 'text',
        payloadHash: `hash-${String(callNo)}`,
        parts: [{ partId: 'text:0', kind: 'text', text: reply }],
        target: { channel: 'feishu', chat: '', address },
        sessionId: session.id,
        atFiles: true,
      };
      return replier.onChannelReply(request);
    };

    await send(front(getAddress(PLAIN, FRIEND)));
    await send(front(getAddress(PLAIN, OWNER)));
    await send(front(getAddress('oc_p2p', OWNER, 'p2p')));
    await made.feishu.sendText(getAddress(PLAIN, FRIEND), '@周周 自己写了');
    //M 等飞书发送结束再核对，避免按固定延时猜测发送是否完成。
    const groupAddress = getAddress(PLAIN, FRIEND);
    const groupSession = front(groupAddress);
    const mentioned = '@周周 自己写了';
    await send(groupSession, mentioned);

    expect(made.said[0]).toBe('<at user_id="ou_friend">周周</at> 好的，已经查了');
    expect(made.said[1]).toBe('<at user_id="ou_owner">leon</at> 好的，已经查了');
    expect(made.said[2]).toBe('好的，已经查了');
    expect(made.said[3]).toBe('<at user_id="ou_friend">周周</at> 自己写了');
    expect(made.said[4]).toBe('<at user_id="ou_friend">周周</at> 自己写了');
  });
});

describe('checkConfig 认 judge', () => {
  const getConfig = (own: Record<string, unknown>): ReturnType<typeof feishuModule.checkConfig> => {
    const raw = { bots: [{ name: BOT }], channels: { feishu: [{ app_id: APP_ID, app_secret: 'x', bot: BOT }] } };
    const ctx = {
      resources: { root, raw, config: { plugins: [] } },
    } as unknown as cordis.Context;
    return feishuModule.checkConfig(ctx, own);
  };

  test('listen: judge 和 judge_threshold 收下；不写阈值就没有；写错抛错', () => {
    const config = getConfig({ groups: [{ chat_id: JUDGED, listen: 'judge', judge_threshold: 0.7 }, { chat_id: PLAIN, listen: 'judge' }] });
    expect(config.groups.get(JUDGED)).toMatchObject({ listen: 'judge', judgeThreshold: 0.7 });
    expect(config.groups.get(PLAIN)?.judgeThreshold).toBeUndefined();
    expect(() => getConfig({ groups: [{ chat_id: PLAIN, listen: 'judge', judge_threshold: 1.5 }] })).toThrow('judge_threshold');
    expect(() => getConfig({ groups: [{ chat_id: PLAIN, listen: 'judge', judge_threshold: '高' }] })).toThrow('judge_threshold');
    expect(() => getConfig({ groups: [{ chat_id: PLAIN, listen: 'judging' }] })).toThrow('listen');
  });

  test('judge_helper 收下；不写就没有；写成空的抛错', () => {
    const config = getConfig({ groups: [{ chat_id: JUDGED, listen: 'judge', judge_helper: 'Claude' }, { chat_id: PLAIN, listen: 'judge' }] });
    expect(config.groups.get(JUDGED)?.judgeHelper).toBe('Claude');
    expect(config.groups.get(PLAIN)?.judgeHelper).toBeUndefined();
    expect(() => getConfig({ groups: [{ chat_id: PLAIN, listen: 'judge', judge_helper: '' }] })).toThrow('judge_helper');
  });
});
