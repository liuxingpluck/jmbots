/**
 * 前台派后台（Dispatch.ts）：派活 → 后台做完交回前台 → 前台整理后发回原渠道；acceptResult 去重、冲突、回滚；暂停后不交回、append 接着做。
 * 真实 Cordis + 骨架 Sessions、Tools + bots 插件（前台并在里面）；模型是测试里的假回答，库是内存库，数据放临时目录。
 * 跑法：bun test ./src7/plugins/bots
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as botsPlugin from './index.ts';
import * as channels from '../channels/index.ts';
import * as workspacesPlugin from '../workspaces/index.ts';


//M 每个用例收拾自己的插件和临时目录。
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


//M 假资源：内存库、默认模型 fake/fake、一个机器人“助手”；dir 在临时目录里建。
class FakeResources extends cordis.Service {
  readonly db = new Database(':memory:');
  readonly raw = { bots: [{ name: '助手' }] };
  /** ready 生命周期所需的合成插件状态，不读取真实插件运行信息。 */
  readonly pluginStatus = [];
  readonly config = {
    defaultModel: 'fake/fake',
    sessionCacheMax: 500,
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
  };

  constructor(ctx: cordis.Context, readonly root: string) {
    super(ctx, 'resources');
  }

  ensureRuntimeDir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  getModel(): { input: string[] } {
    return { input: ['text'] };
  }
}


/** 渠道 test 发出去的一条：话和给了的 origin。 */
interface Sent {
  reply: string;
  origin: botsPlugin.Origin | undefined;
}


/**
 * 假模型：最后是工具结果就照结果回一句；是交回的结果就回“整理好了”；话写成“调用 工具 {JSON}”就调那个工具；别的回“做完了：话”。
 * @param request 这一步的请求。
 */
function fakeAnswer(request: sessionsModule.ChatRequest): void {
  const last = request.messages.findLast((item) => (item.role as string) !== 'system');
  if (last?.role === 'toolResult') {
    request.answer = piAi.fauxAssistantMessage(`工具说：${piAi.contentText(last.content)}`);
    return;
  }

  let said = '';
  if (last?.role === 'user') {
    said = piAi.contentText(last.content);
  }
  if (said.includes('交回的结果')) {
    request.answer = piAi.fauxAssistantMessage('整理好了：后台做完了');
    return;
  }

  const asked = /^调用\s+(\S+)\s*(\{.*\})$/su.exec(said.trim());
  if (asked !== null) {
    const args = JSON.parse(asked[2] ?? '{}') as Parameters<typeof piAi.fauxToolCall>[1];
    const call = piAi.fauxToolCall(asked[1] ?? '', args);
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
    return;
  }
  request.answer = piAi.fauxAssistantMessage(`做完了：${said}`);
}


/**
 * 挂上骨架和真插件，登记渠道 test（发的话记进 sent，回执 sent）。
 * @returns ctx 和渠道发出去的话。
 */
async function world(): Promise<{ ctx: cordis.Context; sent: Sent[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'front-desk-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources, root);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  ctx.on('session/before-model', fakeAnswer);

  //M 渠道 test：登记渠道名，发到它的话（都经 channel/reply）连同发到的渠道和地址记进 sent。
  const sent: Sent[] = [];
  ctx.bots.channel('test');
  channels.registerTextReply(ctx, {
    channel: 'test',
    sendDirectText: (text, request, targetAddress) => {
      const origin = { channel: request.channel, address: targetAddress };
      sent.push({ reply: text, origin });
    },
  });
  return { ctx, sent };
}


/**
 * 等到条件成立，最多 3 秒。
 * @param check 条件。
 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等了 3 秒条件还不成立');
}


/**
 * 客户 test:u1 的前台和它的后台（只读记录）。
 * @param ctx 挂好的 ctx。
 */
function getRows(ctx: cordis.Context): { front: sessionsModule.SessionMeta | undefined; works: sessionsModule.SessionMeta[] } {
  const front = ctx.sessions.find({ kind: 'front', customer: 'test:u1' })[0];
  const works = ctx.sessions.find({ kind: 'work' });
  return { front, works };
}


test('派活：后台做完结果先回前台，前台整理后发回原渠道，回执记 sent', async () => {
  const { ctx, sent } = await world();
  const address = { customer: 'test:u1' };
  await ctx.bots.receive('test', '助手', '调用 hand_session {"text":"做事"}', address);

  //M 前台先回“已在办”，后台做完交回、前台整理好再发一次。
  await waitFor(() => sent.some((item) => item.reply === '整理好了：后台做完了'));
  const { front, works } = getRows(ctx);
  const work = works[0];
  expect(work?.frontTask?.front).toBe(front?.id);
  expect(work?.quiet).toBe(true);

  //M 交回一次，轮数加一；前台队列里那一项发到了。
  await waitFor(() => ctx.sessions.find({ kind: 'front' })[0]?.resultQueue?.[0]?.stage === 'sent');
  const queue = ctx.sessions.find({ kind: 'front' })[0]?.resultQueue ?? [];
  expect(queue[0]?.key).toBe(`work:${work?.id ?? ''}:1`);
  expect(ctx.sessions.find({ kind: 'work' })[0]?.frontTask?.round).toBe(2);

  //M 后台自己的回话没直接发；结果按派活时的地址发。
  expect(sent.some((item) => item.reply.startsWith('做完了：做事'))).toBe(false);
  const relayed = sent.find((item) => item.reply === '整理好了：后台做完了');
  expect(relayed?.origin?.channel).toBe('test');
  expect(relayed?.origin?.address).toMatchObject(address);
});


test('acceptResult：同键同内容是 duplicate，内容不同报冲突，commitSource 抛错整个回滚', async () => {
  const { ctx, sent } = await world();
  const front = ctx.sessions.create({ kind: 'front', bot: '助手', customer: 'test:u2' });
  ctx.bots.route(front, { channel: 'test', address: { customer: 'test:u2' } });
  const input = {
    key: 'agent:7:result',
    sessionId: front.id,
    source: { type: 'agent' as const, id: '7' },
    payload: { text: '图做好了', files: [] },
  };

  //M commitSource 抛错：错误原样抛出，内存和库里都没排进去。
  expect(() => ctx.frontDesk.acceptResult(input, () => {
    throw new Error('任务表没改成');
  })).toThrow('任务表没改成');
  expect(front.row.resultQueue).toBeUndefined();
  expect(ctx.sessions.find({ kind: 'front' })[0]?.resultQueue).toBeUndefined();

  //M 正常收：排进去，commitSource 调一次。
  let commits = 0;
  const commit = (): void => {
    commits += 1;
  };
  expect(ctx.frontDesk.acceptResult(input, commit).status).toBe('queued');
  expect(commits).toBe(1);

  //M 同键同内容：duplicate，不再调 commitSource；内容不同：冲突。
  expect(ctx.frontDesk.acceptResult(input, commit).status).toBe('duplicate');
  expect(commits).toBe(1);
  const changed = { ...input, payload: { text: '换了内容', files: [] } };
  expect(() => ctx.frontDesk.acceptResult(changed, commit)).toThrow('result_conflict');

  //M 前台空闲：整理后发回 test 渠道。
  await waitFor(() => sent.some((item) => item.reply === '整理好了：后台做完了'));
  await waitFor(() => front.row.resultQueue?.[0]?.stage === 'sent');
});


test('外部助手的回信（来源 relay）进前台：前台看到“外部助手 <名字> 的回信”，不写成外部 AI 任务', async () => {
  const { ctx, sent } = await world();
  const front = ctx.sessions.create({ kind: 'front', bot: '助手', customer: 'test:u3' });
  ctx.bots.route(front, { channel: 'test', address: { customer: 'test:u3' } });

  //M 照 relay 插件的写法：键 relay:<回信号>，来源 relay、id 是助手名。
  const input = {
    key: 'relay:12',
    sessionId: front.id,
    source: { type: 'relay' as const, id: 'Claude' },
    payload: { text: 'Claude 回复（#3）：查到了', files: [] },
  };
  expect(ctx.frontDesk.acceptResult(input, () => undefined).status).toBe('queued');

  //M 前台空闲：下一拍把结果接进对话、跑一轮。接进去的那一句开头写外部助手的回信。
  await waitFor(() => sent.length > 0);
  const texts = front.row.messages.map((message) => piAi.contentText(message.content));
  const said = texts.find((text) => text.includes('结果键 relay:12'));
  expect(said).toBeDefined();
  expect(said!.startsWith('【外部助手 Claude 的回信（结果键 relay:12）')).toBe(true);
  expect(said).toContain('Claude 回复（#3）：查到了');
  expect(said).not.toContain('外部 AI 任务');
});


test('暂停：stop_session 记暂停，外部结果只排着不跑；append 接着做，交回前台', async () => {
  const { ctx, sent } = await world();
  const address = { customer: 'test:u1' };
  await ctx.bots.receive('test', '助手', '调用 hand_session {"text":"做事"}', address);
  await waitFor(() => sent.some((item) => item.reply === '整理好了：后台做完了'));
  const workId = getRows(ctx).works[0]?.id ?? '';

  //M 暂停：没在跑也记下 paused。
  await ctx.bots.receive('test', '助手', `调用 stop_session {"sessionId":"${workId}"}`, address);
  await waitFor(() => ctx.sessions.open(workId).row.frontTask?.paused === true);

  //M 外部结果交给暂停的后台：排着，不跑。
  const external = {
    key: 'agent:9:result',
    sessionId: workId,
    source: { type: 'agent' as const, id: '9' },
    payload: { text: '外部结果', files: [] },
  };
  ctx.frontDesk.acceptResult(external, () => undefined);
  await Bun.sleep(50);
  const work = ctx.sessions.open(workId);
  expect(work.row.resultQueue?.[0]?.stage).toBe('queued');
  expect(work.row.state).toBe('done');

  //M append：取消暂停，接着做；做完交回第 2 轮，再看外部结果、交回第 3 轮。
  const append = JSON.stringify({ action: 'append', sessionId: workId, text: '接着做' });
  await ctx.bots.receive('test', '助手', `调用 hand_session ${append}`, address);
  await waitFor(() => work.row.resultQueue?.[0]?.stage === 'done');
  await waitFor(() => {
    const keys = (getRows(ctx).front?.resultQueue ?? []).filter((item) => item.stage === 'sent').map((item) => item.key);
    return keys.includes(`work:${workId}:2`) && keys.includes(`work:${workId}:3`);
  });
  expect(work.row.frontTask?.paused).toBe(false);
});


/**
 * 创建受管后台离线夹具；前台保持忙碌，只检查持久交回队列，不发真实消息。
 * @returns 骨架、原前台和带合成来源快照的受管后台。
 */
async function managedWorld() {
  //M 复用内存库与假模型，所有文件只写测试临时目录。
  const fixture = await world();
  const ctx = fixture.ctx;
  const frontArgs = { kind: 'front', bot: '助手', quiet: true } as const;
  const front = ctx.sessions.create(frontArgs);
  front.row.state = 'running';
  front.save();
  const origin = { channel: 'test', address: { role: 'owner', owner: true } };
  const snapshot: channels.SourceSnapshot = {
    messageId: 'managed-fixture-message',
    nativeId: null,
    channel: 'test',
    accountId: 'fixture-account',
    chatId: 'fixture-chat',
    chatType: 'p2p',
    senderId: 'fixture-owner',
    role: 'owner',
    targetBots: ['助手'],
    mentions: [],
    origin,
    visibility: { scope: 'fixture', trusted: true, publicSourceIds: [] },
    botName: '助手',
    claimKey: 'fixture-claim',
    replyRoundKey: 'fixture-round',
  };
  const workArgs = {
    kind: 'work',
    bot: '助手',
    quiet: true,
    frontTask: {
      front: front.id,
      round: 1,
      workspace: '.',
      origin,
      deliveryMode: 'channel_tool',
      sourceSnapshot: snapshot,
      paused: false,
    },
  } as const;
  const work = ctx.sessions.create(workArgs);
  work.row.state = 'running';
  work.save();
  return { ctx, front, work };
}


/**
 * 通过真实工具关口交回合成进度或最终结果，不调用任何外部服务。
 * @param fixture 离线受管后台夹具。
 * @param kind 本次回复类型。
 * @param id 合成工具调用号。
 * @returns 工具层的真实成功或失败结果。
 */
async function managedReply(
  fixture: Awaited<ReturnType<typeof managedWorld>>,
  kind: channels.ReplyKind,
  id: string,
) {
  const args = { text: id, kind };
  const call = piAi.fauxToolCall('channel_reply', args);
  call.id = id;
  const signal = new AbortController().signal;
  //M 经过 before-tool，让 ChannelTools 取得真实调用号。
  return fixture.ctx.tools.execute(call, fixture.work, signal);
}


test('受管后台：工具final后普通最终文本只交回一次，下一轮仍可交回', async () => {
  const fixture = await managedWorld();
  const { ctx, front, work } = fixture;
  //M 让真会话循环先调用工具，再生成不同的普通最终文本。
  work.queueUserMessage('调用 channel_reply {"text":"显式最终结果"}');
  await work.run();
  await waitFor(() => work.row.frontTask?.round === 2);
  expect(front.row.resultQueue).toHaveLength(1);
  expect(front.row.resultQueue?.[0]?.key).toBe(`work:${work.id}:1:final`);
  expect(front.row.resultQueue?.[0]?.payload.text).toContain('显式最终结果');
  expect(work.row.frontTask?.finalRound).toBe(1);

  //M 下一轮编号变化，上一轮 final 标记不得吞下一轮的新结果。
  work.queueUserMessage('调用 channel_reply {"text":"下一轮最终结果"}');
  await work.run();
  await waitFor(() => work.row.frontTask?.round === 3);
  expect(front.row.resultQueue).toHaveLength(2);
});


test('受管后台：没有显式final的普通完成自动交回一次', async () => {
  const { front, work } = await managedWorld();
  work.queueUserMessage('合成后台工作');
  await work.run();
  await waitFor(() => work.row.frontTask?.round === 2);
  expect(front.row.resultQueue).toHaveLength(1);
  expect(front.row.resultQueue?.[0]?.key).toBe(`work:${work.id}:1`);
});


test('受管后台：多次progress分别保留，多个final及自动完成合计一次final', async () => {
  const fixture = await managedWorld();
  await managedReply(fixture, 'progress', 'progress-one');
  await managedReply(fixture, 'progress', 'progress-two');
  await managedReply(fixture, 'final', 'final-one');
  await managedReply(fixture, 'final', 'final-repeated');
  fixture.work.queueUserMessage('普通收尾');
  await fixture.work.run();
  await waitFor(() => fixture.work.row.frontTask?.round === 2);
  expect(fixture.front.row.resultQueue).toHaveLength(3);
  const texts = fixture.front.row.resultQueue?.map((item) => item.payload.text);
  expect(texts?.filter((text) => text.includes('progress'))).toHaveLength(2);
  expect(texts?.filter((text) => text.includes('final-one'))).toHaveLength(1);
});


test('受管后台：final入队保存失败完整回滚，同一调用重试成功', async () => {
  const fixture = await managedWorld();
  const originalSave = fixture.work.save.bind(fixture.work);
  let fail = true;
  fixture.work.save = () => {
    if (fail) {
      fail = false;
      throw new Error('合成final保存失败');
    }
    originalSave();
  };
  const failed = await managedReply(fixture, 'final', 'retry-final');
  expect(failed.text).toContain('合成final保存失败');
  expect(fixture.front.row.resultQueue ?? []).toHaveLength(0);
  expect(fixture.work.row.frontTask?.finalRound).toBeUndefined();
  const retried = await managedReply(fixture, 'final', 'retry-final');
  expect(JSON.parse(retried.text).status).toBe('queued');
  expect(fixture.front.row.resultQueue).toHaveLength(1);
  expect(fixture.work.row.frontTask?.finalRound).toBe(1);
});


test('受管后台：重载持久记录后重复final及ready恢复不重复排队', async () => {
  const fixture = await managedWorld();
  await managedReply(fixture, 'final', 'persisted-final');
  const query = fixture.ctx.resources.db.query<{ meta: string; messages: string }, [string]>(
    'SELECT meta, messages FROM sessions WHERE id = ?',
  );
  const saved = query.get(fixture.work.id);
  if (saved === null) {
    throw new Error('合成会话没有落库');
  }

  //M 用落库的元数据和消息重新构造会话，模拟丢失全部进程内标记。
  const row = { ...JSON.parse(saved.meta), messages: JSON.parse(saved.messages) };
  const restored = new sessionsModule.Session(row, fixture.ctx);
  const restoredFixture = { ...fixture, work: restored };
  await managedReply(restoredFixture, 'final', 'after-restart-final');
  expect(fixture.front.row.resultQueue).toHaveLength(1);

  //M 模拟完成已存库但下一拍尚未推进轮号就退出；ready 必须收尾。
  fixture.work.row.state = 'done';
  fixture.work.row.reply = '重启前已完成';
  fixture.work.save();
  const argv: string[] = [];
  //M ready 的生产契约传命令行参数，本测试无启动参数。
  fixture.ctx.emit('ready', argv);
  await waitFor(() => fixture.work.row.frontTask?.round === 2);
  expect(fixture.front.row.resultQueue).toHaveLength(1);
});


test('受管后台：渠道拒收沿原项和原回执保留，普通完成不另排补发', async () => {
  const fixture = await managedWorld();
  await managedReply(fixture, 'final', 'rejected-final');
  const item = fixture.front.row.resultQueue?.[0];
  if (item === undefined) {
    throw new Error('合成最终结果未排队');
  }

  const source = {
    replyRequestKey: 'fixture-rejected-request',
    replyRoundKey: 'fixture-rejected-round',
    replyIndex: 0,
    kind: 'final',
    parts: [{ partId: 'text:0', kind: 'text' }],
  } as const;
  const receipt = channels.getReceipt(source, 'rejected', '合成渠道拒收');
  item.stage = 'rejected';
  item.deliveryReceipt = receipt;
  fixture.front.save();
  fixture.work.queueUserMessage('普通完成不能掩盖原拒收');
  await fixture.work.run();
  await waitFor(() => fixture.work.row.frontTask?.round === 2);
  expect(fixture.front.row.resultQueue).toHaveLength(1);
  expect(item.stage).toBe('rejected');
  expect(item.deliveryReceipt).toBe(receipt);
});



test('受管后台：只有progress仍保留一次自动最终结果', async () => {
  const fixture = await managedWorld();
  await managedReply(fixture, 'progress', 'only-progress-one');
  await managedReply(fixture, 'progress', 'only-progress-two');
  fixture.work.queueUserMessage('现在完成');
  await fixture.work.run();
  await waitFor(() => fixture.work.row.frontTask?.round === 2);
  expect(fixture.front.row.resultQueue).toHaveLength(3);
  expect(fixture.front.row.resultQueue?.[2]?.key).toBe(`work:${fixture.work.id}:1`);
});


test('受管后台：final后的真实失败仍交回，不被成功标记掩盖', async () => {
  const fixture = await managedWorld();
  await managedReply(fixture, 'final', 'before-failure-final');
  fixture.work.row.state = 'failed';
  fixture.work.row.reply = '合成后续模型失败';
  fixture.work.save();
  fixture.ctx.emit('session/change', fixture.work);
  await waitFor(() => fixture.work.row.frontTask?.round === 2);
  expect(fixture.front.row.resultQueue).toHaveLength(2);
  expect(fixture.front.row.resultQueue?.[1]?.payload.text).toContain('合成后续模型失败');
});


test('受管后台：收尾保存失败恢复旧轮号，ready可重试且不重复final', async () => {
  const fixture = await managedWorld();
  await managedReply(fixture, 'final', 'before-round-save-failure');
  const originalSave = fixture.work.save.bind(fixture.work);
  let failures = 0;
  fixture.work.save = () => {
    if (fixture.work.row.frontTask?.round === 2 && failures === 0) {
      failures += 1;
      throw new Error('合成轮号保存失败');
    }
    originalSave();
  };
  fixture.work.queueUserMessage('普通收尾');
  await fixture.work.run();
  await waitFor(() => failures === 1);
  expect(fixture.work.row.frontTask?.round).toBe(1);
  expect(fixture.front.row.resultQueue).toHaveLength(1);
  const argv: string[] = [];
  //M ready 的生产契约传命令行参数，本测试无启动参数。
  fixture.ctx.emit('ready', argv);
  await waitFor(() => fixture.work.row.frontTask?.round === 2);
  expect(fixture.front.row.resultQueue).toHaveLength(1);
});
