/**
 * 回复追踪的公共边界测试：真实数据库、事件总线、会话循环和 HTTP inject。
 * 使用临时运行时与假模型；不联网、不监听端口、不读取用户运行时配置。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import * as eventsModule from '../src/capabilities/Events.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as traceModule from '../src/capabilities/Trace.ts';
import * as httpModule from '../src/channels/Http.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/** 数据库层假密钥，验证安全投影；不对应任何真实账户。 */
const FAKE_SECRET = 'fake-trace-secret-123456';


/** 添加确定来源，供纯数据库的边界测试使用。 */
function addMessage(store: storeModule.Store, text = '原消息'): storeModule.MessageRow {
  return store.addMessage({
    bot: '小测',
    channel: 'http',
    source: 'web',
    address: {},
    file: '/trace/message.md',
    text,
  });
}


/** 添加一个已知持久顺序的事件；at 故意可与 ID 相反，检查不能按墙钟重排。 */
function addEvent(
  store: storeModule.Store,
  type: string,
  data: Record<string, unknown>,
  sessionId: string | null = 'session-1',
  messageId: number | null = null,
  at = Date.now(),
): number {
  return store.addEvent({
    type,
    at,
    source: '测试',
    bot: '小测',
    sessionId,
    messageId,
    key: null,
    data,
    parent: null,
    depth: 0,
  })!;
}


/** 保存带明确边界的成功回复。 */
function addReply(
  store: storeModule.Store,
  messageId: number,
  trace: storeModule.ReplyTrace,
): void {
  store.addReply(messageId, {
    at: Date.now(),
    session: { id: 'session-1', title: '同一会话', file: '/trace/session.md' },
    text: `回复 ${trace.step}`,
    trace,
  });
}


bunTest.test('同次运行两句回复分别截止自己的回执，按事件 ID 而非时间排序', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store);
  const received = addEvent(store, 'message.received', {}, null, message.id, message.createdAt);
  const run = addEvent(store, 'run.started', { run: 1 });
  const context = addEvent(store, 'context.built', { run: 1, messageIds: [message.id] });
  const first = addEvent(store, 'reply.sent', { run: 1, ok: true }, 'session-1', message.id, message.createdAt + 100);
  const nextStep = addEvent(store, 'step.before', { run: 1, step: 2 }, 'session-1', message.id, message.createdAt + 90);
  const second = addEvent(store, 'reply.sent', { run: 1, ok: true }, 'session-1', message.id, message.createdAt + 120);
  addEvent(store, 'tool.after', { run: 1 }, 'other-session', message.id);
  const firstBoundary = {
    run: 1,
    step: 1,
    messageIds: [message.id],
    runEventId: run,
    contextEventId: context,
    eventId: first,
  };
  const secondBoundary = { ...firstBoundary, step: 2, eventId: second };
  addReply(store, message.id, firstBoundary);
  addReply(store, message.id, secondBoundary);

  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const firstView = tracer.read(message.id, 0)!;
  const secondView = tracer.read(message.id, 1)!;

  bunTest.expect(firstView.scope).toBe('exact');
  bunTest.expect(firstView.events.map((event) => event.id)).toEqual([received, run, context, first]);
  bunTest.expect(secondView.events.map((event) => event.id)).toEqual([received, run, context, first, nextStep, second]);
  bunTest.expect(firstView.elapsedMs).toBe(100);
  bunTest.expect(secondView.elapsedMs).toBe(120);
  bunTest.expect(tracer.read(message.id, 2)).toBeUndefined();
});


bunTest.test('同会话后一次运行即使复用原收件，也不混入前次执行事件', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store);
  const received = addEvent(store, 'message.received', {}, null, message.id);
  addEvent(store, 'run.started', { run: 1, messageIds: [message.id] });
  const previous = addEvent(store, 'tool.after', { run: 1, messageIds: [message.id] }, 'session-1', message.id);
  const run = addEvent(store, 'run.started', { run: 2 });
  const step = addEvent(store, 'step.after', { run: 2, messageIds: [message.id] });
  const sent = addEvent(store, 'reply.sent', { run: 2 }, 'session-1', message.id);
  addReply(store, message.id, { run: 2, step: 1, messageIds: [message.id], runEventId: run, eventId: sent });

  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const view = tracer.read(message.id, 0)!;
  bunTest.expect(view.events.map((event) => event.id)).toEqual([received, run, step, sent]);
  bunTest.expect(view.events.some((event) => event.id === previous)).toBe(false);
});


bunTest.test('明确 parent 关联的限时、观察和 gate 子链保留，仍截止这句回复', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store);
  const run = addEvent(store, 'run.started', { run: 1 });
  const limit = store.addEvent({
    type: 'limit.reached',
    at: Date.now(),
    source: 'Progress',
    bot: '小测',
    sessionId: 'session-1',
    messageId: null,
    key: null,
    data: { minutes: 20 },
    parent: run,
    depth: 1,
  })!;
  const gate = store.addEvent({
    type: 'gate.decided',
    at: Date.now(),
    source: 'EventBus',
    bot: '小测',
    sessionId: 'session-1',
    messageId: null,
    key: null,
    data: { go: true },
    parent: limit,
    depth: 2,
  })!;
  const sent = addEvent(store, 'reply.sent', { run: 1, ok: true });
  const after = store.addEvent({
    type: 'watch.think_slow',
    at: Date.now(),
    source: 'EventWatch',
    bot: '小测',
    sessionId: 'session-1',
    messageId: null,
    key: null,
    data: {},
    parent: run,
    depth: 1,
  })!;
  addReply(store, message.id, { run: 1, step: 1, messageIds: [message.id], runEventId: run, eventId: sent });

  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const view = tracer.read(message.id, 0)!;
  bunTest.expect(view.events.map((event) => event.id)).toEqual([run, limit, gate, sent]);
  bunTest.expect(view.events.some((event) => event.id === after)).toBe(false);
});


bunTest.test('事件过期仍保留关联号时，回复入库时间不能冒充真实发送回执', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store);
  const run = addEvent(store, 'run.started', { run: 1 });
  const sent = addEvent(store, 'reply.sent', { run: 1, ok: true });
  addReply(store, message.id, { run: 1, step: 1, messageIds: [message.id], runEventId: run, eventId: sent });
  store.pruneEvents(Date.now() + 1);

  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const view = tracer.read(message.id, 0)!;
  bunTest.expect(view.scope).toBe('exact');
  bunTest.expect(view.endSource).toBe('reply-record');
  bunTest.expect(view.notes.join(' ')).toContain('不能确认渠道发送实测');
});


bunTest.test('旧回复只显示明确批次，历史无记录与保存缺失必须说清楚', () => {
  const store = new storeModule.Store(':memory:');
  const first = addMessage(store);
  const second = addMessage(store);
  const dispatch = {
    messageIds: [first.id, second.id],
    startedAt: Date.now() - 10,
    ms: 7,
    result: { session: 'new', model: 'fake/actual', by: 'fallback', reason: '程序兜底' },
    checks: ['常规模型超过时限'],
    llm: { request: { model: 'fake/dispatch', system: '不应出现的系统提示' }, steps: [], error: '超时' },
  };
  store.queueMessages([first.id, second.id], 'session-1', dispatch);
  const received = addEvent(store, 'message.received', {}, null, first.id);
  const batch = addEvent(store, 'batch.taken', { messageIds: [first.id, second.id], mergeMs: 5000, ms: 7001 }, null);
  addEvent(store, 'tool.after', { run: 5 }, 'session-1');
  store.addReply(second.id, {
    at: Date.now() + 1,
    session: { id: 'session-1', title: '', file: '' },
    text: '旧回复',
  });

  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const view = tracer.read(second.id, 0)!;
  bunTest.expect(view.scope).toBe('message-only');
  bunTest.expect(view.sources.map((source) => source.id)).toEqual([first.id, second.id]);
  bunTest.expect(view.events.map((event) => event.id)).toEqual([received, batch]);
  bunTest.expect(view.notes.join(' ')).toContain('不能确认完整事件链');
  bunTest.expect(JSON.stringify(view.dispatches)).not.toContain('不应出现的系统提示');
  bunTest.expect(view.dispatches[0]?.checks).toEqual(['常规模型超过时限']);

  const empty = addMessage(store);
  store.addReply(empty.id, { at: Date.now(), session: { id: '', title: '', file: '' }, text: '无记录' });
  bunTest.expect(tracer.read(empty.id, 0)?.notes.join(' ')).toContain('没有找到事件');
});


bunTest.test('查询多取一条识别截断，并在缺失起点时保留诚实范围说明', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store);
  const run = addEvent(store, 'run.started', { run: 1 });
  for (let index = 0; index < 2001; index += 1) {
    addEvent(store, 'step.after', { run: 1, index });
  }
  const sent = addEvent(store, 'reply.sent', { run: 1 });
  addReply(store, message.id, { run: 1, step: 1, messageIds: [message.id], runEventId: run, eventId: sent });

  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const view = tracer.read(message.id, 0)!;
  bunTest.expect(view.truncated).toBe(true);
  bunTest.expect(view.events).toHaveLength(2000);
  bunTest.expect(view.events.at(-1)?.id).toBe(sent);
  bunTest.expect(view.notes.join(' ')).toContain('显示上限');
  bunTest.expect(view.notes.join(' ')).toContain('运行起点事件已缺失');
});


bunTest.test('安全投影遮住旧原文和用量错误中的假密钥，保留用量归属限制', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store, `原文 ${FAKE_SECRET}`);
  store.addReply(message.id, {
    at: Date.now() + 10,
    session: { id: 'session-1', title: '', file: '' },
    text: FAKE_SECRET,
  });
  store.addUsage({
    at: Date.now(),
    provider: 'fake',
    model: 'fake/test',
    kind: 'chat',
    purpose: 'session',
    sessionId: 'session-1',
    input: 2,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    ms: 3,
    ok: false,
    error: FAKE_SECRET,
  });
  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([FAKE_SECRET]));
  const view = tracer.read(message.id, 0)!;
  bunTest.expect(JSON.stringify(view)).not.toContain(FAKE_SECRET);
  bunTest.expect(view.usageScope).toBe('session-window');
  bunTest.expect(view.usage[0]?.model).toBe('fake/test');
});


bunTest.test('旧历史分派显示真实阶段、采用依据和结构化摘要，不含提示或思考全文', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store, '能不能搜索网页？');
  const conclusion = {
    session: 'new',
    workspace: '日常',
    model: 'fake/session',
    reason: '这是新话题，放入日常工作区',
  };
  const dispatch = {
    messageIds: [message.id],
    startedAt: message.createdAt,
    ms: 29562,
    checks: [],
    result: { ...conclusion, by: 'llm' },
    decisionModel: {
      model: 'fake/decision',
      ms: 4163,
      used: false,
      why: '去向最高 0.59，没到 0.6，拿不准',
      state: '不得输出的完整状态',
      question: '不得输出的完整题面',
      options: [{ label: '继续原会话', session: 'old-session', probability: 0.59 }],
    },
    llm: {
      request: { model: 'fake/dispatch', system: '不得输出的系统提示', input: '不得输出的分派现状' },
      value: conclusion,
      steps: [{
        at: message.createdAt + 4200,
        ms: 25255,
        effort: 'high',
        text: JSON.stringify({ ...conclusion, system: '不得输出的自由字段' }),
        thinking: '不得输出的内部思考',
        calls: [{ name: 'read', args: { path: '不得输出的原始参数' }, result: '不得输出的工具全文' }],
      }],
    },
  };
  store.queueMessages([message.id], 'session-1', dispatch);
  store.addReply(message.id, {
    at: Date.now(),
    session: { id: 'session-1', title: '发送时的会话标题', file: '/trace/session.md' },
    text: '可以搜索网页，已完成检查。',
  });

  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const view = tracer.read(message.id, 0)!;
  const saved = view.dispatches[0]!;
  bunTest.expect(view.target.sessionTitle).toBe('发送时的会话标题');
  bunTest.expect(view.target.workspace).toBe('日常');
  bunTest.expect(view.target.messageFile).toBe(message.file);
  bunTest.expect(view.sources[0]?.text).toBe(message.text);
  bunTest.expect(view.sources[0]?.textChars).toBe(message.text.length);
  bunTest.expect(saved.ms).toBe(29562);
  bunTest.expect(saved.defaultModel).toBeNull();
  bunTest.expect(saved.actualModel).toBe('fake/session');
  bunTest.expect(saved.targetSessionId).toBe('session-1');
  bunTest.expect(saved.stages.map((stage) => stage.kind)).toEqual(['decision', 'llm']);
  bunTest.expect(saved.stages[0]).toMatchObject({ ms: 4163, used: false, startedAt: null, msSource: 'stage' });
  bunTest.expect(saved.stages[0]?.options[0]?.probability).toBe(0.59);
  bunTest.expect(saved.stages[1]).toMatchObject({ ms: 25255, used: true, msSource: 'calls-sum' });
  bunTest.expect(saved.stages[1]?.steps[0]?.tools).toEqual(['read']);
  bunTest.expect(saved.stages[1]?.steps[0]?.summary).toContain(conclusion.reason);
  bunTest.expect(JSON.stringify(view)).not.toContain('不得输出');
});


bunTest.test('默认模型只取同批记录；追加会话的实际模型可由当时入队事件补全', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store);
  const dispatch = {
    messageIds: [message.id],
    startedAt: message.createdAt,
    ms: 10,
    result: { by: 'decision', session: 'session-1', workspace: '日常', model: '' },
    decisionModel: { model: 'fake/decision', used: true, why: '继续这个会话', ms: 10 },
  };
  store.queueMessages([message.id], 'session-1', dispatch);
  addEvent(store, 'dispatch.started', {
    messageIds: [message.id],
    startedAt: dispatch.startedAt,
    defaultModel: 'fake/default-then',
  }, null);
  addEvent(store, 'message.queued', {
    messageIds: [message.id],
    model: 'fake/actual-then',
  });
  store.addReply(message.id, {
    at: Date.now() + 1,
    session: { id: 'session-1', title: '', file: '' },
    text: '回答',
  });

  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const saved = tracer.read(message.id, 0)?.dispatches[0];
  bunTest.expect(saved?.defaultModel).toBe('fake/default-then');
  bunTest.expect(saved?.actualModel).toBe('fake/actual-then');
});


bunTest.test('历史缺调用耗时和程序兜底时间时保持未知，不补造零或模型推理', () => {
  const store = new storeModule.Store(':memory:');
  const message = addMessage(store);
  store.queueMessages([message.id], 'session-1', {
    messageIds: [message.id],
    result: { by: 'fallback', session: 'new', model: 'fake/default', reason: '模型未能定下来' },
    checks: ['常规模型超过时限'],
    decisionModel: { model: 'fake/decision', options: [{ label: '未知概率', session: 'new' }] },
    llm: { request: { model: 'fake/dispatch' }, error: '超时', steps: [{ at: Date.now(), text: '普通文字' }] },
  });
  store.addReply(message.id, { at: Date.now(), session: { id: 'session-1', title: '', file: '' }, text: '回答' });
  const tracer = new traceModule.ReplyTracer(store, new secretsModule.Secrets([]));
  const stages = tracer.read(message.id, 0)!.dispatches[0]!.stages;

  bunTest.expect(stages.map((stage) => stage.kind)).toEqual(['decision', 'llm', 'fallback']);
  bunTest.expect(stages.every((stage) => stage.ms === null)).toBe(true);
  bunTest.expect(stages[0]?.used).toBeNull();
  bunTest.expect(stages[0]?.options[0]?.probability).toBeNull();
  bunTest.expect(stages[1]?.summary).toBeNull();
  bunTest.expect(stages[2]?.summary).toBe('模型未能定下来');
});


/** 真实会话循环的假模型结果，确保埋点不会增加模型调用。 */
function answer(input: { model: string }, text: string): piAi.AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: input.model,
    usage: {
      input: 2,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}


bunTest.test('真实循环两次运行保存各自消息、上下文和发送边界；HTTP 查询只读且不调模型', async () => {
  /** 临时目录限定在任务缓存，不操作任何用户运行时。 */
  const tempRoot = process.env.JMBOTS_TEST_TMP ?? 'F:/aidata/cache';
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'jmbots-trace-'));
  const fakeConfig = [
    'providers: {}',
    'default_model: fake/test',
    'bots:',
    '  - name: 小测',
    '    language: zh',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'config.yaml'), fakeConfig);
  const resources = await resourcesModule.Resources.load(dir);
  const files = new filesModule.Files(resources);
  await files.ensureBot('小测');
  const store = new storeModule.Store(':memory:');
  const secrets = new secretsModule.Secrets([]);
  const events = new eventsModule.EventBus(store, resources, secrets);
  let calls = 0;
  const ai = builders.fakeAi({
    chat: (input) => {
      calls += 1;
      const text = `回答 ${calls}`;
      return Promise.resolve({
        message: answer(input, text),
        text,
        thinking: '',
        toolCalls: [],
        ms: 1,
        request: {
          model: input.model,
          thinkingAsked: 'off',
          thinking: 'off',
          system: '',
          tools: [],
          messages: input.messages,
        },
      });
    },
    decide: () => Promise.reject(new Error('测试不应调决策模型')),
    hasDecision: () => false,
    listModels: () => [{
      id: 'fake/test',
      name: 'test',
      kind: 'chat',
      contextWindow: 100000,
      thinking: ['off'],
      vision: false,
      price: { input: 0, output: 0 },
    }],
  });
  const deps: builders.TestDeps = {
    resources,
    files,
    store,
    secrets,
    events,
    ai,
    approvals: new approvalsModule.Approvals(),
    out: {
      send: () => Promise.resolve(),
      sendApproval: () => Promise.resolve([]),
      publishDoc: () => Promise.reject(new Error('不用')),
      deleteDoc: () => Promise.reject(new Error('不用')),
    },
  };
  const session = store.createSession({
    bot: '小测',
    workspace: '日常',
    title: '事件测试',
    model: 'fake/test',
    thinking: null,
  });
  const runner = builders.runnerOf(deps);
  const tracer = new traceModule.ReplyTracer(store, secrets);
  const app = new httpModule.HttpApp(builders.httpPartsOf(deps)).build();

  try {
    const first = addMessage(store, '第一问');
    store.queueMessages([first.id], session.id, null);
    await runner.runSession(session.id);
    const second = addMessage(store, '第二问');
    store.queueMessages([second.id], session.id, null);
    await runner.runSession(session.id);

    const firstTrace = store.getMessage(first.id)?.replies[0]?.trace;
    const secondTrace = store.getMessage(second.id)?.replies[0]?.trace;
    bunTest.expect(firstTrace?.run).toBe(1);
    bunTest.expect(secondTrace?.run).toBe(2);
    bunTest.expect(firstTrace?.messageIds).toEqual([first.id]);
    bunTest.expect(secondTrace?.messageIds).toEqual([second.id]);
    bunTest.expect(firstTrace?.eventId).toBeLessThan(secondTrace!.runEventId!);
    const secondView = tracer.read(second.id, 0)!;
    bunTest.expect(secondView.scope).toBe('exact');
    bunTest.expect(secondView.events.every((event) => event.data.run === 2)).toBe(true);
    const context = secondView.events.find((event) => event.type === 'context.built');
    bunTest.expect(context?.data.contextCount).toBeGreaterThan(1);
    bunTest.expect(JSON.stringify(context?.data)).not.toContain('systemText');

    const countBefore = events.list({ limit: 1000 }).length;
    const response = await app.inject(`/api/messages/${second.id}/trace?reply=0`);
    bunTest.expect(response.statusCode).toBe(200);
    bunTest.expect(response.json<traceModule.ReplyTraceView>().target.messageId).toBe(second.id);
    bunTest.expect((await app.inject(`/api/messages/${second.id}/trace?reply=-1`)).statusCode).toBe(400);
    bunTest.expect((await app.inject(`/api/messages/${second.id}/trace?reply=9`)).statusCode).toBe(404);
    bunTest.expect(events.list({ limit: 1000 })).toHaveLength(countBefore);
    bunTest.expect(calls).toBe(2);
    /** 巨量观察数据被截短后，关联键依然留在顶层，不能从追踪中悄悄消失。 */
    const large = events.emit('test.large', {
      run: 99,
      step: 1,
      messageIds: [second.id],
      content: Array.from({ length: 20 }, () => 'x'.repeat(2000)),
    }, { source: '测试', bot: '小测', sessionId: session.id });
    bunTest.expect(large?.data.truncated).toBe(true);
    bunTest.expect(large?.data.run).toBe(99);
    bunTest.expect(large?.data.messageIds).toEqual([second.id]);
  } finally {
    await app.close();
    /** 只清理本测试亲自创建的直接子目录。 */
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
