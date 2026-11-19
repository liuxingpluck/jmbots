/**
 * 消息撤回即停（用户 #142）端到端离线验证：
 *   1. 飞书正在跑这一轮时撤回 → 立刻中止模型请求并停跑，不向飞书回发任何话（含“已停止”）；
 *   2. 排队中还没开跑时撤回 → 从队列移除，前一条正常结束后该条绝不运行；
 *   3. 派出的后台（work）跟着停、不回传结果给前台，已经彻底跑完（done）的不管；
 *   4. 群里外人撤回自己的话照样停他那条，但不能停别人的；本人（owner）撤回可停。
 *
 * 跑法：bun test ./src7/plugins/bots/ChannelRecall.test.ts
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
import * as feishuModule from '../feishu/index.ts';
import * as workspacesPlugin from '../workspaces/index.ts';
import * as botsPlugin from './index.ts';


//M 每个测例结束后清理临时目录与插件上下文。
const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假资源服务构造参数。 */
interface FakeResourceOptions {
  /** 临时运行时根目录。 */
  root: string;
  /** 机器人列表。 */
  bots: Array<{ name: string }>;
  /** 飞书应用配置列表。 */
  feishuApps: Array<{ app_id: string; app_secret: string; bot: string }>;
}


/** 测试用假资源服务。 */
class FakeResources extends cordis.Service {
  readonly db = new Database(':memory:');
  readonly raw: Record<string, unknown>;
  readonly root: string;
  readonly config = {
    defaultModel: 'fake/fake',
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
    plugins: [] as Array<{ name: string; config?: unknown }>,
  };

  constructor(ctx: cordis.Context, options: FakeResourceOptions) {
    super(ctx, 'resources');
    this.root = options.root;
    this.raw = {
      bots: options.bots,
      channels: { feishu: options.feishuApps },
    };
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


/** 飞书客户端与测试桩。 */
interface FeishuTestStub {
  /** 记录发出到飞书的纯文字回复。 */
  textCalls: Array<{ chatId: string; text: string; replyToId?: string }>;
  /** 触发飞书入站消息处理。 */
  triggerInbound: (data: unknown) => Promise<void>;
  /** 触发飞书消息撤回处理。 */
  triggerRecall: (data: unknown) => Promise<void>;
}


/** 将飞书客户端接口替换成内存桩，便于控制入站、撤回与观测外发回复。 */
function createFeishuStub(
  feishu: feishuModule.Feishu,
  appId: string,
  options?: { botOpenId?: string },
): FeishuTestStub {
  const inside = feishu as unknown as {
    apps: Map<string, {
      botOpenId?: string;
      client: { im: { v1: Record<string, unknown> } };
    }>;
    chats: Map<string, unknown>;
    inbound: {
      onMessage: (appId: string, data: unknown) => Promise<void>;
      onRecall: (appId: string, data: unknown) => Promise<void>;
    };
  };
  const app = inside.apps.get(appId);
  if (app === undefined) {
    throw new Error(`测试应用不存在：${appId}`);
  }
  app.botOpenId = options?.botOpenId;

  const textCalls: FeishuTestStub['textCalls'] = [];
  let seq = 0;
  const nextId = (): string => {
    seq += 1;
    return `om_out_${String(seq)}`;
  };

  const imV1 = app.client.im.v1 as {
    messageReaction: Record<string, unknown>;
    message: Record<string, unknown>;
  };
  imV1.messageReaction = {
    create: () => Promise.resolve({ code: 0, data: { reaction_id: 'r_1' } }),
    delete: () => Promise.resolve({ code: 0, data: {} }),
  };
  imV1.message = {
    reply: (input: { path: { message_id: string }; data: { content: string } }) => {
      const parsed = JSON.parse(input.data.content) as { text?: string };
      textCalls.push({ chatId: '', text: parsed.text ?? '', replyToId: input.path.message_id });
      return Promise.resolve({ code: 0, data: { message_id: nextId() } });
    },
    create: (input: { data: { receive_id: string; content: string } }) => {
      const parsed = JSON.parse(input.data.content) as { text?: string };
      textCalls.push({ chatId: input.data.receive_id, text: parsed.text ?? '' });
      return Promise.resolve({ code: 0, data: { message_id: nextId() } });
    },
  };

  inside.chats.set('oc_grp_1', {
    name: '撤回测试群',
    members: new Map<string, string>([
      ['ou_owner', '老板'],
      ['ou_guest_a', '外人A'],
      ['ou_guest_b', '外人B'],
    ]),
    at: Date.now(),
  });

  return {
    textCalls,
    triggerInbound: (data: unknown) => inside.inbound.onMessage(appId, data),
    triggerRecall: (data: unknown) => inside.inbound.onRecall(appId, data),
  };
}


/** 等待异步条件成立，最多等 3 秒。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等待超时：条件未在 3 秒内成立');
}


/** 构建等待取消信号才结束的可控挂起模型响应。 */
function waitAbortOrResolve(
  signal: AbortSignal,
  controller: { finish: (answer: piAi.AssistantMessage) => void },
): Promise<piAi.AssistantMessage> {
  return new Promise<piAi.AssistantMessage>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    controller.finish = (answer: piAi.AssistantMessage) => {
      signal.removeEventListener('abort', onAbort);
      resolve(answer);
    };
  });
}


test('1. 正在跑时撤回：立即掐断模型请求并停跑，绝不向飞书回话或发已停止', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-recall-running-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_1111000011110001';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '周小灵' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '周小灵' }],
  });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
  });

  const stub = createFeishuStub(ctx.get('feishu') as feishuModule.Feishu, appId, { botOpenId: 'ou_bot' });
  let chatCalls = 0;
  let activeSignal: AbortSignal | undefined;
  const blocker = { finish: (_ans: piAi.AssistantMessage) => undefined };
  ctx.sessions.chat = (request) => {
    chatCalls += 1;
    activeSignal = request.signal;
    return waitAbortOrResolve(request.signal, blocker);
  };

  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_run_1',
      chat_id: 'oc_p2p_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我写一份长报告' }),
    },
  });

  await waitFor(() => chatCalls === 1 && activeSignal !== undefined);
  await stub.triggerRecall({
    app_id: appId,
    message_id: 'om_run_1',
    chat_id: 'oc_p2p_1',
    recall_type: 'message_owner',
  });

  const front = ctx.sessions.find({ kind: 'front' })[0];
  expect(activeSignal?.aborted).toBe(true);
  expect(front?.state).toBe('stopped');
  expect(front?.reply).toBe('已停止（用户撤回了消息）');

  //M 等过修复轮定时器窗口，确认既不回话也不再跑模型。
  await Bun.sleep(60);
  expect(stub.textCalls).toHaveLength(0);
  expect(chatCalls).toBe(1);
});


test('2. 排队时撤回：从队列移除且绝不开跑，前一条照常回完', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-recall-queued-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_1111000011110002';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '周小灵' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '周小灵' }],
  });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
  });

  const stub = createFeishuStub(ctx.get('feishu') as feishuModule.Feishu, appId, { botOpenId: 'ou_bot' });
  const seenPrompts: string[] = [];
  const blocker = { finish: (_ans: piAi.AssistantMessage) => undefined };
  let turnStep = 0;

  ctx.sessions.chat = (request) => {
    turnStep += 1;
    for (const msg of request.messages) {
      if (msg.role === 'user') {
        seenPrompts.push(piAi.contentText(msg.content));
      }
    }
    if (turnStep === 1) {
      return waitAbortOrResolve(request.signal, blocker);
    }
    return Promise.resolve(piAi.fauxAssistantMessage('收尾'));
  };

  //M 先推入第 1 条让会话处于 running，再推第 2 条进入 resultQueue 排队。
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_q_1',
      chat_id: 'oc_p2p_2',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '第一条任务' }),
    },
  });
  await waitFor(() => turnStep === 1);

  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_q_2',
      chat_id: 'oc_p2p_2',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '第二条排队消息' }),
    },
  });

  const queuedBefore = ctx.sessions.find({ kind: 'front' })[0]?.resultQueue ?? [];
  expect(queuedBefore.some((item) => item.payload.sourceSnapshot?.nativeId === 'om_q_2')).toBe(true);

  //M 撤回还在排队的第 2 条：从队列摘除且第 1 条照常继续运行。
  await stub.triggerRecall({
    app_id: appId,
    message_id: 'om_q_2',
    chat_id: 'oc_p2p_2',
    recall_type: 'message_owner',
  });

  const queuedAfter = ctx.sessions.find({ kind: 'front' })[0]?.resultQueue ?? [];
  expect(queuedAfter.some((item) => item.payload.sourceSnapshot?.nativeId === 'om_q_2')).toBe(false);
  expect(ctx.sessions.find({ kind: 'front' })[0]?.state).toBe('running');

  //M 放行第 1 条让它通过 channel_reply 回复结束，确认第 2 条自始至终未触发模型。
  const replyCall = piAi.fauxToolCall('channel_reply', { text: '第一条处理完' });
  blocker.finish(piAi.fauxAssistantMessage([replyCall], { stopReason: 'toolUse' }));

  await waitFor(() => ctx.sessions.find({ kind: 'front' })[0]?.state === 'done' && stub.textCalls.length === 1);
  await Bun.sleep(60);
  expect(stub.textCalls).toHaveLength(1);
  expect(stub.textCalls[0]?.text).toContain('第一条处理完');
  expect(seenPrompts.some((text) => text.includes('第二条排队消息'))).toBe(false);
});


test('3. 派出的后台跟着停且不回传，已经跑完的不管', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-recall-work-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_1111000011110003';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '周小灵' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '周小灵' }],
  });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
  });

  const stub = createFeishuStub(ctx.get('feishu') as feishuModule.Feishu, appId, { botOpenId: 'ou_bot' });
  let workSignal: AbortSignal | undefined;
  const workBlocker = { finish: (_ans: piAi.AssistantMessage) => undefined };
  let mode: 'stall-work' | 'finish-all' = 'stall-work';

  ctx.sessions.chat = (request) => {
    const row = request.session.row;
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (row.kind === 'front') {
      if (last?.role === 'user') {
        const txt = piAi.contentText(last.content);
        if (txt.includes('交回的结果')) {
          const call = piAi.fauxToolCall('channel_reply', { text: '后台已完成汇报' });
          return Promise.resolve(piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' }));
        }
        const hand = piAi.fauxToolCall('hand_session', { action: 'new', text: '后台长耗时作业' }, { id: 'call_hand_1' });
        const reply = piAi.fauxToolCall('channel_reply', { text: '已派后台去办' }, { id: 'call_reply_1' });
        return Promise.resolve(piAi.fauxAssistantMessage([hand, reply], { stopReason: 'toolUse' }));
      }
      return Promise.resolve(piAi.fauxAssistantMessage('前轮收尾'));
    }

    if (mode === 'stall-work') {
      workSignal = request.signal;
      return waitAbortOrResolve(request.signal, workBlocker);
    }
    return Promise.resolve(piAi.fauxAssistantMessage('后台全部搞定'));
  };

  //M 3a. 派出的后台正在跑时撤回原消息 → 后台立即停跑且绝不把“停下了”结果回传前台或发给用户。
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_work_1',
      chat_id: 'oc_p2p_3',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '派后台跑起来' }),
    },
  });

  await waitFor(() => workSignal !== undefined && ctx.sessions.find({ kind: 'work' })[0]?.state === 'running');
  await waitFor(() => ctx.sessions.find({ kind: 'front' })[0]?.state === 'done');
  expect(stub.textCalls).toHaveLength(1);

  await stub.triggerRecall({
    app_id: appId,
    message_id: 'om_work_1',
    chat_id: 'oc_p2p_3',
    recall_type: 'message_owner',
  });

  const stoppedWork = ctx.sessions.find({ kind: 'work' })[0];
  expect(workSignal?.aborted).toBe(true);
  expect(stoppedWork?.state).toBe('stopped');
  expect(stoppedWork?.frontTask?.paused).toBe(true);

  await Bun.sleep(60);
  expect(stub.textCalls).toHaveLength(1);

  //M 3b. 已经彻底跑完（done）的消息与后台再撤回 → 状态维持 done 不改写。
  mode = 'finish-all';
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_done_1',
      chat_id: 'oc_p2p_4',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '跑完再撤' }),
    },
  });

  await waitFor(() => stub.textCalls.some((item) => item.text.includes('后台已完成汇报')));
  const doneFront = ctx.sessions.find({ kind: 'front' }).find((item) => item.id !== stoppedWork?.frontTask?.front);
  await waitFor(() => doneFront !== undefined && ctx.sessions.open(doneFront.id).row.state === 'done');

  const doneWorks = ctx.sessions.find({ kind: 'work' }).filter((item) => item.id !== stoppedWork?.id);
  expect(doneWorks).toHaveLength(1);
  expect(doneWorks[0]?.state).toBe('done');

  await stub.triggerRecall({
    app_id: appId,
    message_id: 'om_done_1',
    chat_id: 'oc_p2p_4',
    recall_type: 'message_owner',
  });

  await Bun.sleep(50);
  const doneWorkAfter = ctx.sessions.find({ kind: 'work' }).find((item) => item.id === doneWorks[0]?.id);
  const doneFrontAfter = ctx.sessions.find({ kind: 'front' }).find((item) => item.id === doneFront?.id);
  expect(doneWorkAfter?.state).toBe('done');
  expect(doneFrontAfter?.state).toBe('done');
});


test('4. 群聊权限边界：外人撤自己的照样停但不能停别人的，本人（owner）撤回可停', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-recall-group-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_1111000011110004';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '周小灵' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '周小灵' }],
  });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [
      { open_id: 'ou_owner', name: '老板', owner: true },
      { open_id: 'ou_guest_a', name: '外人A', role: 'guest' },
      { open_id: 'ou_guest_b', name: '外人B', role: 'guest' },
    ],
    groups: [{ chat_id: 'oc_grp_1', name: '撤回测试群', listen: 'mention', relay: 'direct', trusted: false }],
  });

  const stub = createFeishuStub(ctx.get('feishu') as feishuModule.Feishu, appId, { botOpenId: 'ou_bot' });
  const blockerFirst = { finish: (_ans: piAi.AssistantMessage) => undefined };
  const blockerThird = { finish: (_ans: piAi.AssistantMessage) => undefined };
  const ranTexts: string[] = [];
  let thirdSignal: AbortSignal | undefined;
  let roundSeq = 0;

  ctx.sessions.chat = (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'user') {
      roundSeq += 1;
      ranTexts.push(piAi.contentText(last.content));
      if (roundSeq === 1) {
        return waitAbortOrResolve(request.signal, blockerFirst);
      }
      if (roundSeq === 2) {
        thirdSignal = request.signal;
        return waitAbortOrResolve(request.signal, blockerThird);
      }
    }
    return Promise.resolve(piAi.fauxAssistantMessage('收尾'));
  };

  //M 群里外人 B 先发一条正在跑；外人 A 和外人 B 各发一条排队在后。
  const mentions = [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '周小灵' }];
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest_b' }, sender_type: 'user' },
    message: {
      message_id: 'om_b_1',
      chat_id: 'oc_grp_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 B的第一条' }),
      mentions,
    },
  });
  await waitFor(() => roundSeq === 1);

  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest_a' }, sender_type: 'user' },
    message: {
      message_id: 'om_a_1',
      chat_id: 'oc_grp_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 A自己的话' }),
      mentions,
    },
  });

  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_guest_b' }, sender_type: 'user' },
    message: {
      message_id: 'om_b_2',
      chat_id: 'oc_grp_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 B的第二条' }),
      mentions,
    },
  });

  //M 管理员代撤（未知是否本人）或外人 A 试图撤回外人 B 的消息 → 一律拒停，B 继续正常运行。
  await stub.triggerRecall({
    app_id: appId,
    message_id: 'om_b_1',
    chat_id: 'oc_grp_1',
    recall_type: 'group_manager',
  });
  await stub.triggerRecall({
    app_id: appId,
    message_id: 'om_b_1',
    chat_id: 'oc_grp_1',
    recall_type: 'message_owner',
    operator_id: { open_id: 'ou_guest_a' },
  });
  expect(ctx.sessions.find({ kind: 'front' })[0]?.state).toBe('running');

  //M 外人 A 撤回自己发的 om_a_1 → 仅从队列移除 A 自己的话，不影响同群里 B 的消息。
  await stub.triggerRecall({
    app_id: appId,
    message_id: 'om_a_1',
    chat_id: 'oc_grp_1',
    recall_type: 'message_owner',
  });

  const queueAfterA = ctx.sessions.find({ kind: 'front' })[0]?.resultQueue ?? [];
  expect(queueAfterA.some((item) => item.payload.sourceSnapshot?.nativeId === 'om_a_1')).toBe(false);
  expect(queueAfterA.some((item) => item.payload.sourceSnapshot?.nativeId === 'om_b_2')).toBe(true);

  //M 放行 B 的第一条，随后自动开跑的是 B 的第二条（跳过已撤回的 A）。
  const replyB1 = piAi.fauxToolCall('channel_reply', { text: '已答B的第一条' });
  blockerFirst.finish(piAi.fauxAssistantMessage([replyB1], { stopReason: 'toolUse' }));
  await waitFor(() => roundSeq === 2 && thirdSignal !== undefined);
  expect(ranTexts.some((text) => text.includes('A自己的话'))).toBe(false);
  expect(ranTexts.some((text) => text.includes('B的第二条'))).toBe(true);

  //M 本人（owner）通过 operator_id 撤停 B 正在跑的 om_b_2 → 允许立即停跑且不外发回话。
  await stub.triggerRecall({
    app_id: appId,
    message_id: 'om_b_2',
    chat_id: 'oc_grp_1',
    recall_type: 'group_owner',
    operator_id: { open_id: 'ou_owner' },
  });

  expect(thirdSignal?.aborted).toBe(true);
  expect(ctx.sessions.find({ kind: 'front' })[0]?.state).toBe('stopped');
  await Bun.sleep(60);
  expect(stub.textCalls).toHaveLength(1);
});
