/**
 * bots 改事件第一阶段（11-18，契约 3.2 第 4、7 条）：
 *   1. 请求事件 bot/request 的 hand、save-file、add、accept-result 有人答，回 bot/result；现有方法抛错时回 { ok: false, error }，不等超时；
 *   2. 通知 bot/route 照 Bots.route 改会话的渠道、地址、客户号；
 *   3. 前台派活轮发 model-catalog/request（prompt）：有人答就把两段加进系统提示词，没人答立刻退回、不加。
 * 真实 Cordis + 骨架 Sessions、Tools + workspaces、bots 插件；模型是测试里的假回答，库是内存库，数据放临时目录。
 * 跑法：bun test ./src7/plugins/bots
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as events from '../../utils/RequestEvent.ts';
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


/** 调用方的退回：requestId 写成退回原因，ok: false。 */
const botOptions = {
  timeoutMs: 1000,
  onFallback: (reason: events.FallbackReason) => ({ requestId: reason, ok: false, error: reason }),
};


/**
 * 挂上骨架和真插件，登记渠道 test（发的话记进 sent）；前台每一步的系统提示词记进 systems；假模型回“做完了：话”。
 * @returns ctx、渠道发出去的话、前台每一步的系统提示词。
 */
async function world(): Promise<{ ctx: cordis.Context; sent: string[]; systems: string[][] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-events-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources, root);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});

  //M 排在 bots 后面：先记下前台这一步的系统提示词，再给假回答。
  const systems: string[][] = [];
  ctx.on('session/before-model', (request) => {
    if (request.session.row.kind === 'front') {
      systems.push([...request.system]);
    }
    const last = request.messages.findLast((item) => item.role === 'user');
    let said = '';
    if (last !== undefined) {
      said = piAi.contentText(last.content);
    }
    request.answer = piAi.fauxAssistantMessage(`做完了：${said}`);
  });

  const sent: string[] = [];
  ctx.bots.channel('test', (reply) => {
    sent.push(reply);
    return { status: 'accepted', reason: '' };
  });
  return { ctx, sent, systems };
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


test('缺少 memory 时启动说一次，前台告诉模型读不到历史仍继续应答', async () => {
  const { ctx, sent, systems } = await world();

  //M 模拟启动结束，核对告警出现一次且不影响运行。
  const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    ctx.emit('ready', []);
    ctx.emit('ready', []);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('前台往来不会保存'));
  } finally {
    warning.mockRestore();
  }

  const origin = { customer: 'test:owner', role: 'owner' };
  await ctx.bots.receive('test', '助手', '这轮照常回答', origin);
  await waitFor(() => sent.includes('做完了：这轮照常回答'));
  const system = systems.at(-1) ?? [];
  expect(system.join('\n')).toContain('前台往来暂时读不到');
});


test('bot/request 有人答：hand、save-file、add、accept-result 都回 bot/result', async () => {
  const { ctx, sent } = await world();

  //M hand：新开一场后台，回执带会话号；后台跑完照常回原渠道。
  const hand = { action: 'hand' as const, bot: '助手', text: '查一下', origin: { channel: 'test', address: { customer: 'test:u1' } } };
  const handed = await events.requestEvent(ctx, 'bot/request', 'bot/result', hand, botOptions);
  expect(handed.ok).toBe(true);
  expect(handed.requestId).toStartWith('req_');
  expect(ctx.sessions.open(handed.sessionId ?? '').row.kind).toBe('work');
  await waitFor(() => sent.includes('做完了：查一下'));

  //M save-file：存进机器人工作区的 inbox，回执带绝对路径。
  const data = new TextEncoder().encode('附件内容');
  const save = { action: 'save-file' as const, bot: '助手', name: 'a/b\\说明.txt', data };
  const saved = await events.requestEvent(ctx, 'bot/request', 'bot/result', save, botOptions);
  expect(saved.ok).toBe(true);
  expect(path.basename(saved.path ?? '')).toEndWith('_说明.txt');
  expect(fs.readFileSync(saved.path ?? '', 'utf8')).toBe('附件内容');

  //M add：运行中新建机器人，回执带名字、工作区、记忆目录；马上取得到。
  const add = { action: 'add' as const, config: { name: '新来的', language: 'zh' } };
  const added = await events.requestEvent(ctx, 'bot/request', 'bot/result', add, botOptions);
  expect(added.ok).toBe(true);
  expect(added.bot?.name).toBe('新来的');
  expect(added.bot?.memory).toBe(ctx.bots.get('新来的')?.memory);
  expect(fs.existsSync(added.bot?.workspace ?? '')).toBe(true);

  //M accept-result：排进前台的结果队列，回执带 queued 和结果键；同键同内容再交是 duplicate。
  const front = ctx.sessions.create({ kind: 'front', bot: '助手', customer: 'test:u2' });
  ctx.bots.route(front, { channel: 'test', address: { customer: 'test:u2' } });
  const input = {
    key: 'relay:5',
    sessionId: front.id,
    source: { type: 'relay' as const, id: 'Claude' },
    payload: { text: '查到了', files: [] },
  };
  const accept = { action: 'accept-result' as const, input };
  const accepted = await events.requestEvent(ctx, 'bot/request', 'bot/result', accept, botOptions);
  expect(accepted).toMatchObject({ ok: true, receipt: { status: 'queued', key: 'relay:5' } });
  const again = await events.requestEvent(ctx, 'bot/request', 'bot/result', accept, botOptions);
  expect(again).toMatchObject({ ok: true, receipt: { status: 'duplicate', key: 'relay:5' } });

  //M 前台空闲：下一拍处理这份结果，跑完再收拾。
  await waitFor(() => front.row.resultQueue?.[0]?.stage === 'sent');
});


test('bot/request 出错：没有机器人、会话不在、重名、结果冲突都回 ok: false，不等超时', async () => {
  const { ctx, sent } = await world();
  const origin = { channel: 'test', address: { customer: 'test:u3' } };

  const noBot = await events.requestEvent(ctx, 'bot/request', 'bot/result', { action: 'hand' as const, bot: '没有', text: '查', origin }, botOptions);
  expect(noBot).toMatchObject({ ok: false, error: '没有这个机器人：没有' });
  expect(noBot.requestId).toStartWith('req_');

  //M 会话号不在：sessions.open 抛错，onError 转成 ok: false。
  const noSession = { action: 'hand' as const, bot: '助手', text: '查', origin, sessionId: 'no-such' };
  const missing = await events.requestEvent(ctx, 'bot/request', 'bot/result', noSession, botOptions);
  expect(missing.ok).toBe(false);
  expect(missing.error).toBeString();

  const data = new Uint8Array([1]);
  const saveFail = await events.requestEvent(ctx, 'bot/request', 'bot/result', { action: 'save-file' as const, bot: '没有', name: 'x.txt', data }, botOptions);
  expect(saveFail).toMatchObject({ ok: false, error: '没有这个机器人：没有' });

  const twice = await events.requestEvent(ctx, 'bot/request', 'bot/result', { action: 'add' as const, config: { name: '助手' } }, botOptions);
  expect(twice).toMatchObject({ ok: false, error: '已经有叫 助手 的机器人了' });

  //M 同键内容不同：result_conflict。
  const front = ctx.sessions.create({ kind: 'front', bot: '助手', customer: 'test:u3' });
  ctx.bots.route(front, origin);
  const input = { key: 'agent:1:result', sessionId: front.id, source: { type: 'agent' as const, id: '1' }, payload: { text: '甲', files: [] } };
  const first = await events.requestEvent(ctx, 'bot/request', 'bot/result', { action: 'accept-result' as const, input }, botOptions);
  expect(first.ok).toBe(true);
  const changed = { ...input, payload: { text: '乙', files: [] } };
  const conflict = await events.requestEvent(ctx, 'bot/request', 'bot/result', { action: 'accept-result' as const, input: changed }, botOptions);
  expect(conflict.ok).toBe(false);
  expect(conflict.error).toContain('result_conflict');
  await waitFor(() => front.row.resultQueue?.[0]?.stage === 'sent');
  expect(sent.length).toBeGreaterThan(0);
});


test('没挂 bots：bot/request 立刻走无人接单退路', async () => {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  const add = { action: 'add' as const, config: { name: '甲' } };
  const result = await events.requestEvent(ctx, 'bot/request', 'bot/result', add, botOptions);
  expect(result).toEqual({ requestId: 'unhandled', ok: false, error: 'unhandled', fallback: 'unhandled' });
});


test('bot/route 通知：照 route 改会话的渠道、地址、客户号；不给渠道什么也不改', async () => {
  const { ctx } = await world();
  const session = ctx.sessions.create({ kind: 'work', bot: '助手' });

  ctx.emit('bot/route', { sessionId: session.id, origin: { channel: 'test', address: { customer: 'test:u9' } } });
  expect(session.row.channel).toBe('test');
  expect(session.row.address).toEqual({ customer: 'test:u9' });
  expect(session.row.customer).toBe('test:u9');

  ctx.emit('bot/route', { sessionId: session.id, origin: {} });
  expect(session.row.channel).toBe('test');
});


test('前台派活轮发 model-catalog/request（prompt）：有人答加两段，没人答不加', async () => {
  const { ctx, sent, systems } = await world();

  //M 没挂 model-catalog：立刻退回，只带派活说明。
  await ctx.bots.receive('test', '助手', '你好', { customer: 'test:u5' });
  await waitFor(() => sent.includes('做完了：你好'));
  const plain = systems.at(-1) ?? [];
  expect(plain.every((part) => typeof part === 'string')).toBe(true);
  expect(plain.some((part) => part.startsWith('上面是底座的通用说明'))).toBe(true);
  expect(plain.some((part) => part.startsWith('派活用 hand_session'))).toBe(true);
  expect(plain.some((part) => part.includes('模型介绍X'))).toBe(false);

  //M 假的 model-catalog 回两段：都加进系统提示词，介绍在前、思考档在后。
  events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', (request) => {
    if (request.action === 'prompt') return { prompt: '# 模型介绍X', levelsText: '能用的思考档Y' };

    return {};
  });
  await ctx.bots.receive('test', '助手', '再来', { customer: 'test:u5' });
  await waitFor(() => sent.includes('做完了：再来'));
  const withNotes = systems.at(-1) ?? [];
  const introAt = withNotes.indexOf('# 模型介绍X');
  expect(introAt).toBeGreaterThan(-1);
  expect(withNotes[introAt + 1]).toBe('能用的思考档Y');

  //M 外人（guest）不挑模型：不发请求，不加。
  await ctx.bots.receive('test', '助手', '外人来了', { customer: 'test:u6', role: 'guest' });
  await waitFor(() => sent.includes('做完了：外人来了'));
  const guest = systems.at(-1) ?? [];
  expect(guest.includes('# 模型介绍X')).toBe(false);
});
