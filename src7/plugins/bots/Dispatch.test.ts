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
  readonly config = {
    defaultModel: 'fake/fake',
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
  };

  constructor(ctx: cordis.Context, readonly root: string) {
    super(ctx, 'resources');
  }

  dir(...parts: string[]): string {
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
 * 挂上骨架和真插件，登记渠道 test（发的话记进 sent，回执 accepted）。
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
  ctx.on('session/request', fakeAnswer);

  const sent: Sent[] = [];
  ctx.bots.channel('test', (reply, _session, origin) => {
    sent.push({ reply, origin });
    return { status: 'accepted', reason: '' };
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
