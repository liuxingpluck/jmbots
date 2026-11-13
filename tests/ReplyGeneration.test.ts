/**
 * 回复生成与观察轮的离线公共边界：真实循环、工具、消息库与 HTTP inject。
 * 只使用亲自创建的假运行时与假模型，不联网、不读取真实配置或启动浏览器。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import * as eventsModule from '../src/capabilities/Events.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as evidenceModule from '../src/capabilities/ReplyEvidence.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as traceModule from '../src/capabilities/Trace.ts';
import * as httpModule from '../src/channels/Http.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as modelModule from '../src/capabilities/Model.ts';
import type * as httpUiModule from '../src/channels/HttpUi.ts';
import * as builders from './Builders.ts';


/** 假模型本次明确返回的结果，不读取真实模型清单。 */
interface Plan {
  /** 实际成功路由；与会话配置的 fake/configured 故意不同。 */
  model?: string;
  /** 模型文字。 */
  text?: string;
  /** 原来的调用错误。 */
  error?: string;
  /** 请求与本地发送档位，故意可不同。 */
  requested?: string;
  /** 本地归一化后发送档位。 */
  sent?: string;
  /** 供应商报告的输入 token，用于触发原有压缩分支。 */
  tokens?: number;
  /** 模型选择的工具。 */
  tools?: PlanTool[];
  /** 在模型返回前模拟新消息到达；测试实现就在每个用例内。 */
  before?: (harness: Harness) => void | Promise<void>;
}


/** 假模型选择的一个工具与明确参数。 */
interface PlanTool {
  /** 正式 ToolBox 工具名。 */
  name: string;
  /** 测试数据，不含真实凭据。 */
  args: Record<string, unknown>;
}


/** 独占假运行时的少数可变边界。 */
interface HarnessOptions {
  /** 一次运行最多模型步数，用于触发程序上限。 */
  maxRounds?: number;
  /** 假模型上下文窗口，用于触发原有压缩行为。 */
  window?: number;
  /** false 表示空启用名单。 */
  enabled?: boolean;
}


/** 每个测试独占真实文件/库和假模型，避免观察状态跨用例共享。 */
class Harness {
  /** 仅含假配置和本用例生成文件的独占目录。 */
  readonly dir: string;
  /** 真实内存消息与事件库。 */
  readonly store = new storeModule.Store(':memory:');
  /** 构造业务对象的依赖，不存在外部渠道。 */
  readonly deps: builders.TestDeps;
  /** 本测试会话；配置模型不能拿来作为回复模型。 */
  readonly session: storeModule.SessionRow;
  /** 真正发出的文字。 */
  readonly sent: string[] = [];
  /** 每次调用参数；压缩与会话各自有 purpose。 */
  readonly calls: modelModule.ChatInput[] = [];
  /** 发出回复时模拟新消息到达，具体实现由用例定义。 */
  onSend?: (text: string) => void | Promise<void>;

  private constructor(
    dir: string,
    resources: resourcesModule.Resources,
    files: filesModule.Files,
    plans: Plan[],
    window: number,
  ) {
    this.dir = dir;
    this.session = this.store.createSession({
      bot: '小测', workspace: '日常', title: '生成测试', model: 'fake/configured', thinking: 'high',
    });
    const secrets = new secretsModule.Secrets([]);
    const events = new eventsModule.EventBus(this.store, resources, secrets);
    const ai = builders.fakeAi({
      chat: async (input) => {
        this.calls.push(input);
        const plan = plans.shift() ?? { text: '结束' };
        await plan.before?.(this);
        return this.output(input, plan);
      },
      decide: () => Promise.reject(new Error('本用例不调分类模型')),
      hasDecision: () => false,
      listModels: () => [{
        id: 'fake/configured', name: 'fake', kind: 'chat', contextWindow: window,
        thinking: ['off', 'low', 'high'], vision: false, price: { input: 0, output: 0 },
      }],
    });
    this.deps = {
      resources, files, secrets, events, ai, store: this.store,
      approvals: new approvalsModule.Approvals(),
      out: {
        send: async (_channel, _address, text) => {
          this.sent.push(text);
          await this.onSend?.(text);
        },
        sendApproval: () => Promise.resolve([]),
        publishDoc: () => Promise.reject(new Error('离线不用')),
        deleteDoc: () => Promise.reject(new Error('离线不用')),
      },
    };
  }

  /** 创建本测试亲自生成的假配置；enabled=false 只用于停用机器人执行守卫。 */
  static async create(plans: Plan[], options: HarnessOptions = {}): Promise<Harness> {
    const root = process.env.JMBOTS_TEST_TMP ?? 'F:/aidata/cache';
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'jmbots-generation-'));
    const bots = options.enabled === false ? 'bots: []' : 'bots:\n  - name: 小测\n    language: zh';
    const config = [
      'providers: {}', 'default_model: fake/configured', bots,
      'engine:', `  max_rounds: ${String(options.maxRounds ?? 30)}`,
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), config);
    const resources = await resourcesModule.Resources.load(dir);
    const files = new filesModule.Files(resources);
    if (options.enabled !== false) {
      await files.ensureBot('小测');
    }
    return new Harness(dir, resources, files, plans, options.window ?? 100_000);
  }

  /** 渠道收件路径照真实文件库生成，再明确排进测试会话。 */
  async enqueue(text: string, bot = '小测'): Promise<storeModule.MessageRow> {
    const saved = await this.deps.files.saveIncoming(bot, 'http', text, []);
    const row = this.store.addMessage({ bot, channel: 'http', source: 'web', address: {}, ...saved });
    this.store.queueMessages([row.id], this.session.id, null);
    return row;
  }

  /** 沿正式会话入口跑，模型与渠道仍是本测试假对象。 */
  run(): Promise<void> {
    return builders.runnerOf(this.deps).runSession(this.session.id);
  }

  /** 只清理亲自 mkdtemp 的指定直接子目录，不接受外部删除路径。 */
  close(): void {
    const root = path.resolve(process.env.JMBOTS_TEST_TMP ?? 'F:/aidata/cache');
    const absolute = path.resolve(this.dir);
    if (path.dirname(absolute) !== root || !path.basename(absolute).startsWith('jmbots-generation-')) {
      throw new Error('测试目录归属不匹配');
    }
    fs.rmSync(absolute, { recursive: true, force: true });
  }

  /** 给全 Pi 结果形状，实际路由和思考设置都以这一调用的 request 为证据。 */
  private output(input: modelModule.ChatInput, plan: Plan): modelModule.ChatOutput {
    const model = plan.model ?? 'actual/generated';
    const toolCalls: piAi.ToolCall[] = (plan.tools ?? []).map((tool, index) => ({
      type: 'toolCall', id: `call-${this.calls.length}-${index}`, name: tool.name,
      arguments: tool.args as piAi.JsonObject,
    }));
    const message: piAi.AssistantMessage = {
      role: 'assistant',
      content: [...(plan.text ? [{ type: 'text' as const, text: plan.text }] : []), ...toolCalls],
      api: 'openai-completions', provider: 'actual', model: model.replace(/^actual\//, ''),
      usage: {
        input: plan.tokens ?? 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: plan.tokens ?? 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: plan.error ? 'error' : 'stop', errorMessage: plan.error, timestamp: Date.now(),
    };
    return {
      message, text: plan.text ?? '', thinking: '', toolCalls, ms: 1, error: plan.error,
      request: {
        model, thinkingAsked: plan.requested ?? 'high', thinking: plan.sent ?? 'low',
        system: '', tools: [], messages: input.messages,
      },
    };
  }
}


bunTest.test('同次生成的多句工具reply共享生成/输入快照，不被后续会话调用覆盖', async () => {
  const h = await Harness.create([
    { model: 'actual/fallback', requested: 'high', sent: 'medium', tools: [
      { name: 'reply', args: { text: '第一句' } }, { name: 'reply', args: { text: '第二句' } },
    ] },
    { model: 'actual/later', text: '这句不应再次发出' },
  ]);
  try {
    const row = await h.enqueue('问题');
    await h.run();
    const replies = h.store.getMessage(row.id)!.replies;
    bunTest.expect(replies.map((reply) => reply.generation?.model)).toEqual(['actual/fallback', 'actual/fallback']);
    bunTest.expect(replies.map((reply) => reply.generation?.callId)).toEqual(['call-1-0', 'call-1-1']);
    bunTest.expect(replies[0]!.generation?.thinkingRequested).toBe('high');
    bunTest.expect(replies[0]!.generation?.thinkingSent).toBe('medium');
    bunTest.expect(replies[0]!.generation?.thinkingReported).toBeNull();
    bunTest.expect(replies[0]!.association).toEqual(replies[1]!.association);
    bunTest.expect(replies[0]!.association?.scope).toBe('turn');
    bunTest.expect(replies[0]!.association?.messageIds).toEqual([row.id]);
    bunTest.expect(h.sent).toEqual(['第一句', '第二句']);
    bunTest.expect(h.calls).toHaveLength(2);
  } finally {
    h.close();
  }
});


bunTest.test('成功回复后的新输入在同次运行重开观察轮，来源卡与association一致', async () => {
  const h = await Harness.create([
    { model: 'actual/first', tools: [{ name: 'reply', args: { text: '已回答第一问' } }] },
    { model: 'actual/second', text: '回答第二问' },
  ]);
  try {
    const first = await h.enqueue('第一问');
    let second: storeModule.MessageRow | undefined;
    h.onSend = async (text) => {
      if (text === '已回答第一问') {
        second = await h.enqueue('第二问');
      }
    };
    await h.run();
    const a = h.store.getMessage(first.id)!.replies[0]!;
    const b = h.store.getMessage(second!.id)!.replies[0]!;
    bunTest.expect(a.trace?.run).toBe(b.trace?.run);
    bunTest.expect(a.association?.messageIds).toEqual([first.id]);
    bunTest.expect(b.association?.messageIds).toEqual([second!.id]);
    bunTest.expect(b.generation?.model).toBe('actual/second');
    const view = new traceModule.ReplyTracer(h.store, h.deps.secrets).read(second!.id, 0)!;
    bunTest.expect(view.sources.map((source) => source.id)).toEqual(view.target.association.messageIds);
    bunTest.expect(view.events.some((event) => event.id === a.trace?.eventId)).toBe(false);
    bunTest.expect(h.deps.events!.list({ type: 'turn.started', sessionId: h.session.id, limit: 10 })).toHaveLength(2);
  } finally {
    h.close();
  }
});


bunTest.test('未回复时到达的多批输入累加；没有新输入的后续工具不重开观察轮', async () => {
  let second: storeModule.MessageRow | undefined;
  const h = await Harness.create([
    { tools: [{ name: 'summary', args: { text: '在整理' } }], before: async (running) => {
      second = await running.enqueue('追加条件');
    } },
    { tools: [{ name: 'reply', args: { text: '合并回答' } }] },
    { tools: [{ name: 'summary', args: { text: '继续整理' } }] },
    { tools: [{ name: 'reply', args: { text: '补充回答' } }] },
    { text: '结束' },
  ]);
  try {
    const first = await h.enqueue('原问题');
    await h.run();
    const replies = h.store.getMessage(second!.id)!.replies;
    bunTest.expect(replies).toHaveLength(2);
    bunTest.expect(replies[0]!.association?.messageIds).toEqual([first.id, second!.id]);
    bunTest.expect(replies[1]!.association).toEqual(replies[0]!.association);
    bunTest.expect(h.deps.events!.list({ type: 'turn.started', sessionId: h.session.id, limit: 10 })).toHaveLength(1);
  } finally {
    h.close();
  }
});


bunTest.test('压缩调用不覆盖最终生成模型；持久助手同时保存生成与来源', async () => {
  const h = await Harness.create([
    { model: 'actual/working', tokens: 900, tools: [{ name: 'summary', args: { text: '任务摘要' } }] },
    { model: 'actual/compact', requested: 'low', sent: 'off', text: '很短的压缩摘要' },
    { model: 'actual/final', requested: 'high', sent: 'medium', text: '最终答案' },
  ], { window: 1000 });
  try {
    const row = await h.enqueue('请处理');
    await h.run();
    const reply = h.store.getMessage(row.id)!.replies[0]!;
    bunTest.expect(h.calls.map((call) => call.purpose)).toEqual(['session', 'compact', 'session']);
    bunTest.expect(reply.generation?.model).toBe('actual/final');
    bunTest.expect(reply.generation?.purpose).toBe('session');
    bunTest.expect(reply.generation?.thinkingSent).toBe('medium');
    const assistant = h.store.getSession(h.session.id)!.messages.findLast((stored) => {
      return stored.message.role === 'assistant';
    });
    bunTest.expect(assistant?.generation?.model).toBe('actual/final');
    bunTest.expect(assistant?.association).toEqual(reply.association);
  } finally {
    h.close();
  }
});


bunTest.test('模型错误与上限是程序文字，不归给失败或当前配置模型', async () => {
  for (const maxRounds of [0, 30]) {
    const h = await Harness.create([{ model: 'actual/failed', error: 'request timed out' }], { maxRounds });
    try {
      const row = await h.enqueue('问题');
      await h.run();
      const generation = h.store.getMessage(row.id)!.replies[0]!.generation!;
      bunTest.expect(generation.kind).toBe('program');
      bunTest.expect(generation.model).toBeNull();
      bunTest.expect(generation.thinkingRequested).toBeNull();
      bunTest.expect(h.calls).toHaveLength(maxRounds === 0 ? 0 : 1);
    } finally {
      h.close();
    }
  }
});


bunTest.test('停用机器人不会beginRun、调模型或产生error回复', async () => {
  const h = await Harness.create([], { enabled: false });
  try {
    await h.run();
    const session = h.store.getSession(h.session.id)!;
    bunTest.expect(session.status).toBe('idle');
    bunTest.expect(session.runs).toEqual([]);
    bunTest.expect(h.calls).toEqual([]);
    bunTest.expect(h.sent).toEqual([]);
  } finally {
    h.close();
  }
});


bunTest.test('旧历史只在唯一助手与明确原消息关联时恢复；重复同文保持未知，不猜当前模型', async () => {
  const h = await Harness.create([{ model: 'actual/old', text: '历史答案' }]);
  try {
    const row = await h.enqueue('原问题');
    await h.run();
    const saved = h.store.getMessage(row.id)!.replies[0]!;
    const session = h.store.getSession(h.session.id)!;
    /** 模拟旧结构：去掉新增快照，保留当时真实助手模型和 effort。 */
    const messages = session.messages.map((stored) => ({ ...stored, generation: undefined, association: undefined }));
    h.store.updateSession(session.id, { messages, model: 'wrong/current', thinking: 'max' });
    const legacy: storeModule.Reply = { at: saved.at, session: saved.session, text: saved.text, trace: saved.trace };
    const origin = { ...h.store.getMessage(row.id)!, replies: [legacy] };
    const evidence = new evidenceModule.ReplyEvidenceReader(h.store).read(origin, legacy);
    bunTest.expect(evidence.generation.model).toBe('actual/old');
    bunTest.expect(evidence.generation.source).toBe('stored-assistant');
    bunTest.expect(evidence.generation.thinkingRequested).toBeNull();
    bunTest.expect(evidence.generation.thinkingSent).toBe('low');
    bunTest.expect(evidence.association.scope).toBe('run');
    const duplicated = { ...origin, replies: [legacy, legacy] };
    const ambiguous = new evidenceModule.ReplyEvidenceReader(h.store).read(duplicated, legacy);
    bunTest.expect(ambiguous.generation.kind).toBe('unknown');
    bunTest.expect(ambiguous.generation.model).toBeNull();
  } finally {
    h.close();
  }
});


bunTest.test('旧工具reply必须有对应成功工具结果；相同文本多调用或未执行不能恢复模型', async () => {
  const h = await Harness.create([
    { model: 'actual/legacy-tool', tools: [{ name: 'reply', args: { text: '工具答复' } }] },
    { text: '结束' },
  ]);
  try {
    const row = await h.enqueue('原问题');
    await h.run();
    const saved = h.store.getMessage(row.id)!.replies[0]!;
    const legacy: storeModule.Reply = { at: saved.at, session: saved.session, text: saved.text, trace: saved.trace };
    const origin = { ...h.store.getMessage(row.id)!, replies: [legacy] };
    const session = h.store.getSession(h.session.id)!;
    const messages = session.messages.map((stored) => ({ ...stored, generation: undefined, association: undefined }));
    h.store.updateSession(session.id, { messages });
    const evidence = new evidenceModule.ReplyEvidenceReader(h.store).read(origin, legacy);
    bunTest.expect(evidence.generation.model).toBe('actual/legacy-tool');
    bunTest.expect(evidence.generation.callId).toBe('call-1-0');
    const failed = messages.map((stored) => {
      if (stored.message.role !== 'toolResult' || stored.message.toolName !== 'reply') {
        return stored;
      }
      return { ...stored, message: { ...stored.message, isError: true } };
    });
    h.store.updateSession(session.id, { messages: failed });
    const missingProof = new evidenceModule.ReplyEvidenceReader(h.store).read(origin, legacy);
    bunTest.expect(missingProof.generation.kind).toBe('unknown');
    bunTest.expect(evidenceModule.programGeneration('notice', { run: undefined }).run).toBeNull();
  } finally {
    h.close();
  }
});


bunTest.test('重启补发使用已保存助手快照，不再调用模型或猜新会话设置', async () => {
  const h = await Harness.create([]);
  try {
    const row = await h.enqueue('原问题');
    h.store.takeQueued(h.session.id);
    const generation: storeModule.ReplyGeneration = {
      ...evidenceModule.unknownGeneration(), kind: 'model', source: 'snapshot', model: 'actual/before-restart',
      thinkingRequested: 'high', thinkingSent: 'medium', purpose: 'session', run: 1, step: 2, assistantAt: 1234,
    };
    const association = evidenceModule.association([row.id], 'turn', '重启前的生成快照');
    h.store.updateSession(h.session.id, {
      model: 'fake/configured', thinking: 'off', replyTo: row.id,
      messages: [
        { run: 1, messageIds: [row.id], message: { role: 'user', content: row.text, timestamp: 1233 } },
        {
          run: 1, generation, association,
          message: {
            role: 'assistant', content: [{ type: 'text', text: '重启前已经生成的答案' }], timestamp: 1234,
            api: 'openai-completions', provider: 'actual', model: 'before-restart', stopReason: 'stop',
            usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          },
        },
      ],
    });
    await h.run();
    const reply = h.store.getMessage(row.id)!.replies[0]!;
    bunTest.expect(h.calls).toHaveLength(0);
    bunTest.expect(reply.generation?.model).toBe('actual/before-restart');
    bunTest.expect(reply.generation?.thinkingSent).toBe('medium');
    bunTest.expect(reply.association).toEqual(association);
  } finally {
    h.close();
  }
});


bunTest.test('resolve明确号跨分页补取并按bot隔离；返回相同生成/关联而不写库或调模型', async () => {
  const h = await Harness.create([{ model: 'actual/answer', text: '回答' }]);
  try {
    const row = await h.enqueue('问题');
    await h.run();
    const other = await h.enqueue('其他机器人消息', '其他机器人');
    const before = h.calls.length;
    const eventsBefore = h.deps.events!.list({ limit: 1000 }).length;
    const app = new httpModule.HttpApp(builders.httpPartsOf(h.deps)).build();
    try {
      const query = new URLSearchParams({ bot: '小测', ids: `${row.id},${other.id},99999` });
      const response = await app.inject(`/api/messages/resolve?${query.toString()}`);
      bunTest.expect(response.statusCode).toBe(200);
      const resolved = response.json<{ messages: httpUiModule.MessageView[]; missingIds: number[] }>();
      bunTest.expect(resolved.messages.map((message) => message.id)).toEqual([row.id]);
      bunTest.expect(resolved.missingIds).toEqual([other.id, 99999]);
      const reply = resolved.messages[0]!.replies[0]!;
      bunTest.expect(reply.generation.model).toBe('actual/answer');
      bunTest.expect(reply.association.scope).toBe('turn');
      bunTest.expect(JSON.stringify(resolved)).not.toContain('system');
      const ids = Array.from({ length: 101 }, (_, index) => String(index + 1)).join(',');
      const oversized = new URLSearchParams({ bot: '小测', ids });
      const rejected = await app.inject(`/api/messages/resolve?${oversized.toString()}`);
      bunTest.expect(rejected.statusCode).toBe(400);
      bunTest.expect((await app.inject('/api/messages/resolve?ids=1')).statusCode).toBe(400);
      bunTest.expect(h.calls).toHaveLength(before);
      bunTest.expect(h.deps.events!.list({ limit: 1000 })).toHaveLength(eventsBefore);
    } finally {
      await app.close();
    }
  } finally {
    h.close();
  }
});
