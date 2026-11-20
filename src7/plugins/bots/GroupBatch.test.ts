/** 用虚拟时钟和内存事件总线验证群攒批，决策回执由测试提供。 */
import { afterEach, beforeEach, expect, setSystemTime, test, vi } from 'bun:test';
import * as cordis from 'cordis';
import type { Session, SessionState } from '../../Sessions.ts';
import * as protocol from '../channels/index.ts';
import type * as decision from '../decision/index.ts';
import { DispatchClaim } from './DispatchClaim.ts';
import type { DispatchResults } from './DispatchResults.ts';
import type { FrontDesk } from './FrontDesk.ts';
import * as batches from './GroupBatch.ts';
import type { Bot, ReceiveEvent } from './index.ts';

const CONFIG = { quiet_seconds: 1, max_lines: 3, daily_limit: 0 };
const GROUP = '群一';
const ACCOUNT = '测试应用';
const SENDER = '发送人';
const contexts: cordis.Context[] = [];

beforeEach(() => {
  //M 每例从同一天开始，换天用例自行设定本地时间。
  const today = new Date(2026, 10, 20, 12);
  vi.useFakeTimers({ now: today });
});

afterEach(async () => {
  try {
    //M 让业务插件先清掉自己登记的安静计时器。
    for (const ctx of contexts.splice(0)) {
      await ctx.fiber.dispose();
    }
  } finally {
    vi.useRealTimers();
    setSystemTime();
  }
});

/** 创建有稳定消息号、群范围和说话人名字的一句只听消息。 */
function getHeard(text: string, chatId = GROUP, extra: Record<string, unknown> = {}): batches.Heard {
  const now = Date.now();
  const address = { chatId, senderName: '小明', judge: true, judgeThreshold: 0.8, ...extra };
  const botOrigin = { channel: 'feishu', address };
  const nativeId = `${chatId}-${text}`;
  const messageId = protocol.makeChannelMessageId('feishu', ACCOUNT, nativeId);
  const message: protocol.ChannelMessage = {
    v: 1,
    messageId,
    nativeId,
    channel: 'feishu',
    accountId: ACCOUNT,
    chatId,
    chatType: 'group',
    sender: { id: SENDER, name: '小明' },
    role: 'guest',
    targetBots: ['助手'],
    mentions: [],
    rawText: text,
    text,
    attachments: [],
    createdAt: now,
    receivedAt: now,
    timeSource: 'provider',
    replyTo: null,
    origin: botOrigin,
    visibility: { scope: chatId, trusted: false, publicSourceIds: [] },
    routing: {},
  };
  const claimKey = JSON.stringify([messageId, '助手']);
  return { text, message, botOrigin, claimKey };
}

/** 由指定原发送人申请撤回一条测试消息。 */
function getRecall(heard: batches.Heard, sender = SENDER): protocol.ChannelRecallEvent {
  const { channel, accountId, chatId, messageId } = heard.message;
  return {
    channel, accountId, chatId, messageId,
    recalledAt: Date.now(),
    originalText: heard.text,
    recalledBy: { id: sender, kind: 'sender', isOwner: false },
  };
}

/** 只替换真实的决策模型和前台副作用，保留 Cordis 请求、回执和会话状态事件。 */
function setup(config?: batches.GroupBatchConfig) {
  const ctx = new cordis.Context();
  contexts.push(ctx);
  const fronts = new Map<string, Session>();
  const requests: decision.DecisionJudgeRequest[] = [];
  const queued: { frontId: string; last: batches.Heard; text: string }[] = [];
  const relayed: { frontId: string; last: batches.Heard; text: string; helper: string }[] = [];
  const kept: { frontId: string; text: string }[] = [];
  const outcomes: string[] = [];
  const sessions = {
    open(id: string): Session {
      const session = fronts.get(id);
      if (session === undefined) throw new Error(`测试前台未登记：${id}`);
      return session;
    },
  };
  const desk: Pick<FrontDesk, 'listen'> = {
    listen(front, text) {
      kept.push({ frontId: front.id, text });
    },
  };
  const claims: Pick<DispatchClaim, 'enqueueBatch' | 'relayBatch'> = {
    enqueueBatch(front, last, text) {
      queued.push({ frontId: front.id, last, text });
    },
    relayBatch(front, last, text, helper) {
      relayed.push({ frontId: front.id, last, text, helper });
      return Promise.resolve();
    },
  };

  //M 登记会话替身和公开的判断结果记录，再打开群攒批。
  ctx.provide('sessions', sessions);
  ctx.on('bot/judged', (_address, _text, outcome) => {
    outcomes.push(outcome);
  });
  const batch = new batches.GroupBatch(ctx, desk as FrontDesk, claims as DispatchClaim, config);

  function createFront(id = '前台一', bot = '助手', state: SessionState = 'done'): Session {
    const front = { id, row: { id, bot, kind: 'front', state } } as Session;
    fronts.set(id, front);
    return front;
  }

  function reply(request: decision.DecisionJudgeRequest, verdict: decision.DecisionJudgeResult['verdict']): void {
    const result = { requestId: request.requestId!, verdict, reason: '离线回执', results: [] };
    //M 用相同的请求号交回测试回执。
    ctx.emit('decision/judge-result', result);
  }

  function attachDecision(verdict?: decision.DecisionJudgeResult['verdict']): void {
    ctx.on('decision/judge', (request) => {
      request.handled = true;
      requests.push(request);
      if (verdict === undefined) return;

      //M 默认可立刻回执，省略结论时由测试控制响应或超时。
      reply(request, verdict);
    });
  }

  function nextOutcome(): Promise<void> {
    const seen = Promise.withResolvers<void>();
    ctx.once('bot/judged', () => { seen.resolve(); });
    return seen.promise;
  }

  return { ctx, batch, createFront, attachDecision, reply, nextOutcome, requests, kept, queued, relayed, outcomes };
}

test('安静从最后一句开始计时，到边界只判断一次', async () => {
  const world = setup(CONFIG);
  const front = world.createFront();
  world.attachDecision('allow');
  const first = getHeard('第一句');
  const last = getHeard('第二句');

  //M 第二句打断第一句的安静期。
  world.batch.add(front, first);
  vi.advanceTimersByTime(999);
  expect(world.requests).toHaveLength(0);
  world.batch.add(front, last);
  vi.advanceTimersByTime(999);
  expect(world.requests).toHaveLength(0);

  const judged = world.nextOutcome();
  vi.advanceTimersByTime(1);
  await judged;
  expect(world.requests).toMatchObject([{
    kind: 'group-batch', bot: '助手', allowAt: 0.8,
    state: { 这一批群聊: ['小明：第一句', '小明：第二句'] },
  }]);
  expect(world.queued).toEqual([{ frontId: front.id, last, text: '小明：第一句\n小明：第二句' }]);
  expect(world.kept).toEqual([]);
  vi.advanceTimersByTime(1000);
  expect(world.outcomes).toEqual(['judge:回']);
});

test('攒满行数立即判断，同一天上限为零时可连续看', async () => {
  const config = { ...CONFIG, max_lines: 2 };
  const world = setup(config);
  const front = world.createFront();
  world.attachDecision('deny');
  for (const text of ['第一批', '第二批', '第三批']) {
    //M 每一批在同一个时刻加够两句，无需前推安静计时器。
    const early = getHeard(text + '开头');
    const last = getHeard(text + '结尾');
    world.batch.add(front, early);
    const judged = world.nextOutcome();
    world.batch.add(front, last);
    await judged;
  }

  expect(world.requests).toHaveLength(3);
  expect(world.outcomes).toEqual(['judge:不回', 'judge:不回', 'judge:不回']);
  expect(world.kept).toHaveLength(6);
  expect(world.queued).toEqual([]);
  vi.advanceTimersByTime(1000);
  expect(world.requests).toHaveLength(3);
});

test('每日每群额度由同群的机器人共用，其他群独立，本地换天清零', async () => {
  const config = { ...CONFIG, max_lines: 1, daily_limit: 1 };
  const world = setup(config);
  const first = world.createFront();
  const second = world.createFront('同群前台', '另一个助手');
  const other = world.createFront('另一群前台');
  world.attachDecision('deny');
  const localMidnight = new Date(2026, 10, 21, 0);
  setSystemTime(localMidnight.getTime() - 1);
  const look = async (front: Session, heard: batches.Heard) => {
    const judged = world.nextOutcome();
    world.batch.add(front, heard);
    await judged;
  };

  //M 同群的第二次触发直接记背景，另一群仍会提问。
  await look(first, getHeard('首问'));
  await look(second, getHeard('同群再问'));
  expect(world.requests).toHaveLength(1);
  expect(world.outcomes[1]).toBe('judge:不看(今天看满 1 次)');
  expect(world.kept).toContainEqual({ frontId: second.id, text: '同群再问' });
  await look(other, getHeard('另一群首问', '群二'));
  expect(world.requests).toHaveLength(2);

  setSystemTime(localMidnight);
  await look(second, getHeard('换天再问'));
  expect(world.requests).toHaveLength(3);
  expect(world.outcomes.at(-1)).toBe('judge:不回');
});

test('到点时前台在转，收到该会话停止的 session/change 才判断', async () => {
  const world = setup(CONFIG);
  const front = world.createFront('工作前台', '助手', 'running');
  const other = world.createFront('其他前台');
  world.attachDecision('deny');
  const heard = getHeard('等会儿再看');
  world.batch.add(front, heard);
  vi.advanceTimersByTime(1000);
  world.ctx.emit('session/change', other);
  world.ctx.emit('session/change', front);
  expect(world.requests).toHaveLength(0);

  const judged = world.nextOutcome();
  front.row.state = 'stopped';
  world.ctx.emit('session/change', front);
  await judged;
  expect(world.requests).toHaveLength(1);
  expect(world.kept).toEqual([{ frontId: front.id, text: heard.text }]);
});

test('被叫到时取走缓冲的上下文，原安静计时器取消', () => {
  const world = setup(CONFIG);
  const front = world.createFront();
  world.attachDecision('allow');
  world.batch.add(front, getHeard('第一句'));
  world.batch.add(front, getHeard('第二句'));

  expect(world.batch.take(front.id)).toEqual(['小明：第一句', '小明：第二句']);
  expect(world.batch.take(front.id)).toEqual([]);
  vi.advanceTimersByTime(1000);
  expect(world.requests).toEqual([]);
});

test('判断中被叫到带上仍有效的原批和新缓冲，迟到的接话回执不补队列', async () => {
  const config = { ...CONFIG, max_lines: 2 };
  const world = setup(config);
  const front = world.createFront();
  world.attachDecision();
  const removed = getHeard('先听见再撤回');
  world.batch.add(front, removed);
  world.batch.add(front, getHeard('已经开始判断'));
  world.batch.add(front, getHeard('又来一句'));
  world.batch.add(front, getHeard('第二批开始判断'));
  expect(world.requests).toHaveLength(2);
  world.batch.add(front, getHeard('判断时新来'));
  world.batch.cancelRecall(getRecall(removed));

  //M 叫到机器人的这一轮需要完整上下文，迟到的判定每批只写一条流水。
  const lines = world.batch.take(front.id);
  for (const request of world.requests) {
    const judged = world.nextOutcome();
    world.reply(request, 'allow');
    await judged;
  }
  vi.advanceTimersByTime(1000);

  expect(lines).toEqual([
    '小明：已经开始判断',
    '小明：又来一句', '小明：第二批开始判断', '小明：判断时新来',
  ]);
  expect(world.requests).toHaveLength(2);
  expect(world.queued).toEqual([]);
  expect(world.kept).toEqual([]);
  expect(world.outcomes).toEqual(['judge:回', 'judge:回']);
});

test('原发送人撤回缓冲里的话，只保留仍有效的消息', () => {
  const world = setup(CONFIG);
  const front = world.createFront();
  world.attachDecision('allow');
  const removed = getHeard('撤回我');
  const kept = getHeard('留着我');
  world.batch.add(front, removed);
  world.batch.add(front, kept);
  //M 先验证其他发送人不能删这句，再用原发送人的撤回验证删除。
  world.batch.cancelRecall(getRecall(removed, '别人'));
  expect(world.batch.take(front.id)).toEqual(['小明：撤回我', '小明：留着我']);
  world.batch.add(front, removed);
  world.batch.add(front, kept);
  world.batch.cancelRecall(getRecall(removed));
  expect(world.batch.take(front.id)).toEqual(['小明：留着我']);
});

test('等回执时撤回最后一句，接话用仍有效的正文和来源', async () => {
  const config = { ...CONFIG, max_lines: 2 };
  const world = setup(config);
  const front = world.createFront();
  world.attachDecision();
  const first = getHeard('仍然有效');
  const last = getHeard('判断期间已撤回');
  world.batch.add(front, first);
  world.batch.add(front, last);

  //M 决策已看到原批次，排队以当前仍有效的消息为准。
  const recall = getRecall(last);
  world.batch.cancelRecall(recall);
  const judged = world.nextOutcome();
  world.reply(world.requests[0]!, 'allow');
  await judged;
  expect(world.queued).toEqual([{ frontId: front.id, last: first, text: '小明：仍然有效' }]);
});

test('无人接决策请求时立即按不接处理', async () => {
  const config = { ...CONFIG, max_lines: 1 };
  const world = setup(config);
  const front = world.createFront();
  const heard = getHeard('无人判断');
  const judged = world.nextOutcome();
  world.batch.add(front, heard);
  await judged;
  expect(world.outcomes).toEqual(['judge:不回(没有决策模型)']);
  expect(world.kept).toEqual([{ frontId: front.id, text: heard.text }]);
  expect(world.queued).toEqual([]);
});

test('决策接单后出错按不接处理，不掐表', async () => {
  const config = { ...CONFIG, max_lines: 1 };
  const world = setup(config);
  const front = world.createFront();
  //M 决策接了单却抛错：不等时钟，直接按不接。
  world.ctx.on('decision/judge', (request) => {
    request.handled = true;
    throw new Error('模型挂了');
  });
  const heard = getHeard('判断出错');
  const judged = world.nextOutcome();
  world.batch.add(front, heard);
  await judged;
  expect(world.outcomes).toEqual(['judge:不回(决策模型出错)']);
  expect(world.kept).toEqual([{ frontId: front.id, text: heard.text }]);
  expect(world.queued).toEqual([]);
});

test('入口缺键不开攒批，三种数值写错都报出键名', () => {
  const missing = { quiet_seconds: 1, max_lines: 3 };
  expect(batches.readGroupBatch(undefined)).toContain('没写 group_batch');
  expect(batches.readGroupBatch(missing)).toBe('group_batch 缺 daily_limit');
  expect(batches.readGroupBatch(CONFIG)).toEqual(CONFIG);
  expect(() => batches.readGroupBatch([])).toThrow('要写成一节');
  expect(() => batches.readGroupBatch({ ...CONFIG, quiet_seconds: '1' })).toThrow('quiet_seconds');
  expect(() => batches.readGroupBatch({ ...CONFIG, max_lines: 1.5 })).toThrow('max_lines');
  expect(() => batches.readGroupBatch({ ...CONFIG, daily_limit: -1 })).toThrow('daily_limit');

  //M apply 只把读到的完整配置交给 GroupBatch，缺键时沿旧路记背景。
  const world = setup();
  const front = world.createFront();
  expect(world.batch.add(front, getHeard('按原方式记背景'))).toBe(false);
  expect(world.batch.take(front.id)).toEqual([]);
});

test('群登记了 judge_helper：判定要接话时这一批记成背景，转给外部助手，不排进前台', async () => {
  const world = setup({ ...CONFIG, max_lines: 2 });
  const front = world.createFront();
  world.attachDecision('allow');
  const first = getHeard('帮忙看看', GROUP, { judgeHelper: 'Claude' });
  const last = getHeard('这个报错', GROUP, { judgeHelper: 'Claude' });

  //M 攒满两句立即判断，判定要接。
  world.batch.add(front, first);
  const judged = world.nextOutcome();
  world.batch.add(front, last);
  await judged;
  await Promise.resolve();

  //M 两句都进了前台背景，这一批转给 Claude，前台没有排队。
  expect(world.kept).toEqual([
    { frontId: front.id, text: '帮忙看看' },
    { frontId: front.id, text: '这个报错' },
  ]);
  expect(world.relayed).toEqual([{ frontId: front.id, last, text: '小明：帮忙看看\n小明：这个报错', helper: 'Claude' }]);
  expect(world.queued).toEqual([]);
});

test('relayBatch 经 bot/receive 发出去：地址去掉 listenOnly、带 relayHelper，认领了就交给那场会话', async () => {
  const ctx = new cordis.Context();
  contexts.push(ctx);
  const delivered: { session: Session; text: string; origin: unknown }[] = [];
  const bot = {
    name: '助手',
    deliver(session: Session, text: string, origin: unknown) {
      delivered.push({ session, text, origin });
    },
  } as unknown as Bot;
  const relaySession = { id: '转话一', row: { id: '转话一', kind: 'relay' } } as Session;
  const received: ReceiveEvent[] = [];
  ctx.provide('bots', { get: (name: string) => (name === bot.name ? bot : undefined) });
  ctx.on('bot/receive', (event) => {
    received.push(event);
    event.session = relaySession;
  });
  const claim = new DispatchClaim(ctx, {} as FrontDesk, {} as DispatchResults, undefined);
  const front = { id: '前台一', row: { id: '前台一', bot: bot.name, kind: 'front' } } as Session;
  const last = getHeard('这个报错', GROUP, { judgeHelper: 'Claude', listenOnly: true });

  await claim.relayBatch(front, last, '小明：这个报错', 'Claude');

  //M 收件地址去掉只听标记、写上转给谁；原句的地址不动。
  const address = received[0]?.message.address as Record<string, unknown>;
  expect(address['relayHelper']).toBe('Claude');
  expect(address['listenOnly']).toBeUndefined();
  expect(last.botOrigin.address['listenOnly']).toBe(true);
  expect(received[0]?.message).toMatchObject({ channel: 'feishu', bot: '助手', text: '小明：这个报错', sourceId: last.message.messageId });

  //M relay 认领了：这一批交给那场会话，回话照这个地址回群里。
  expect(delivered).toEqual([{ session: relaySession, text: '小明：这个报错', origin: { channel: 'feishu', address } }]);
});
