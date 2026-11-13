/**
 * 更新卡片（sessionId 为空字符串）不卡会话，以及机器人循环几处修复的离线测试：
 *   botStatus 不算更新卡片（approvals 0、状态不 waiting）；分派现状里没有它；
 *   只有更新卡片时“不行”“同意”“全部同意”照常分派、不算回答，“同意 号”才决定它；
 *   没有待审核时“不行”“取消”照常分派；
 *   “强制执行 xxx”走 forceDispatch，已有的待审核卡片不被决定。
 * 真的数据库、文件库和待确认登记表，假的模型和渠道；临时运行时 config 里 poll_ms 10、merge_ms 0。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as httpUi from '../src/channels/HttpUi.ts';
import * as dispatchModule from '../src/dispatch/Dispatch.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/** 发出去的一条消息。 */
interface Sent {
  /** 渠道。 */
  channel: string;
  /** 回复地址。 */
  address: Record<string, unknown>;
  /** 文字。 */
  text: string;
}


/** 一套测试用的依赖和记录。 */
interface Harness {
  /** 依赖。 */
  deps: builders.TestDeps;
  /** 数据库。 */
  store: storeModule.Store;
  /** 发出去的消息。 */
  sent: Sent[];
  /** 常规模型每次回的文字，按顺序；不够时回“收到”。 */
  replies: string[];
  /** 常规模型每次收到的第一条用户消息（分派的现状、强制分派的说明）。 */
  prompts: string[];
  /** 常规模型被调了几次。 */
  chats: () => number;
}


/**
 * 一条 Pi 消息里的文字。
 * @param message 消息。
 * @returns 文字。
 */
function textOf(message: piAi.Message): string {
  if (message.role === 'system') {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}


/**
 * 建依赖：一个机器人周小灵，真的数据库、文件库、待确认登记表，假的模型和渠道。
 * @returns 依赖和记录。
 */
async function setup(): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-update-card-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\ndefault_model: magpie/test\nbots:\n  - name: 周小灵\n    language: zh\nengine:\n  poll_ms: 10\n  merge_ms: 0\n');
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot('周小灵');
  /** 数据库。 */
  const store = new storeModule.Store(':memory:');
  /** 发出去的消息。 */
  const sent: Sent[] = [];
  /** 常规模型每次回的文字。 */
  const replies: string[] = [];
  /** 常规模型每次收到的第一条用户消息。 */
  const prompts: string[] = [];
  /** 常规模型被调了几次。 */
  let chats = 0;
  /** 假模型：chat 按 replies 顺序回，decide 一律拒绝（不配决策模型）。 */
  const ai = builders.fakeAi({
    chat: (input) => {
      prompts.push(textOf(input.messages[0] ?? { role: 'user', content: '', timestamp: 0 }));
      /** 这一次回的文字。 */
      const text = replies[chats] ?? '收到';
      chats += 1;
      //M AssistantMessage 的字段照 Pi 的格式给全，MiniLoop 和会话循环都直接用。
      /** 假回复。 */
      const message = { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'magpie', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as piAi.AssistantMessage;
      return Promise.resolve({ message, text, thinking: '', toolCalls: [], ms: 1, request: { model: input.model, thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] } });
    },
    decide: () => Promise.reject(new Error('没有决策模型')),
    hasDecision: () => false,
    listModels: () => [{ id: 'magpie/test', name: 'test', kind: 'chat', contextWindow: 100_000, thinking: ['off'], vision: true, price: { input: 0, output: 0 } }],
  });
  /** 渠道。 */
  const out: depsModule.Outlet = {
    send: (channel, address, text) => {
      sent.push({ channel, address, text });
      return Promise.resolve();
    },
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  return { deps: { resources, files, ai, store, secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out }, store, sent, replies, prompts, chats: () => chats };
}


/**
 * 等到条件成立（最多 5 秒）；等不到就报错，免得后面的断言看不出是超时。
 * @param condition 条件。
 * @param what 在等什么（报错里写）。
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 500; index += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`等不到：${what}`);
}


/**
 * 记一条更新版本的待确认（sessionId 是空字符串，没有会话在等）。
 * @param deps 依赖。
 * @returns 号和等结果的 Promise。
 */
function askUpdate(deps: builders.TestDeps): { id: number; wait: Promise<approvalsModule.ApprovalDecision> } {
  return deps.approvals.ask({ bot: '周小灵', sessionId: '', title: '有新版本', command: '更新到 9.9.9', workDir: '', review: { what: '更新版本', risk: '更新时会断一下', advice: '先不更新也行' } });
}


/**
 * 记一条普通命令的待确认（有会话在等）。
 * @param deps 依赖。
 * @returns 号和等结果的 Promise。
 */
function askCommand(deps: builders.TestDeps): { id: number; wait: Promise<approvalsModule.ApprovalDecision> } {
  return deps.approvals.ask({ bot: '周小灵', sessionId: 's1', command: 'rm -rf dist', workDir: 'F:/w', review: { what: '删目录', risk: '删了', advice: '别删' } });
}


/**
 * 从 HTTP 渠道收一句话。
 * @param deps 依赖。
 * @param text 原话。
 * @returns 新的收件。
 */
function receiveText(deps: builders.TestDeps, text: string): Promise<storeModule.MessageRow> {
  return builders.botLoopOf(deps).receive({ bot: '周小灵', channel: 'http', source: '甲', address: {}, text, images: [] });
}


/**
 * 起机器人循环，等这条消息变成 taken，然后停下。
 * @param harness 依赖和记录。
 * @param id 消息号。
 */
async function startAndWait(harness: Harness, id: number): Promise<void> {
  const stop = builders.botLoopOf(harness.deps).start('周小灵');
  try {
    await until(() => harness.store.getMessage(id)?.status === 'taken', `消息 #${id} 进会话`);
  } finally {
    stop();
  }
}


/** 常规模型回的分派 JSON：新开一个会话。 */
const DISPATCH_NEW = '{"interrupt": [], "workspace": "日常", "session": "new", "title": "别的事", "model": "magpie/test", "reason": "新的事"}';


bunTest.describe('更新卡片不卡会话：状态和分派', () => {
  bunTest.test('botStatus 不算更新卡片：approvals 0，状态 idle', async () => {
    const harness = await setup();
    const update = askUpdate(harness.deps);
    const view = httpUi.botStatus(harness.deps, '周小灵');
    bunTest.expect(view).toEqual({ status: 'idle', running: 0, queued: 0, approvals: 0 });
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([update.id]);
  });

  bunTest.test('分派现状里没有更新卡片：提示词不出现待审核那一段', async () => {
    const harness = await setup();
    const update = askUpdate(harness.deps);
    harness.replies.push(DISPATCH_NEW);
    const row = await receiveText(harness.deps, '别的活');
    const record = await builders.dispatcherOf(harness.deps).dispatch('周小灵', [harness.store.getMessage(row.id)!]);
    bunTest.expect(record.result.by).toBe('llm');
    bunTest.expect(record.llm?.request.input).not.toContain('# 待审核的命令');
    bunTest.expect(record.llm?.request.input).not.toContain('待审核');
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([update.id]);
  });
});


bunTest.describe('只有更新卡片时：打字回答不吞消息', () => {
  bunTest.test('“不行”照常分派，更新卡片不动', async () => {
    const harness = await setup();
    const update = askUpdate(harness.deps);
    harness.replies.push(DISPATCH_NEW);
    const row = await receiveText(harness.deps, '不行');
    await startAndWait(harness, row.id);
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.dispatch).not.toBeNull();
    bunTest.expect(message.sessionId).not.toBeNull();
    bunTest.expect(message.sessionId!.length).toBeGreaterThan(0);
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([update.id]);
    bunTest.expect(harness.chats()).toBeGreaterThan(0);
  });

  bunTest.test('“同意”照常分派，更新卡片不动', async () => {
    const harness = await setup();
    const update = askUpdate(harness.deps);
    harness.replies.push(DISPATCH_NEW);
    const row = await receiveText(harness.deps, '同意');
    await startAndWait(harness, row.id);
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.dispatch).not.toBeNull();
    bunTest.expect(message.sessionId).not.toBeNull();
    bunTest.expect(message.sessionId!.length).toBeGreaterThan(0);
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([update.id]);
    bunTest.expect(harness.chats()).toBeGreaterThan(0);
  });

  bunTest.test('“全部同意”不带上更新卡片，照常分派', async () => {
    const harness = await setup();
    const update = askUpdate(harness.deps);
    harness.replies.push(DISPATCH_NEW);
    const row = await receiveText(harness.deps, '全部同意');
    await startAndWait(harness, row.id);
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.dispatch).not.toBeNull();
    bunTest.expect(message.sessionId).not.toBeNull();
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([update.id]);
    bunTest.expect(harness.chats()).toBeGreaterThan(0);
  });

  bunTest.test('“同意 号”才决定更新卡片：这条不分派、卡片清空、回复已同意', async () => {
    const harness = await setup();
    const update = askUpdate(harness.deps);
    const row = await receiveText(harness.deps, `同意 ${update.id}`);
    await startAndWait(harness, row.id);
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.dispatch).toBeNull();
    bunTest.expect(message.sessionId).toBeNull();
    bunTest.expect(message.replies.map((reply) => reply.text).join('\n')).toContain(`已同意待确认 #${update.id}`);
    bunTest.expect(harness.deps.approvals.list()).toHaveLength(0);
    bunTest.expect(harness.chats()).toBe(0);
  });
});


bunTest.describe('没有待审核时：不行、取消不被吞', () => {
  bunTest.test('“不行”照常分派', async () => {
    const harness = await setup();
    harness.replies.push(DISPATCH_NEW);
    const row = await receiveText(harness.deps, '不行');
    await startAndWait(harness, row.id);
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.dispatch).not.toBeNull();
    bunTest.expect(message.sessionId).not.toBeNull();
    bunTest.expect(harness.deps.approvals.list()).toHaveLength(0);
    bunTest.expect(harness.chats()).toBeGreaterThan(0);
  });

  bunTest.test('“取消”照常分派', async () => {
    const harness = await setup();
    harness.replies.push(DISPATCH_NEW);
    const row = await receiveText(harness.deps, '取消');
    await startAndWait(harness, row.id);
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.dispatch).not.toBeNull();
    bunTest.expect(message.sessionId).not.toBeNull();
    bunTest.expect(harness.deps.approvals.list()).toHaveLength(0);
    bunTest.expect(harness.chats()).toBeGreaterThan(0);
  });
});


bunTest.describe('强制执行', () => {
  bunTest.test('程序通知发送失败不登记成功回复，审批仍已完成', async () => {
    const harness = await setup();
    const pending = askUpdate(harness.deps);
    harness.deps.out.send = () => Promise.reject(new Error('测试发送失败'));
    const row = await receiveText(harness.deps, `同意 ${pending.id}`);
    await startAndWait(harness, row.id);

    const query = {
      type: 'reply.failed',
      limit: 10,
    };
    await until(() => harness.store.listEvents(query).length > 0, '失败事件写入');
    const event = harness.store.listEvents(query)[0]!;
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.replies).toHaveLength(0);
    bunTest.expect(harness.deps.approvals.list()).toHaveLength(0);
    bunTest.expect(event.data.stage).toBe('send');
    bunTest.expect(event.data.error).toContain('测试发送失败');
  });

  bunTest.test('通知已发送但文件镜像失败，保留成功回复并记录失败阶段', async () => {
    const harness = await setup();
    const pending = askUpdate(harness.deps);
    const row = await receiveText(harness.deps, `同意 ${pending.id}`);
    harness.deps.files.writeMessage = () => Promise.reject(new Error('测试镜像失败'));
    await startAndWait(harness, row.id);

    const query = {
      type: 'reply.failed',
      limit: 10,
    };
    await until(() => harness.store.listEvents(query).length > 0, '镜像失败事件写入');
    const event = harness.store.listEvents(query)[0]!;
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(harness.sent).toHaveLength(1);
    bunTest.expect(message.replies).toHaveLength(1);
    bunTest.expect(event.data.stage).toBe('persist');
    bunTest.expect(event.data.error).toContain('测试镜像失败');
  });

  bunTest.test('“强制执行 xxx”走 forceDispatch，已有的待审核卡片不被决定', async () => {
    const harness = await setup();
    const update = askUpdate(harness.deps);
    const command = askCommand(harness.deps);
    //M 强制分派只报告，不做别的事；模型回 session=none。
    harness.replies.push('{"session": "none", "report": "强制分派：已经看清现状"}');
    const row = await receiveText(harness.deps, '强制执行 重跑构建');
    await until(() => {
      const message = harness.store.getMessage(row.id);
      return message?.status === 'taken' && message.replies.length > 0;
    }, '强制执行的消息处理完');
    const message = harness.store.getMessage(row.id)!;
    /** 回复全文。 */
    const reply = message.replies.map((item) => item.text).join('\n');
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(reply).toContain('强制分派：已经看清现状');
    bunTest.expect(reply).toContain(`待审核 1 条：#${command.id}`);
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([update.id, command.id]);
    bunTest.expect(harness.prompts.some((prompt) => prompt.includes('# 这是强制分派'))).toBe(true);
    bunTest.expect(harness.prompts.some((prompt) => prompt.includes('重跑构建'))).toBe(true);
    bunTest.expect(dispatchModule.isForceText('强制执行 重跑构建')).toBe(true);
  });
});
