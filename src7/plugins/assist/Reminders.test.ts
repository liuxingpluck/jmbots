/** 内存 SQLite、假时钟与合成来源验证提醒，不联系真实渠道。 */
import * as sqlite from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as channels from '../channels/index.ts';
import type { SourceSnapshot } from '../channels/index.ts';
import type { Session } from '../../Sessions.ts';
import type { ToolSpec } from '../../Tools.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as utils from '../../utils/index.ts';
import * as approval from '../approval/index.ts';
import * as outbound from '../approval/Outbound.ts';
import * as rules from '../approval/Rules.ts';
import type { ProviderReceipt } from '../programs/ChannelSend.ts';
import * as timeModule from './ReminderTime.ts';
import * as reminderModule from './Reminders.ts';

const NOW = Date.parse('2026-11-19T15:00:00Z');
const SATURDAY = Date.parse('2026-11-21T14:00:00Z');
const ZONE = 'America/New_York';
const CONTENT = '周六晚上八点开会';
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** 假渠道收到的一次发件：渠道、机器人、确切地址里的账号、聊天、提醒号，正文。 */
interface SentCall {
  channel: string;
  bot: string;
  account: string;
  chat: string;
  reminder: string;
  text: string;
}

/**
 * 挂飞书和网页两个假渠道：批准后的发件经 channel/reply 带确切地址来，记进 calls，回执照 answer 定。
 * @param ctx 测试的 Cordis 上下文。
 * @param calls 收到的发件记在这里。
 * @param answer 渠道交回的结果。
 */
function mountChannels(
  ctx: cordis.Context,
  calls: SentCall[],
  answer: () => channels.TextReplyOutcome | Promise<channels.TextReplyOutcome>,
): void {
  for (const channel of ['feishu', 'http']) {
    channels.registerTextReply(ctx, {
      channel,
      sendDirectText: (text, request, targetAddress) => {
        const call = {
          channel: request.channel,
          bot: request.bot,
          account: utils.getStringField(targetAddress, 'appId'),
          chat: utils.getStringField(targetAddress, 'chatId'),
          reminder: utils.getStringField(targetAddress, 'reminder'),
          text,
        };
        calls.push(call);
        return answer();
      },
    });
  }
}

class Clock implements reminderModule.Clock {
  private task?: { time: number; invoke: () => void };

  constructor(private at = NOW) {}

  now(): number {
    return this.at;
  }

  wait(delay: number, invoke: () => void): () => void {
    const task = { time: this.at + delay, invoke };
    this.task = task;
    return () => {
      if (this.task === task) {
        this.task = undefined;
      }
    };
  }

  async advance(at: number): Promise<void> {
    this.at = at;
    const task = this.task;
    if (task !== undefined && task.time <= at) {
      this.task = undefined;
      task.invoke();
    }
    //M 请求回执可以另行安排下一次唤醒。推进时间后让已发出的事件先完成。
    await Bun.sleep(0);
  }
}

function session(options: Partial<SourceSnapshot> = {}): Session {
  const snapshot = {
    channel: 'feishu', accountId: '合成账号', chatId: '合成群', chatType: 'group',
    senderId: '访客甲', role: 'guest', replyRoundKey: '合成轮次', ...options,
  };
  const row = { bot: '合成助手', id: '合成会话', activeSourceSnapshot: snapshot };
  return { row } as unknown as Session;
}

function setup() {
  const db = new sqlite.Database(':memory:');
  const ctx = new cordis.Context();
  cleanups.push(() => db.close(), async () => { await ctx.fiber.dispose(); });
  const tools = new Map<string, ToolSpec>();
  ctx.provide('resources', { db });
  ctx.provide('tools', { register: (spec: ToolSpec) => tools.set(spec.definition.name, spec) });
  const clock = new Clock();
  const sent: reminderModule.Delivery[] = [];
  const cards: approval.Pending[] = [];
  const decide = (card: approval.Pending, approved: boolean): void => {
    card.state = 'rejected';
    if (approved) {
      card.state = 'approved';
    }
    ctx.emit('approval/decided', card);
  };
  events.onRequestEvent(ctx, 'approval/request', 'approval/result', (request) => {
    if (request.action === 'ask') {
      const pending = { ...request.input, id: cards.length + 1, state: 'waiting' } as approval.Pending;
      cards.push(pending);
      return { pending };
    }
    if (request.action === 'reminder-card') {
      const pending = cards.find((card) => {
        const payload = card.payload as { reminderId: number };
        return card.bot === request.bot && payload.reminderId === request.reminderId;
      });
      return { pending };
    }
    if (request.action === 'close') {
      const pending = cards.find((card) => card.id === request.id);
      if (pending !== undefined) {
        decide(pending, false);
      }
    }
    return {};
  });
  function make() {
    const config = { time_zone: ZONE };
    const reminders = new reminderModule.Reminders(ctx, config, clock);
    cleanups.push(() => reminders.stop());
    return reminders;
  }
  const deliver = async (message: reminderModule.Delivery): Promise<ProviderReceipt> => {
    sent.push(message);
    return { status: 'sent' };
  };
  async function call(name: string, args: Record<string, unknown>, source = session(), callId = '工具调用') {
    const tool = tools.get(name)!;
    const signal = new AbortController().signal;
    return await tool.run(args, source, signal, callId) as string;
  }
  return { ctx, make, sent, call, clock, deliver, cards, decide };
}

test('按配置解析早上时间，夏令时跳时拒绝，重复时刻取最早', () => {
  const time = new timeModule.ReminderTime({ time_zone: ZONE, morning: '08:45' });
  expect(time.parse('2026-11-21')).toBe(Date.parse('2026-11-21T13:45:00Z'));
  expect(time.parse('2026-11-01 01:15')).toBe(Date.parse('2026-11-01T05:15:00Z'));
  expect(() => time.parse('2026-03-08 02:30')).toThrow('没有这个时刻');
  expect(() => time.parse('2026-02-30')).toThrow('提醒日期无效');
  expect(() => new timeModule.ReminderTime({ time_zone: 'Mars/Base' })).toThrow('IANA');
});

test('访客提醒只创建一次确认卡，本人确认后给原聊天发送并写回结果', async () => {
  const world = setup();
  const reminders = world.make();
  reminders.start(world.deliver);
  const args = { at: '2026-11-21', text: CONTENT };
  const guestTools = rules.toolsFor('guest');
  expect(guestTools?.has('remind_add')).toBe(true);
  const added = await world.call('remind_add', args);
  const repeated = await world.call('remind_add', args);
  expect(added).toBe(repeated);
  expect(JSON.parse(added)).toMatchObject({ id: 1, at: '2026-11-21 09:00', state: 'awaiting' });
  expect(world.cards).toHaveLength(1);
  const card = world.cards[0]!;
  const visitor = { customer: '私聊', actor: '访客甲' };
  expect(approval.allowed({ ...card, ...visitor }, visitor, false)).toBe(false);
  await world.clock.advance(SATURDAY);
  expect(world.sent).toEqual([]);
  world.decide(card, true);
  await world.clock.advance(SATURDAY);
  expect(world.sent).toEqual([{
    id: 1, channel: 'feishu', account: '合成账号', chat: '合成群', text: `提醒：${CONTENT}`,
  }]);
  expect(reminders.listForBot('合成助手')).toMatchObject([{ state: 'sent' }]);
});

test('查看和取消受账号、聊天及创建者约束，已取消行不会发送', async () => {
  const world = setup();
  const reminders = world.make();
  reminders.start(world.deliver);
  const args = { at: '2026-11-21', text: CONTENT };
  await world.call('remind_add', args);
  const outside = [
    session({ chatId: '另一个群', role: 'owner' }),
    session({ accountId: '另一个账号', role: 'owner' }),
    session({ senderId: '访客乙' }),
  ];
  for (const source of outside) {
    expect(await world.call('remind_list', {}, source)).toBe('[]');
    expect(await world.call('remind_cancel', { id: 1 }, source)).toContain('没有可取消');
  }
  const missing = { row: { bot: '合成助手', address: { channel: 'feishu', chatId: '合成群' } } } as unknown as Session;
  await expect(world.call('remind_add', args, missing)).rejects.toThrow('本轮可信聊天来源');

  const owner = session({ role: 'owner', senderId: '本人' });
  expect(await world.call('remind_cancel', { id: 1 }, owner)).toBe('已取消该提醒');
  await world.clock.advance(SATURDAY);
  expect(world.sent).toEqual([]);
  expect(reminders.listForBot('合成助手')).toMatchObject([{ state: 'cancelled' }]);
});

test('重启后错过的待发提醒只补发一次，并标明原定时刻', async () => {
  const world = setup();
  const original = world.make();
  original.start(world.deliver);
  const args = { at: '2026-11-21', text: CONTENT };
  const direct = session({ chatType: 'p2p', chatId: '合成私聊', role: 'owner' });
  await world.call('remind_add', args, direct);
  original.stop();
  const restartAt = SATURDAY + 3_600_000;
  await world.clock.advance(restartAt);

  const restarted = world.make();
  restarted.start(world.deliver);
  await world.clock.advance(restartAt);
  expect(world.sent).toHaveLength(1);
  expect(world.sent[0]).toMatchObject({
    chat: '合成私聊', text: `补发提醒（原定 2026-11-21 09:00 ${ZONE}）：${CONTENT}`,
  });
  restarted.stop();
  const again = world.make();
  again.start(world.deliver);
  await world.clock.advance(restartAt + 1000);
  expect(world.sent).toHaveLength(1);
  expect(again.listForBot('合成助手')).toMatchObject([{ state: 'sent' }]);
});

test.each(['未交接', '已发', '在途'])('重启按原提醒号和正文查发件账：%s', async (phase) => {
  const world = setup();
  const original = world.make();
  const calls: SentCall[] = [];
  const sent: ProviderReceipt = { status: 'sent' };
  const originalReceipt = Promise.withResolvers<ProviderReceipt>();
  const channelReceipt = Promise.withResolvers<ProviderReceipt>();
  new outbound.Outbound(world.ctx);

  //M 只用合成渠道。悬住“在途”回执以保留发件账已经占位的状态。
  mountChannels(world.ctx, calls, async () => {
    if (phase === '在途') {
      await channelReceipt.promise;
    }
    return { status: 'sent' };
  });

  const send = async (message: reminderModule.Delivery): Promise<ProviderReceipt> => {
    const payload = { reminderId: message.id };
    const options = {
      timeoutMs: 1000,
      onFallback: () => ({ requestId: '', receipt: { status: 'failed', reason: '未获模拟回执' } as ProviderReceipt }),
    };
    const result = await events.requestEvent(world.ctx, 'approval/reminder-send', 'approval/reminder-sent', payload, options);
    return result.receipt;
  };

  //M 中断上次 assist 对回执的保存，留下三种可能的发件账状态。
  original.start(async (message) => {
    if (phase !== '未交接') {
      await send(message);
    }
    return originalReceipt.promise;
  });
  const args = { at: '2026-11-21', text: CONTENT };
  const owner = session({ chatType: 'p2p', role: 'owner' });
  await world.call('remind_add', args, owner);
  await world.clock.advance(SATURDAY);
  expect(original.listForBot('合成助手')).toMatchObject([{ state: 'sending' }]);
  original.stop();

  //M 重启时已过原定时刻，仍应保留首次冻结的正文并复用同一发送号。
  const restarted = world.make();
  const restartAt = SATURDAY + 1000;
  await world.clock.advance(restartAt);
  restarted.start(send);
  await world.clock.advance(restartAt);

  try {
    let expected: ProviderReceipt['status'] = 'sent';
    if (phase === '在途') {
      expected = 'uncertain';
    }
    expect(calls).toMatchObject([{ text: `提醒：${CONTENT}` }]);
    expect(restarted.listForBot('合成助手')).toMatchObject([{ state: expected }]);
  } finally {
    //M 模拟请求都等完后再清理数据库和事件监听。
    channelReceipt.resolve(sent);
    originalReceipt.resolve(sent);
    await world.clock.advance(restartAt);
  }
  expect(calls).toHaveLength(1);
});

test('重启后读回已持久确认的卡片，并补发原定时间已过的提醒', async () => {
  const world = setup();
  const original = world.make();
  original.start(world.deliver);
  const args = { at: '2026-11-21', text: CONTENT };
  await world.call('remind_add', args);
  original.stop();

  //M 模拟确认已落库但上个进程没接到决定通知。
  world.cards[0]!.state = 'approved';
  const restartAt = SATURDAY + 1000;
  await world.clock.advance(restartAt);
  const restarted = world.make();
  restarted.start(world.deliver);
  await world.clock.advance(restartAt);
  await world.clock.advance(restartAt);
  expect(world.cards).toHaveLength(1);
  expect(world.sent).toMatchObject([{ chat: '合成群', text: `补发提醒（原定 2026-11-21 09:00 ${ZONE}）：${CONTENT}` }]);
  expect(restarted.listForBot('合成助手')).toMatchObject([{ state: 'sent' }]);
});

test.each(['feishu', 'http'])('%s 定时发送只凭提醒记录号，经 Outbound 照批准的确切地址发 channel/reply', async (channel) => {
  const world = setup();
  const reminders = world.make();
  const calls: SentCall[] = [];
  new outbound.Outbound(world.ctx);
  mountChannels(world.ctx, calls, () => ({ status: 'sent' }));
  const send = (reminderId: number) => {
    const payload = { reminderId };
    const options = {
      timeoutMs: 100,
      onFallback: () => ({ requestId: '', receipt: { status: 'failed', reason: '未获模拟回执' } as ProviderReceipt }),
    };
    return events.requestEvent(world.ctx, 'approval/reminder-send', 'approval/reminder-sent', payload, options);
  };
  reminders.start(async (message) => {
    const result = await send(message.id);
    return result.receipt;
  });
  const args = { at: '2026-11-21', text: CONTENT };
  let owner = session({ chatType: 'p2p', role: 'owner' });
  if (channel === 'http') {
    const source = {
      channel, accountId: 'local', chatId: 'http:本机', chatType: 'local' as const, role: 'owner' as const,
    };
    const gateway = session({ ...source, origin: { channel, address: {} } });
    await expect(world.call('remind_add', args, gateway)).rejects.toThrow('本轮可信聊天来源');
    owner = session({ ...source, origin: { channel, address: { verifiedOwner: true } } });
  }
  await world.call('remind_add', args, owner);
  expect((await send(1)).receipt.status).toBe('failed');
  expect(calls).toEqual([]);
  await world.clock.advance(SATURDAY);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ channel, text: `提醒：${CONTENT}` });
  if (channel === 'feishu') {
    expect(calls[0]).toMatchObject({ account: '合成账号', chat: '合成群' });
  }
  //M 网页提醒的地址只带意图号，网页按它写一条系统提示；机器人是原提醒的。
  if (channel === 'http') {
    expect(calls[0]?.reminder).not.toBe('');
    expect(calls[0]).toMatchObject({ bot: '合成助手' });
  }
  expect(reminders.listForBot('合成助手')).toMatchObject([{ state: 'sent' }]);
  expect((await send(1)).receipt.status).toBe('failed');
  expect(calls).toHaveLength(1);
});
