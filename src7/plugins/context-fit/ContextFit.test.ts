/**
 * session-context（主插件 context-fit，并入 compress、summary）离线测试：
 *   1. 纯函数 estimate / fit（先省略旧工具结果，仍超再按段裁剪并保留最后用户话）；
 *   2. Summary 在 work 会话进入 done 时触发 summary 小会话并写回 row.summary，compress/summary 开关与非法配置校验；
 *   3. 同一 apply 内的 session/before-model 严格顺序：Compress 先压缩并替换 request.messages，ContextFit 再在预算内省略旧工具结果。
 * 跑法：bun test src7/plugins/context-fit
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as dbPlugin from '../db/index.ts';
import * as catalogPull from '../model-catalog/Pull.ts';
import * as contextFitPlugin from './index.ts';


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 供 context-fit、Compress 与 Sessions 使用的最小 Resources 服务。 */
function makeResources(contextWindow: number, declareWindow = true) {
  const written: Record<string, number> = {};
  if (declareWindow) {
    written['context_window'] = contextWindow;
  }
  return class FakeResources extends cordis.Service {
    readonly db = new Database(':memory:');
    readonly raw = {
      providers: { fake: { models: { fake: written } } },
    };
    readonly config = {
      defaultModel: 'fake/fake',
      sessionCacheMax: 500,
      thinking: 'low',
      retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
      providers: { fake: { models: { fake: { contextWindow } }, modelCompat: {} } },
    };

    constructor(ctx: cordis.Context) {
      super(ctx, 'resources');
    }

    getModel(): { contextWindow: number } {
      return { contextWindow };
    }
  };
}


/** 构造假模型回答 AssistantMessage，content 放文字块，usage 放用量，stopReason 标记如何结束。 */
function fakeAssistantWithUsage(text: string, totalTokens: number): piAi.AssistantMessage {
  const base = piAi.fauxAssistantMessage(text);
  return {
    ...base,
    usage: { ...base.usage, totalTokens },
  };
}


/** 构造一条带用量与工具调用的消息。 */
function fakeToolCallMessage(id: string, name: string, totalTokens = 0): piAi.AssistantMessage {
  const base = piAi.fauxAssistantMessage([piAi.fauxToolCall(name, {}, { id })], { stopReason: 'toolUse' });
  return {
    ...base,
    usage: { ...base.usage, totalTokens },
  };
}


/** 构造工具结果 ToolResultMessage，toolCallId 对应调用，content 放结果块，isError 标记成败。 */
function fakeToolResultMessage(callId: string, toolName: string, text: string): piAi.ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  };
}


describe('context-fit 纯裁剪与配置校验', () => {
  test('fit 先省略较早工具结果（保住最近 keep 条），仍超预算再丢弃较早整段并保留最后 user', () => {
    //M Message 是一条对话消息，用 role 区分来源，content 存正文或内容块，timestamp 记时间。
    const messages: piAi.Message[] = [
      { role: 'user', content: '第一问：排查问题', timestamp: 1 },
      fakeToolCallMessage('c1', 'read'),
      fakeToolResultMessage('c1', 'read', 'X'.repeat(3000)),
      fakeToolCallMessage('c2', 'read'),
      fakeToolResultMessage('c2', 'read', '最后一条工具结果保持原样'),
      { role: 'user', content: '第二问：总结结论', timestamp: 2 },
    ];
    //M 只省略第一条工具结果（约省 1000 token）就够放进预算，不应丢对话段。
    const budgetForTrimOnly = contextFitPlugin.estimate(messages) - 400;
    const trimmedOnly = contextFitPlugin.fit(messages, budgetForTrimOnly, 1);
    expect(trimmedOnly.trimmed).toBe(1);
    expect(trimmedOnly.dropped).toBe(0);
    expect(piAi.contentText(trimmedOnly.messages[2]!.content)).toContain('工具结果已省略');
    expect(piAi.contentText(trimmedOnly.messages[4]!.content)).toBe('最后一条工具结果保持原样');
    //M 原数组不被修改。
    expect(piAi.contentText(messages[2]!.content)).toBe('X'.repeat(3000));

    //M 预算更紧时先省略工具结果再丢较早整段，至少保住最后一条 user。
    const dropped = contextFitPlugin.fit(messages, 80, 0);
    expect(dropped.dropped).toBeGreaterThan(0);
    expect(dropped.messages.some((m) => m.role === 'user' && piAi.contentText(m.content) === '第二问：总结结论')).toBe(true);
    expect(piAi.contentText(dropped.messages[0]!.content)).toContain('已省略');
  });

  test('校验 keep、ratio、compress、summary 子配置', () => {
    expect(contextFitPlugin.readSummaryEnabled(undefined)).toBe(true);
    expect(contextFitPlugin.readSummaryEnabled(false)).toBe(false);
    expect(() => contextFitPlugin.readSummaryEnabled('bad')).toThrow();

    expect(contextFitPlugin.readCompressSettings(undefined)).toEqual({ enabled: true, ratio: 0.8, keep: 6 });
    expect(contextFitPlugin.readCompressSettings(false).enabled).toBe(false);
    expect(() => contextFitPlugin.readCompressSettings('bad')).toThrow();
    expect(() => contextFitPlugin.readCompressSettings({ at: 200000 })).toThrow('请改用 compress.ratio');
    expect(() => contextFitPlugin.readCompressSettings({ ratio: 0 })).toThrow('ratio');
    expect(() => contextFitPlugin.readCompressSettings({ ratio: 1 })).toThrow('ratio');
    expect(() => contextFitPlugin.readCompressSettings({ ratio: NaN })).toThrow('ratio');
    expect(() => contextFitPlugin.readCompressSettings({ ratio: null })).toThrow('ratio');
    expect(() => contextFitPlugin.readCompressSettings({ keep: -1 })).toThrow();

    const ctx = new cordis.Context();
    expect(() => contextFitPlugin.apply(ctx, { keep: -1 })).toThrow();
    expect(() => contextFitPlugin.apply(ctx, { ratio: 0 })).toThrow();
    expect(() => contextFitPlugin.apply(ctx, { ratio: 1.2 })).toThrow();
  });
});


describe('session-context 集成：Summary 与 Compress -> ContextFit 顺序', () => {
  test('窗口为 100 时前台在 80 压缩，后台子会话也可压缩，小会话跳过', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(makeResources(5000));
    await ctx.plugin(toolsModule.Tools);
    await ctx.plugin(sessionsModule.Sessions);
    await ctx.plugin(dbPlugin);
    const info = {
      id: 'fake/fake', name: '假模型', kind: 'chat' as const, contextWindow: 100,
      thinking: [], price: { input: 0, output: 0 },
    };
    //M 模型目录返回已登记的窗口，优先于 Resources 手写配置。
    events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', () => ({ info }));
    const config = { summary: false, compress: { ratio: 0.8, keep: 1 } };
    await ctx.plugin(contextFitPlugin, config);

    ctx.on('session/before-model', (request) => {
      if (request.session.row.kind !== 'compress') return;

      request.answer = piAi.fauxAssistantMessage('前情摘要');
    });

    const root = ctx.sessions.create({ kind: 'front', bot: '助手' });
    const cases = [
      { kind: 'front', tokens: 79, summary: false },
      { kind: 'front', tokens: 80, summary: true },
      { kind: 'work', parent: root.id, tokens: 80, summary: true },
      { kind: 'review', parent: root.id, tokens: 80, summary: false },
    ];
    for (const sample of cases) {
      const input = { kind: sample.kind, parent: sample.parent, bot: '助手' };
      const session = ctx.sessions.create(input);
      const messages: piAi.Message[] = [
        { role: 'user', content: '上一问', timestamp: 1 },
        fakeAssistantWithUsage('上一答', sample.tokens),
        { role: 'user', content: '当前问题', timestamp: 2 },
      ];
      session.row.messages = messages;
      const request: sessionsModule.ChatRequest = {
        session, model: 'fake/fake', thinking: 'off', system: [], tools: [], messages,
        signal: new AbortController().signal,
      };
      await ctx.serial('session/before-model', request);
      const first = piAi.contentText(request.messages[0]!.content);
      expect(first.includes('前情摘要')).toBe(sample.summary);
    }
  });

  test('缺窗口或只有估算值时跳过，登记同样的窗口后可以压缩', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(makeResources(128000, false));
    await ctx.plugin(toolsModule.Tools);
    await ctx.plugin(sessionsModule.Sessions);
    await ctx.plugin(dbPlugin);
    await ctx.plugin(contextFitPlugin, { summary: false, compress: { keep: 1 } });

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    closers.push(() => warn.mockRestore());
    await ctx.serial('ready', []);
    await ctx.serial('ready', []);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('fake/fake');

    const session = ctx.sessions.create({ kind: 'work', bot: '助手' });
    const messages: piAi.Message[] = [
      { role: 'user', content: '上一问', timestamp: 1 },
      fakeAssistantWithUsage('上一答', 200000),
      { role: 'user', content: '当前问题', timestamp: 2 },
    ];
    session.row.messages = messages;
    const request: sessionsModule.ChatRequest = {
      session, model: 'fake/fake', thinking: 'off', system: [], tools: [], messages,
      signal: new AbortController().signal,
    };
    ctx.on('session/before-model', (inner) => {
      if (inner.session.row.kind !== 'compress') return;

      inner.answer = piAi.fauxAssistantMessage('模型生成的摘要');
    });

    //M 目录缺席时使用资源层估算值裁剪，保持原始请求。
    await ctx.serial('session/before-model', request);
    expect(request.messages).toBe(messages);

    const listed = [{ id: 'fake' }];
    //M 用真实的目录合并逻辑生成只有估算窗口的回执。
    const merged = catalogPull.merge('fake', listed, {});
    let info = merged.models[0];
    expect(info?.contextWindow).toBe(128000);
    expect(info?.contextWindowEstimated).toBe(true);
    events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', () => ({ info }));
    await ctx.serial('session/before-model', request);
    expect(request.messages).toBe(messages);

    const written = { fake: { context_window: 128000 } };
    //M 显式登记与估算值相同的窗口，目录应保留登记来源并允许压缩。
    const declared = catalogPull.merge('fake', [], written);
    info = declared.models[0];
    await ctx.serial('session/before-model', request);
    expect(piAi.contentText(request.messages[0]!.content)).toContain('模型生成的摘要');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('压缩沿用当前请求选出的消息，保留此前省略的历史边界', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(makeResources(100));
    await ctx.plugin(toolsModule.Tools);
    await ctx.plugin(sessionsModule.Sessions);
    await ctx.plugin(dbPlugin);
    await ctx.plugin(contextFitPlugin, { summary: false, compress: { keep: 1 } });

    let asked = '';
    ctx.on('session/before-model', (inner) => {
      if (inner.session.row.kind !== 'compress') return;

      asked = piAi.contentText(inner.session.row.messages[0]!.content);
      inner.answer = piAi.fauxAssistantMessage('本轮可见摘要');
    });

    const session = ctx.sessions.create({ kind: 'front', bot: '助手' });
    const excluded: piAi.Message = { role: 'user', content: '已从本轮排除的历史', timestamp: 1 };
    const visible: piAi.Message = { role: 'user', content: '本轮可见的旧消息', timestamp: 2 };
    const answer = fakeAssistantWithUsage('上一答', 80);
    const current: piAi.Message = { role: 'user', content: '当前问题', timestamp: 3 };
    session.row.messages = [excluded, visible, answer, current];
    const request: sessionsModule.ChatRequest = {
      session, model: 'fake/fake', thinking: 'off', system: [], tools: [],
      messages: [visible, answer, current], signal: new AbortController().signal,
    };
    //M 模拟前台插件只挑出本轮可见的历史，压缩请求也只能使用这份消息。
    await ctx.serial('session/before-model', request);
    expect(asked).toContain('本轮可见的旧消息');
    expect(asked).not.toContain('已从本轮排除的历史');
    expect(piAi.contentText(request.messages[0]!.content)).toContain('本轮可见摘要');
    expect(request.messages.at(-1)).toBe(current);
  });

  test('裁剪等待目录窗口，目录无响应时使用手写窗口', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(makeResources(5000));
    await ctx.plugin(toolsModule.Tools);
    await ctx.plugin(sessionsModule.Sessions);
    await ctx.plugin(dbPlugin);
    await ctx.plugin(contextFitPlugin, { keep: 1, ratio: 1, summary: false, compress: false });

    const session = ctx.sessions.create({ kind: 'work', bot: '助手' });
    const oldMessage: piAi.Message = { role: 'user', content: '旧'.repeat(300), timestamp: 1 };
    const lastMessage: piAi.Message = { role: 'user', content: '当前问题', timestamp: 2 };
    const messages = [oldMessage, lastMessage];
    const request: sessionsModule.ChatRequest = {
      session,
      model: 'fake/fake',
      thinking: 'off',
      system: [],
      tools: [],
      messages,
      signal: new AbortController().signal,
    };
    const stop = events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', (request) => {
      if (request.action !== 'find') return {};

      const { model } = request;
      return {
        info: { id: model, name: model, kind: 'chat' as const, contextWindow: 100, thinking: [], price: { input: 0, output: 0 } },
      };
    });

    await ctx.serial('session/before-model', request);
    expect(request.messages).not.toContain(oldMessage);
    expect(request.messages).toContain(lastMessage);

    stop();
    request.messages = messages;
    await ctx.serial('session/before-model', request);
    expect(request.messages).toBe(messages);
  });

  test('work 会话 done 时触发 Summary 小会话写回 row.summary；summary:false 时不触发', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(makeResources(128000));
    await ctx.plugin(toolsModule.Tools);
    await ctx.plugin(sessionsModule.Sessions);
    await ctx.plugin(dbPlugin);
    await ctx.plugin(contextFitPlugin, { compress: false, summary: true });

    let summaryAsked = 0;
    ctx.on('session/before-model', (request) => {
      if (request.session.row.kind === 'summary') {
        summaryAsked += 1;
        request.answer = piAi.fauxAssistantMessage('完成合同金额核对并返回结论。');
        return;
      }
      request.answer = piAi.fauxAssistantMessage('合同金额为 36 万元。');
    });

    const session = ctx.sessions.create({ kind: 'work', bot: '助手' });
    session.queueUserMessage('帮我核对合同金额');
    await session.run();
    await Bun.sleep(30);
    expect(summaryAsked).toBe(1);
    expect(session.row.summary).toBe('完成合同金额核对并返回结论。');
  });

  test('session/before-model 严格先 Compress 再 ContextFit（顺序反了会把超长工具结果复原）', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    //M 窗口 1600 * 0.9 ≈ 1440 token：省略掉 c1 的 6000 字（约 2000 token）后能放进预算，不丢对话段。
    await ctx.plugin(makeResources(1600));
    await ctx.plugin(toolsModule.Tools);
    await ctx.plugin(sessionsModule.Sessions);
    await ctx.plugin(dbPlugin);
    await ctx.plugin(contextFitPlugin, { keep: 1, ratio: 0.9, summary: false, compress: { ratio: 0.8, keep: 4 } });

    let capturedWorkMessages: piAi.Message[] = [];
    let compressCalls = 0;
    ctx.on('session/before-model', (request) => {
      if (request.session.row.kind === 'compress') {
        compressCalls += 1;
        request.answer = piAi.fauxAssistantMessage('摘要：先前核对过旧订单。');
        return;
      }
      capturedWorkMessages = [...request.messages];
      request.answer = piAi.fauxAssistantMessage('最终答复完成');
    });

    const session = ctx.sessions.create({ kind: 'work', bot: '助手' });
    session.row.messages = [
      { role: 'user', content: '先查旧订单', timestamp: 1 },
      fakeAssistantWithUsage('旧订单已核对', 5000),
      { role: 'user', content: '再查当前明细', timestamp: 2 },
      fakeToolCallMessage('c1', 'read', 5000),
      fakeToolResultMessage('c1', 'read', 'B'.repeat(6000)),
      fakeToolCallMessage('c2', 'read', 5000),
      fakeToolResultMessage('c2', 'read', '短结果保留'),
    ];
    session.queueUserMessage('给出结论');
    await session.run();

    //M Compress 必须先运行：首条变成压缩摘要消息；同时 ContextFit 必须紧跟其后运行，把 c1 的 6000 字替换成已省略！
    expect(compressCalls).toBe(1);
    expect(capturedWorkMessages.length).toBeGreaterThan(0);
    expect(piAi.contentText(capturedWorkMessages[0]!.content)).toContain('摘要：先前核对过旧订单。');
    const c1AfterFit = capturedWorkMessages.find((m) => m.role === 'toolResult' && m.toolCallId === 'c1');
    const c2AfterFit = capturedWorkMessages.find((m) => m.role === 'toolResult' && m.toolCallId === 'c2');
    expect(c1AfterFit).toBeDefined();
    expect(piAi.contentText(c1AfterFit!.content)).toContain('工具结果已省略');
    expect(piAi.contentText(c2AfterFit!.content)).toBe('短结果保留');
  });

  test('启动迁移沿用升级前的 compress_log 摘要和消息边界', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(makeResources(128000));
    await ctx.plugin(toolsModule.Tools);
    await ctx.plugin(sessionsModule.Sessions);
    const session = ctx.sessions.create({ kind: 'work', bot: '助手' });
    session.row.messages = [
      { role: 'user', content: '第一次聊天的全文', timestamp: 1 },
      { role: 'user', content: '摘要后的新消息', timestamp: 2 },
    ];

    //M 先按旧版建表方式存一条跨启动的摘要，再挂新版两个插件。
    const client = ctx.resources.db;
    const legacy = 'CREATE TABLE compress_log (session TEXT PRIMARY KEY, upto INTEGER NOT NULL, summary TEXT NOT NULL)';
    client.exec(legacy);
    const insert = client.query('INSERT INTO compress_log (session, upto, summary) VALUES (?, ?, ?)');
    insert.run(session.id, 1, '旧库保存的摘要');
    await ctx.plugin(dbPlugin);
    const config = { summary: false };
    await ctx.plugin(contextFitPlugin, config);

    //M 无需重新压缩，模型首条消息直接使用已有摘要。
    const messages: string[] = [];
    ctx.on('session/before-model', (request) => {
      for (const item of request.messages) {
        messages.push(piAi.contentText(item.content));
      }
      request.answer = piAi.fauxAssistantMessage('收到');
    });
    await session.run();

    expect(messages[0]).toContain('旧库保存的摘要');
    expect(messages).toContain('摘要后的新消息');
    expect(messages).not.toContain('第一次聊天的全文');
  });
});
