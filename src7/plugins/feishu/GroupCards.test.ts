/**
 * 飞书群里不发卡片、点卡片和“同意 N”只认本人（2026-11-17，0.7.18）。
 * 跑法：bun test ./src7/plugins/feishu/GroupCards.test.ts
 * 卡片那块：真的 cards/Cards.ts 接在假的 Feishu（只记下发了什么卡片、什么文字）和假 ctx 上，不连飞书。
 * 文字“同意 N”：真的 Cordis + 真的 approval 插件，resources、bots、sessions 是只够它挂上的假服务；照骨架发 bot/receive。
 * 查的是：群里的会话有待确认，卡片发本人私聊、群里只有一句文字；找不到本人私聊退回最近私聊的人；进度卡片群里不发；
 * 别人点卡片回“只有 某某 能处理”、不定不终止；群里的发起人（不是本人）说“同意 N”不算，本人说才算。
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as requestEvents from '../../utils/RequestEvent.ts';
import type { ReceiveEvent } from '../bots/index.ts';
import * as approvalModule from '../approval/index.ts';
import * as cards from './cards/Cards.ts';
import type * as render from './cards/Render.ts';
import type { Feishu, FeishuAddress, FeishuPerson } from './index.ts';


const BOT = '测试机器人';
const APP_ID = 'cli_0123456789abcdef';
const OWNER = 'ou_owner';
const BUILDER = 'ou_builder';
const FRIEND = 'ou_friend';
/** 客户群。 */
const GROUP_CHAT = 'oc_customer_group';
/** 本人和机器人的私聊。 */
const OWNER_CHAT = 'oc_owner_p2p';
/** 最近私聊机器人的人（不是本人）。 */
const LAST_CHAT = 'oc_last_p2p';

/** 登记：本人 leon、builder 小王、guest 周周。 */
const PEOPLE = new Map<string, FeishuPerson>([
  [OWNER, { openId: OWNER, name: 'leon', role: 'owner', dir: '' }],
  [BUILDER, { openId: BUILDER, name: '小王', role: 'builder', dir: '/tmp/x' }],
  [FRIEND, { openId: FRIEND, name: '周周', role: 'guest', dir: '/tmp/y' }],
]);

/** 群里各人的回话地址（飞书插件照 people 写的样子）。 */
const IN_GROUP = { appId: APP_ID, chatId: GROUP_CHAT, messageId: 'om_g', chatType: 'group', customer: `feishu:group:${GROUP_CHAT}` };
const OWNER_IN_GROUP: FeishuAddress = { ...IN_GROUP, openId: OWNER, owner: true, role: 'owner' };
const BUILDER_IN_GROUP: FeishuAddress = { ...IN_GROUP, openId: BUILDER, owner: false, role: 'builder', workspace: '/tmp/x' };
const FRIEND_IN_GROUP: FeishuAddress = { ...IN_GROUP, openId: FRIEND, owner: false, role: 'guest', workspace: '/tmp/y' };
/** 本人私聊的回话地址。 */
const OWNER_P2P: FeishuAddress = { appId: APP_ID, chatId: OWNER_CHAT, messageId: 'om_p', openId: OWNER, chatType: 'p2p', customer: `feishu:${OWNER}`, owner: true, role: 'owner' };


/** 一场假会话的记录。 */
interface Row {
  id: string;
  bot: string;
  kind: string;
  channel: string;
  customer?: string;
  address: unknown;
  messages: unknown[];
}


/** 照 Sessions.find：每一项按 json 路径比，address.openId 这种嵌套的也认。 */
function finder(rows: Row[]): (where: Record<string, unknown>) => Row[] {
  return (where) => rows.filter((row) => Object.entries(where).every(([key, value]) => {
    const found = key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], row);
    return found === value;
  }));
}


/** 卡片那块的一套假环境。 */
interface CardWorld {
  feishu: Feishu;
  actionCtx: cordis.Context;
  db: Database;
  /** 发出去的卡片：发到哪个聊天。 */
  cardsTo: string[];
  /** 发出去的文字：哪个聊天、什么话。 */
  texts: { chatId: string; text: string }[];
  /** ctx.on 登记的监听。 */
  handlers: Map<string, ((value: unknown) => void)[]>;
  /** 审批及进度请求收到的操作。 */
  calls: string[];
}


/**
 * 搭一套假 Feishu、通知监听和卡片按键用的 Cordis 总线。
 * @param rows 有哪些会话。
 * @param last 这个应用最近私聊的人；没有就是 undefined。
 */
function cardWorld(rows: Row[], last: FeishuAddress | undefined): CardWorld {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE feishu_cards (card_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, ended INTEGER, at INTEGER)');
  const cardsTo: string[] = [];
  const texts: { chatId: string; text: string }[] = [];
  const calls: string[] = [];
  const handlers = new Map<string, ((value: unknown) => void)[]>();
  let serial = 0;

  const fake = {
    config: { domain: '', apps: [{ appId: APP_ID, appSecret: 'fake', bot: BOT }], people: PEOPLE, groups: new Map(), historyOnJoin: 0 },
    db,
    getApps: () => [APP_ID],
    lastPrivate: () => last,
    sendCard: (address: FeishuAddress) => {
      serial += 1;
      cardsTo.push(address.chatId);
      return Promise.resolve(`om_card_${String(serial)}`);
    },
    sendText: (address: FeishuAddress, text: string) => {
      texts.push({ chatId: address.chatId, text });
      return Promise.resolve();
    },
    updateCard: () => Promise.resolve(),
  };
  const feishu = fake as unknown as Feishu;

  const ctx = {
    on: (name: string, handler: (value: unknown) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sessions: { find: finder(rows) },
  } as unknown as cordis.Context;
  cards.setupApproval(feishu, ctx);
  cards.setupProgress(feishu, ctx);
  const actionCtx = new cordis.Context();
  return { feishu, actionCtx, db, cardsTo, texts, handlers, calls };
}


/**
 * 发一个事件给登记的监听，等它发完（onAsked、onProgress 是 void 出去的）。
 * @param world 那套环境。
 * @param name 事件名。
 * @param value 事件的值。
 */
async function fire(world: CardWorld, name: string, value: unknown): Promise<void> {
  for (const handler of world.handlers.get(name) ?? []) handler(value);
  await Bun.sleep(20);
}


/** 群里那场会话（最后说话的是 builder）。 */
const GROUP_ROW: Row = { id: 'g1', bot: BOT, kind: 'front', channel: 'feishu', customer: IN_GROUP.customer, address: BUILDER_IN_GROUP, messages: [] };
/** 本人私聊那场会话。 */
const OWNER_ROW: Row = { id: 'p1', bot: BOT, kind: 'front', channel: 'feishu', customer: `feishu:${OWNER}`, address: OWNER_P2P, messages: [] };
/** 最近私聊机器人的人（不是本人）。 */
const LAST: FeishuAddress = { appId: APP_ID, chatId: LAST_CHAT, messageId: 'om_l', openId: 'ou_someone', chatType: 'p2p' };


/** 一件待确认。 */
function getPending(session: string): render.PendingLike {
  return { id: 1, kind: 'exec', title: '要执行一条命令', detail: 'rm -rf build', bot: BOT, session, state: 'waiting' };
}


describe('群里不发卡片', () => {
  test('群里的会话有待确认：卡片发本人私聊，群里只有一句文字', async () => {
    const world = cardWorld([GROUP_ROW, OWNER_ROW], LAST);
    await fire(world, 'approval/asked', getPending('g1'));

    expect(world.cardsTo).toEqual([OWNER_CHAT]);
    expect(world.texts).toEqual([{ chatId: GROUP_CHAT, text: '这一步要 leon 确认，已发到他私聊' }]);
  });

  test('找不到本人的私聊：卡片退回这个应用最近私聊的人，群里还是一句', async () => {
    const world = cardWorld([GROUP_ROW], LAST);
    await fire(world, 'approval/asked', getPending('g1'));

    expect(world.cardsTo).toEqual([LAST_CHAT]);
    expect(world.cardsTo).not.toContain(GROUP_CHAT);
    expect(world.texts).toEqual([{ chatId: GROUP_CHAT, text: '这一步要 leon 确认，已发到他私聊' }]);
  });

  test('私聊来的会话照旧发到会话的聊天，不多说话', async () => {
    const world = cardWorld([OWNER_ROW], LAST);
    await fire(world, 'approval/asked', getPending('p1'));

    expect(world.cardsTo).toEqual([OWNER_CHAT]);
    expect(world.texts).toEqual([]);
  });

  test('进度卡片群里不发，私聊照发', async () => {
    const world = cardWorld([GROUP_ROW, OWNER_ROW], LAST);
    const item = { id: 1, sessionId: 'g1', bot: BOT, text: '在跑', stage: 'running', action: '', startedAt: 0, steps: 1, timings: { modelMs: 0, tools: [] } };
    await fire(world, 'progress/update', item);
    expect(world.cardsTo).toEqual([]);
    expect(world.texts).toEqual([]);

    await fire(world, 'progress/update', { ...item, sessionId: 'p1' });
    expect(world.cardsTo).toEqual([OWNER_CHAT]);
  });
});


describe('点卡片只认本人', () => {
  test('别人点待确认、进度卡片：回“只有 leon 能处理”，不定、不终止，表里不变', async () => {
    const world = cardWorld([GROUP_ROW], undefined);
    requestEvents.onRequestEvent(world.actionCtx, 'approval/request', 'approval/result', (request) => {
      expect(request).toMatchObject({ action: 'decide', id: 1, approve: true, by: `飞书卡片 ${OWNER}` });
      world.calls.push('decide');
      const original = getPending('g1');
      const settled = { ...original, state: 'approved' } as approvalModule.Pending;
      return { settled };
    });
    requestEvents.onRequestEvent(world.actionCtx, 'progress/request', 'progress/result', () => {
      world.calls.push('act');
      return { ok: true, text: '收到，马上停' };
    });
    world.db.query("INSERT INTO feishu_cards (card_id, kind, ref, ended, at) VALUES ('om_a', 'approval', '1', 0, 0), ('om_p', 'progress', 'g1', 0, 0)").run();

    for (const address of [FRIEND_IN_GROUP, BUILDER_IN_GROUP]) {
      const approve = await cards.onAction(world.feishu, world.actionCtx, address, 'om_a', { action: 'approve' });
      expect(approve).toEqual({ type: 'warning', content: '只有 leon 能处理' });
      const stop = await cards.onAction(world.feishu, world.actionCtx, address, 'om_p', { action: 'stop' });
      expect(stop).toEqual({ type: 'warning', content: '只有 leon 能处理' });
    }
    expect(world.calls).toEqual([]);
    expect(world.db.query('SELECT card_id, ended FROM feishu_cards ORDER BY card_id').all()).toEqual([{ card_id: 'om_a', ended: 0 }, { card_id: 'om_p', ended: 0 }]);

    //M 本人点：照常交给 approval、progress。
    const approved = await cards.onAction(world.feishu, world.actionCtx, OWNER_IN_GROUP, 'om_a', { action: 'approve' });
    expect(approved).toEqual({ type: 'success', content: '已同意执行' });
    const stopped = await cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_p', { action: 'stop' });
    expect(stopped).toEqual({ type: 'info', content: '收到，马上停' });
    expect(world.calls).toEqual(['decide', 'act']);
    await world.actionCtx.fiber.dispose();
  });
});

test('审批卡片无人应答或明确失败时提示没办成', async () => {
  const world = cardWorld([OWNER_ROW], undefined);
  const sql = "INSERT INTO feishu_cards (card_id, kind, ref, ended, at) VALUES ('om_a', 'approval', '1', 0, 0)";
  world.db.query(sql).run();
  const value = { action: 'reject' };

  //M 没有审批插件时，卡片动作不能显示成功。
  const unavailable = await cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_a', value);
  expect(unavailable).toMatchObject({ type: 'warning', content: expect.stringContaining('待确认 #1 没办成') });

  //M 审核插件明确说处理失败时，透传原因。
  requestEvents.onRequestEvent(world.actionCtx, 'approval/request', 'approval/result', (request) => {
    expect(request).toMatchObject({ action: 'decide', approve: false });
    return { error: '这件待确认已经结束' };
  });
  const failed = await cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_a', value);
  expect(failed).toEqual({ type: 'warning', content: '待确认 #1 没办成：这件待确认已经结束' });
  expect(world.db.query('SELECT ended FROM feishu_cards').get()).toEqual({ ended: 0 });
  await world.actionCtx.fiber.dispose();
});


test('审批回执超时提示结果不确定，同一审批号的重复点击只提交一次', async () => {
  const world = cardWorld([OWNER_ROW], undefined);
  const insert = "INSERT INTO feishu_cards (card_id, kind, ref, ended, at) VALUES (?, 'approval', '1', 0, 0)";
  world.db.query(insert).run('om_a');
  world.db.query(insert).run('om_duplicate');
  const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    //M 模拟审批已接单但未在五秒内返回回执。
    world.actionCtx.on('approval/request', async (request) => {
      request.handled = true;
      if (request.action !== 'decide') return;

      world.calls.push(String(request.approve));
      await Bun.sleep(5100);
    });
    const approve = { action: 'approve' };
    const reject = { action: 'reject' };
    const expected = { type: 'warning', content: '操作结果不确定，请稍后刷新卡片核对' };
    const pending = cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_a', approve);
    const concurrent = await cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_duplicate', reject);
    expect(concurrent).toEqual(expected);
    expect(await pending).toEqual(expected);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('卡片 om_a（approval 1），提交审批决定 approve=true 未获回执（timeout），结果不确定'));

    //M 超时后连后来登记的同号卡片也不能再次发决定。
    world.db.query(insert).run('om_later');
    const repeated = await cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_later', reject);
    expect(repeated).toEqual(expected);
    expect(world.calls).toEqual(['true']);

    //M 晚到的确定通知收尾所有相关卡片，后续点击只能查看结果。
    const settled = { ...getPending('p1'), state: 'approved' };
    await fire(world, 'approval/decided', settled);
    const finished = await cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_a', approve);
    expect(finished).toEqual({ type: 'info', content: '这张卡片已处理，请刷新查看结果' });
    expect(world.db.query('SELECT ended FROM feishu_cards WHERE ended = 1').all()).toHaveLength(3);
    expect(world.calls).toEqual(['true']);
  } finally {
    warning.mockRestore();
    await world.actionCtx.fiber.dispose();
    world.db.close();
  }
}, 9000);


test('进度卡片通过请求改限时，进度失败或无人应答给出提示', async () => {
  const world = cardWorld([OWNER_ROW], undefined);
  world.db.query("INSERT INTO feishu_cards (card_id, kind, ref, ended, at) VALUES ('om_p', 'progress', 'p1', 0, 0)").run();
  const value = { action: 'limit', minutes: '15' };
  const unavailable = await cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_p', value);
  expect(unavailable).toMatchObject({ type: 'warning', content: expect.stringContaining('进度控制暂不可用') });

  requestEvents.onRequestEvent(world.actionCtx, 'progress/request', 'progress/result', (request) => {
    expect(request).toMatchObject({ action: 'act', sessionId: 'p1', op: 'limit', minutes: 15 });
    return { ok: false, text: '这件事已经结束了' };
  });
  const rejected = await cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_p', value);
  expect(rejected).toEqual({ type: 'warning', content: '这件事已经结束了' });
  await world.actionCtx.fiber.dispose();
});


test('终止和限时等不到回执时提示结果不确定，并按会话和动作记日志', async () => {
  const world = cardWorld([OWNER_ROW], undefined);
  const insert = "INSERT INTO feishu_cards (card_id, kind, ref, ended, at) VALUES (?, 'progress', ?, 0, 0)";
  world.db.query(insert).run('om_stop', 'p1');
  world.db.query(insert).run('om_limit', 'p2');
  const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    //M 两种进度操作都模拟接单后未返回，验证每种只发一次请求。
    world.actionCtx.on('progress/request', async (request) => {
      request.handled = true;
      if (request.action !== 'act') return;

      world.calls.push(request.op);
      await Bun.sleep(5100);
    });
    const stopValue = { action: 'stop' };
    const limitValue = { action: 'limit', minutes: 15 };
    const expected = { type: 'warning', content: '操作结果不确定，请稍后刷新卡片核对' };
    const stopped = cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_stop', stopValue);
    const limited = cards.onAction(world.feishu, world.actionCtx, OWNER_P2P, 'om_limit', limitValue);
    expect(await Promise.all([stopped, limited])).toEqual([expected, expected]);
    expect(world.calls).toEqual(['stop', 'limit']);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('卡片 om_stop（progress p1），stop 未获回执（timeout），结果不确定'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('卡片 om_limit（progress p2），limit 未获回执（timeout），结果不确定'));
  } finally {
    warning.mockRestore();
    await world.actionCtx.fiber.dispose();
    world.db.close();
  }
}, 9000);


/** 临时运行时目录。 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-group-cards-'));


/** 假的 resources：approval 建表用。 */
class FakeResources extends cordis.Service {
  db = new Database(':memory:');
  root = root;
  raw = {};
  config = { providers: {} };
  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }
  ensureRuntimeDir(...parts: string[]): string {
    const full = path.join(root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }
}


/** approval 跟会话说的话（它发通知 bot/say，假 bots 听着记下）。 */
const said: string[] = [];


/** 假的 bots：一个机器人；像真的 bots 一样听 bot/say，只记下说的话。 */
class FakeBots extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'bots');
    //M approval 不再直接调 bots.say，改发 bot/say：听这个通知，群里那条断言才测得到东西。
    ctx.on('bot/say', (_session, text) => {
      said.push(text);
    });
  }
  list(): unknown[] {
    return [{ name: BOT }];
  }
}


/** 假的 sessions：群里那场、本人私聊那场。 */
class FakeSessions extends cordis.Service {
  rows: Row[] = [GROUP_ROW, OWNER_ROW];
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
  }
  find(where: Record<string, unknown>): Row[] {
    return finder(this.rows)(where);
  }
  open(id: string): { id: string; row: Row } | undefined {
    const row = this.rows.find((one) => one.id === id);
    return row === undefined ? undefined : { id, row };
  }
}


/**
 * 照骨架发一条 bot/receive。
 * @param app 挂好的 Cordis。
 * @param text 说的话。
 * @param address 说话人的回话地址。
 * @returns 有没有被 approval 处理掉。
 */
async function receive(app: cordis.Context, text: string, address: unknown): Promise<boolean> {
  const event = { bot: { name: BOT }, message: { channel: 'feishu', text, address } } as unknown as ReceiveEvent;
  await app.serial('bot/receive', event);
  return event.handled === true;
}


describe('群里“同意 N”只认本人', () => {
  test('群里的发起人（builder）说“同意 1”不算，私聊说也不算；guest 也不算；本人在群里说才算', async () => {
    const app = new cordis.Context();
    await app.plugin(FakeResources);
    await app.plugin(FakeBots);
    await app.plugin(FakeSessions);
    await app.plugin(approvalModule, {});
    said.length = 0;

    const pending = app.approval.ask({ kind: 'exec', title: '要执行一条命令', detail: 'rm -rf build', payload: null, bot: BOT, session: 'g1' });
    //M 群里的会话：approval 不在群里说细节和怎么回（群里那一句由飞书卡片那块发）。
    expect(said).toEqual([]);

    const builderP2p = { appId: APP_ID, chatId: 'oc_b', messageId: 'om_b', openId: BUILDER, chatType: 'p2p', customer: `feishu:${BUILDER}`, owner: false, role: 'builder' };
    for (const address of [BUILDER_IN_GROUP, FRIEND_IN_GROUP, builderP2p]) {
      expect(await receive(app, `同意 ${String(pending.id)}`, address)).toBe(false);
    }
    expect(app.approval.list().map((item) => item.id)).toEqual([pending.id]);

    expect(await receive(app, `同意 ${String(pending.id)}`, OWNER_IN_GROUP)).toBe(true);
    expect(app.approval.list()).toEqual([]);
    //M 本人批了：approval 经 bot/say 回一句结果（证明假 bots 真的接得到这个通知）。
    expect(said).toEqual([`已同意待确认 #${String(pending.id)}。`]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
