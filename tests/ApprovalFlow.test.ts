/**
 * 机器人循环的待确认流程（src/bots/BotLoop.ts 5.2、5.7、6.13）的离线测试：
 *   真的数据库、文件库和待确认登记表，假的模型和渠道；临时运行时 config 里 poll_ms 10、merge_ms 0。
 *   打字回答待确认（同意/拒绝、带号、几条时问号、号不存在时照常分派）；分派结论 wait_for 时消息 held、回复在等哪条；
 *   用户决定后 decision.held 记下消息号，releaseMessages 能把它改回 new、再被 takeNewBatch 领走。
 *   不调真模型，不发真消息。
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
  /** 常规模型被调了几次。 */
  chats: () => number;
}


/**
 * 建依赖：一个机器人周小灵，真的数据库、文件库、待确认登记表，假的模型和渠道。
 * @returns 依赖和记录。
 */
async function setup(): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-approval-'));
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
  /** 常规模型被调了几次。 */
  let chats = 0;
  /** 假模型：chat 按 replies 顺序回，decide 一律拒绝（不配决策模型）。 */
  const ai = builders.fakeAi({
    chat: (input) => {
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
  return { deps: { resources, files, ai, store, secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out }, store, sent, replies, chats: () => chats };
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
 * 记一条待确认。
 * @param deps 依赖。
 * @param command 命令。
 * @returns 号和等结果的 Promise。
 */
function ask(deps: builders.TestDeps, command: string): { id: number; wait: Promise<approvalsModule.ApprovalDecision> } {
  return deps.approvals.ask({ bot: '周小灵', sessionId: 's1', command, workDir: 'F:/w', review: { what: '测试命令', risk: '测试风险', advice: '测试建议' } });
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


bunTest.describe('机器人循环：打字回答待确认', () => {
  bunTest.test('有待确认时发“同意”：这条不分派、状态 taken、回复已同意、待确认清空', async () => {
    const harness = await setup();
    const asked = ask(harness.deps, 'rm -rf dist');
    const row = await receiveText(harness.deps, '同意');
    const stop = builders.botLoopOf(harness.deps).start('周小灵');
    try {
      await until(() => {
        const message = harness.store.getMessage(row.id);
        return message?.status === 'taken' && message.replies.length > 0;
      }, '“同意”被处理');
    } finally {
      stop();
    }
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.dispatch).toBeNull();
    bunTest.expect(message.sessionId).toBeNull();
    bunTest.expect(message.replies.map((reply) => reply.text).join('\n')).toContain(`已同意待确认 #${asked.id}`);
    bunTest.expect(harness.deps.approvals.list()).toHaveLength(0);
    bunTest.expect(harness.chats()).toBe(0);
  });

  bunTest.test('有待确认时普通消息照常分派：消息最终 taken、进了会话，待确认还在', async () => {
    const harness = await setup();
    harness.replies.push('{"interrupt": [], "workspace": "日常", "session": "new", "title": "算一下", "model": "magpie/test", "reason": "新的事"}');
    const asked = ask(harness.deps, 'del a');
    const row = await receiveText(harness.deps, '1+1');
    const stop = builders.botLoopOf(harness.deps).start('周小灵');
    try {
      await until(() => harness.store.getMessage(row.id)?.status === 'taken', '普通消息进会话');
    } finally {
      stop();
    }
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.sessionId).not.toBeNull();
    bunTest.expect(message.sessionId!.length).toBeGreaterThan(0);
    bunTest.expect(message.dispatch).not.toBeNull();
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([asked.id]);
  });

  bunTest.test('两条待确认时发“同意”不带号：回复列出来问是哪一条，两条都还在', async () => {
    const harness = await setup();
    const first = ask(harness.deps, 'del a');
    const second = ask(harness.deps, 'del b');
    const row = await receiveText(harness.deps, '同意');
    const stop = builders.botLoopOf(harness.deps).start('周小灵');
    try {
      await until(() => {
        const message = harness.store.getMessage(row.id);
        return message?.status === 'taken' && message.replies.length > 0;
      }, '“同意”被处理');
    } finally {
      stop();
    }
    const message = harness.store.getMessage(row.id)!;
    /** 回复全文。 */
    const reply = message.replies.map((item) => item.text).join('\n');
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(reply).toContain('现在有 2 条待审核，要说是哪一条');
    bunTest.expect(reply).toContain(`#${first.id}`);
    bunTest.expect(reply).toContain(`#${second.id}`);
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([first.id, second.id]);
    bunTest.expect(harness.chats()).toBe(0);
  });

  bunTest.test('只有一个待确认 #x 时发“同意 99”：号不存在，不算回答，照常分派，待确认还在', async () => {
    const harness = await setup();
    harness.replies.push('{"interrupt": [], "workspace": "日常", "session": "new", "title": "别的事", "model": "magpie/test", "reason": "新的事"}');
    const asked = ask(harness.deps, 'del a');
    const row = await receiveText(harness.deps, '同意 99');
    const stop = builders.botLoopOf(harness.deps).start('周小灵');
    try {
      await until(() => harness.store.getMessage(row.id)?.status === 'taken', '“同意 99”照常分派');
    } finally {
      stop();
    }
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(message.sessionId).not.toBeNull();
    bunTest.expect(message.sessionId!.length).toBeGreaterThan(0);
    bunTest.expect(message.dispatch).not.toBeNull();
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([asked.id]);
  });
});


bunTest.describe('机器人循环：wait_for 挂起（holdForApproval）', () => {  bunTest.test('分派结论等某条待确认：消息 held、回复在等哪条；决定后 decision.held 记下消息号，释放后回 new 能再领到', async () => {
    const harness = await setup();
    const asked = ask(harness.deps, 'bun run build');
    const row = await receiveText(harness.deps, '等审核好了再继续');
    //M 分派结论：wait_for 指向这条待确认；fake 在拿到号以后再排回复，按次数取。
    harness.replies.push(`{"interrupt": [], "workspace": "日常", "session": "new", "title": "等审核", "model": "magpie/test", "wait_for": ${asked.id}, "reason": "等审核"}`);
    const stop = builders.botLoopOf(harness.deps).start('周小灵');
    try {
      await until(() => {
        const message = harness.store.getMessage(row.id);
        return message?.status === 'held' && message.replies.length > 0;
      }, '消息变成 held');
    } finally {
      stop();
    }
    const message = harness.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('held');
    bunTest.expect(message.sessionId).toBeNull();
    /** 分派记录。 */
    const record = message.dispatch as { result: { waitFor?: number } };
    bunTest.expect(record.result.waitFor).toBe(asked.id);
    bunTest.expect(message.replies.map((reply) => reply.text).join('\n')).toContain(`这条先不做：它要等待审核 #${asked.id}`);
    bunTest.expect(harness.deps.approvals.list().map((item) => item.id)).toEqual([asked.id]);

    //M 用户同意这条待确认：decision.held 里应有刚才那条消息的号。
    harness.deps.approvals.decide(asked.id, true, '测试');
    const decision = await asked.wait;
    bunTest.expect(decision.held).toContain(row.id);
    //M 这条消息不是 AgentLoop 里 exec 挂起的那条；真实链路里由 AgentLoop.afterDecision 调 releaseMessages(decision.held)。
    //M 测试里没有 exec 挂起的会话，就手动模拟这一步，只验证 releaseMessages 能把 held 改回 new。
    bunTest.expect(harness.store.getMessage(row.id)?.status).toBe('held');
    harness.store.releaseMessages(decision.held);
    bunTest.expect(harness.store.getMessage(row.id)?.status).toBe('new');
    //M merge_ms=0：释放后马上能再被领走。
    bunTest.expect(harness.store.takeNewBatch('周小灵', 0).map((item) => item.id)).toContain(row.id);
  });
});
