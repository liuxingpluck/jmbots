/** 用合成草稿和内存账验证本人审批、持久幂等和未知投递。 */
import * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import { afterEach, expect, test } from 'bun:test';
import type { ChannelRepliedEvent } from '../../Channels.ts';
import * as events from '../../utils/RequestEvent.ts';
import type { ApprovedCall, ProgramDraft, ProviderReceipt } from '../programs/ChannelSend.ts';
import * as outbound from './Outbound.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 场景只在主站事件和内存 SQLite 之间流转，程序和飞书都用内存替身。 */
function getWorld() {
  const ctx = new cordis.Context();
  const db = new sqlite.Database(':memory:');
  cleanups.push(() => db.close(), async () => { await ctx.fiber.dispose(); });
  ctx.provide('resources', { db });
  const notices: string[] = [];
  const owner = { openId: 'owner-fixture', chatId: 'owner-chat', chatType: 'p2p' };
  const guest = { openId: 'guest-fixture', chatId: 'guest-chat', chatType: 'p2p' };
  ctx.provide('sessions', { find: () => [{ address: guest }, { address: owner }] });
  ctx.provide('feishu', {
    config: { people: new Map([['owner-fixture', { role: 'owner' }]]) },
    sendText: async (address: { chatId: string }) => { notices.push(address.chatId); },
  });

  const draft: ProgramDraft = {
    draftId: 3, channel: 'wechat', generation: 'gen-a', account: 'account-1', chat: 'chat-1', text: ' 原文\n ',
  };
  const state = { now: 1_000_000, online: true, blocked: false, result: { status: 'sent' } as ProviderReceipt };
  const calls: ApprovedCall[] = [];
  const replies: ChannelRepliedEvent[] = [];
  new outbound.Outbound(ctx, () => state.now);
  ctx.on('channel/replied', (reply) => { replies.push(reply); });
  events.onRequestEvent(ctx, 'programs/channel-send-request', 'programs/channel-send-result', async (request) => {
    if (!state.online) return { code: 503, error: '外部程序未就绪' };

    if (request.action === 'draft') return { draft: { ...draft } };

    if (state.blocked) return { code: 409, error: '出站前外置程序已换代' };

    calls.push(request.call);
    await Bun.sleep(15);
    return { receipt: state.result };
  });

  const request = (action: outbound.OutboundAction, actor = 'owner') => {
    const input = { ...action, program: 'wechat', actor };
    const options = { timeoutMs: 500, onFallback: () => ({ requestId: '', code: 500, error: '测试未回执' }) };
    return events.requestEvent(ctx, 'approval/outbound-request', 'approval/outbound-result', input, options);
  };
  const prepare = async () => {
    const ready = await request({ action: 'prepare', draftId: draft.draftId });
    if (!('intent' in ready)) throw new Error(ready.error);

    return ready.intent;
  };
  const confirm = (intent: Awaited<ReturnType<typeof prepare>>, actor = 'owner') => {
    return request({
      action: 'confirm', intentId: intent.intentId, observedIntentDigest: intent.digest,
      interactionId: 'one-click', decision: 'approve',
    }, actor);
  };
  return { ctx, db, draft, state, calls, notices, replies, request, prepare, confirm };
}

test('共用请求入口只在写操作失去回执时返回结果不确定', async () => {
  const ctx = new cordis.Context();
  cleanups.push(() => ctx.fiber.dispose());
  const missing = { action: 'status', intentId: 'original' } as const;

  //M 没有接单方时返回明确不可用。
  const absent = await outbound.requestOutbound(ctx, 'test', 'owner', missing);
  expect(absent).toMatchObject({ code: 503 });

  //M 模拟接单后失去回执，读取与有副作用的申请分别走原语义。
  ctx.on('approval/outbound-request', (request) => {
    request.handled = true;
    throw new Error('读写中断');
  });
  const status = await outbound.requestOutbound(ctx, 'test', 'owner', missing);
  expect(status).toMatchObject({ code: 503 });
  const write = { action: 'prepare', draftId: 3 } as const;
  const uncertain = await outbound.requestOutbound(ctx, 'test', 'owner', write);
  expect(uncertain).toMatchObject({ code: 504, error: expect.stringContaining('结果不确定') });
});

test('guest 即使提供本人意图和同一个动作号也不能自批', async () => {
  const world = getWorld();
  const intent = await world.prepare();
  expect(intent.text).toBe(' 原文\n ');
  const rejected = await world.confirm(intent, 'guest');
  expect(rejected).toMatchObject({ code: 403 });
  expect(world.calls).toEqual([]);
});

test.each([
  { name: '过期', mode: 'expired', reason: '待确认意图已过期' },
  { name: '程序换代', mode: 'restart', reason: '外部程序已换代' },
  { name: '修改正文', mode: 'edit', reason: '草稿目标或正文已变化' },
])('$name 后旧意图不能发送', async (fixture) => {
  const world = getWorld();
  const intent = await world.prepare();
  if (fixture.mode === 'expired') world.state.now += 600_000;
  if (fixture.mode === 'restart') world.draft.generation = 'gen-b';
  if (fixture.mode === 'edit') world.draft.text = '另一段';

  const result = await world.confirm(intent);
  expect(result).toMatchObject({ code: 409 });
  expect('error' in result && result.error.includes(fixture.reason)).toBe(true);
  expect(world.calls).toEqual([]);

  const fresh = await world.prepare();
  expect(fresh.intentId).not.toBe(intent.intentId);
  const stale = await world.confirm(intent);
  expect(stale).toMatchObject({ code: 409 });
  expect(world.calls).toEqual([]);
});

test('并发重复确认只出站一次，重试保留批准号、正文和原回执', async () => {
  const world = getWorld();
  const intent = await world.prepare();
  const again = await world.prepare();
  expect(again.intentId).toBe(intent.intentId);
  const results = await Promise.all([world.confirm(intent), world.confirm(intent)]);
  expect(results.some((result) => 'intent' in result && result.intent.status === 'sent')).toBe(true);
  expect(world.calls).toHaveLength(1);
  expect(world.calls[0]).toMatchObject({
    requestId: intent.requestId, channel: 'wechat', account: world.draft.account, chat: world.draft.chat,
    text: world.draft.text, approval: { state: 'approved', expiresAt: world.state.now + 600_000 },
  });
  world.state.now += 700_000;
  const repeated = await world.confirm(intent);
  expect(repeated).toMatchObject({ intent: { requestId: intent.requestId, status: 'sent', receipt: { status: 'sent' } } });
  expect(world.calls).toHaveLength(1);
  expect(world.replies).toHaveLength(1);
});

test('不确定永久保留原回执，只提示本人一次且核对后不换号重发', async () => {
  const world = getWorld();
  world.state.result = { status: 'uncertain', reason: '待对账' };
  const intent = await world.prepare();
  const unknown = await world.confirm(intent);
  expect(unknown).toMatchObject({ intent: { status: 'uncertain', receipt: world.state.result } });
  world.draft.generation = 'gen-b';
  const retried = await world.prepare();
  expect(retried.intentId).toBe(intent.intentId);
  const check = { action: 'reconcile', intentId: intent.intentId, outcome: 'not-sent' } as const;
  const checked = await world.request(check);
  expect(checked).toMatchObject({ intent: { status: 'uncertain', checked: 'not-sent' } });
  expect(await world.confirm(intent)).toMatchObject({ intent: { status: 'uncertain', checked: 'not-sent' } });
  expect(world.notices).toEqual(['owner-chat']);
  expect(world.calls).toHaveLength(1);
  expect(world.replies).toHaveLength(1);
});

test('明知在出站前换代的失败可重新准备，旧批准始终作废', async () => {
  const world = getWorld();
  const intent = await world.prepare();
  world.state.blocked = true;
  expect(await world.confirm(intent)).toMatchObject({
    intent: { status: 'failed', receipt: { reason: '出站前外置程序已换代' } },
  });
  expect(world.calls).toEqual([]);

  world.state.blocked = false;
  world.draft.generation = 'gen-b';
  const fresh = await world.prepare();
  expect(fresh.intentId).not.toBe(intent.intentId);
  expect(await world.confirm(intent)).toMatchObject({ intent: { status: 'failed' } });
  expect(await world.confirm(fresh)).toMatchObject({ intent: { status: 'sent' } });
  expect(world.calls.map((call) => call.requestId)).toEqual([fresh.requestId]);
});

test('外置离线不会误报送达，重启恢复在途审批只标记不确定', async () => {
  const world = getWorld();
  const intent = await world.prepare();
  world.state.online = false;
  expect(await world.confirm(intent)).toMatchObject({ code: 503, error: '外部程序未就绪' });
  expect(world.calls).toEqual([]);

  //M 模拟上一进程留下的在途记录，再触发主站启动恢复。
  const sql = "UPDATE approval_outbound SET state = 'sending' WHERE id = ?";
  world.db.query(sql).run(intent.intentId);
  world.ctx.emit('ready', []);
  world.ctx.emit('ready', []);
  const status = await world.request({ action: 'status', intentId: intent.intentId });
  expect(status).toMatchObject({ intent: { status: 'uncertain' } });
  expect(world.calls).toEqual([]);
  expect(world.notices).toEqual(['owner-chat']);
});
