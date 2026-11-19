/**
 * session-context（主插件 context-fit，并入 compress、summary）离线测试：
 *   1. 纯函数 estimate / fit（先省略旧工具结果，仍超再按段裁剪并保留最后用户话）；
 *   2. Summary 在 work 会话进入 done 时触发 summary 小会话并写回 row.summary，compress/summary 开关与非法配置校验；
 *   3. 同一 apply 内的 session/request 严格顺序：Compress 先压缩并替换 request.messages，ContextFit 再在预算内省略旧工具结果。
 * 跑法：bun test src7/plugins/context-fit
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as dbPlugin from '../db/index.ts';
import * as contextFitPlugin from './index.ts';


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 供 context-fit、Compress 与 Sessions 使用的最小 Resources 服务。 */
function makeResources(contextWindow: number) {
  return class FakeResources extends cordis.Service {
    readonly db = new Database(':memory:');
    readonly config = {
      defaultModel: 'fake/fake',
      thinking: 'low',
      retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
      providers: {},
    };

    constructor(ctx: cordis.Context) {
      super(ctx, 'resources');
    }

    getModel(): { contextWindow: number } {
      return { contextWindow };
    }
  };
}


/** 构造一条带完整 usage 的假模型消息。 */
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


/** 构造一条工具结果消息。 */
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

    expect(contextFitPlugin.readCompressSettings(undefined)).toEqual({ enabled: true, at: 200000, keep: 6 });
    expect(contextFitPlugin.readCompressSettings(false).enabled).toBe(false);
    expect(() => contextFitPlugin.readCompressSettings('bad')).toThrow();
    expect(() => contextFitPlugin.readCompressSettings({ at: 0 })).toThrow();
    expect(() => contextFitPlugin.readCompressSettings({ keep: -1 })).toThrow();

    const ctx = new cordis.Context();
    expect(() => contextFitPlugin.apply(ctx, { keep: -1 })).toThrow();
    expect(() => contextFitPlugin.apply(ctx, { ratio: 0 })).toThrow();
    expect(() => contextFitPlugin.apply(ctx, { ratio: 1.2 })).toThrow();
  });
});


describe('session-context 集成：Summary 与 Compress -> ContextFit 顺序', () => {
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

    await ctx.serial('session/request', request);
    expect(request.messages).not.toContain(oldMessage);
    expect(request.messages).toContain(lastMessage);

    stop();
    request.messages = messages;
    await ctx.serial('session/request', request);
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
    ctx.on('session/request', (request) => {
      if (request.session.row.kind === 'summary') {
        summaryAsked += 1;
        request.answer = piAi.fauxAssistantMessage('完成合同金额核对并返回结论。');
        return;
      }
      request.answer = piAi.fauxAssistantMessage('合同金额为 36 万元。');
    });

    const session = ctx.sessions.create({ kind: 'work', bot: '助手' });
    session.add('帮我核对合同金额');
    await session.run();
    await Bun.sleep(30);
    expect(summaryAsked).toBe(1);
    expect(session.row.summary).toBe('完成合同金额核对并返回结论。');
  });

  test('session/request 严格先 Compress 再 ContextFit（顺序反了会把超长工具结果复原）', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    //M 窗口 1600 * 0.9 ≈ 1440 token：省略掉 c1 的 6000 字（约 2000 token）后能放进预算，不丢对话段。
    await ctx.plugin(makeResources(1600));
    await ctx.plugin(toolsModule.Tools);
    await ctx.plugin(sessionsModule.Sessions);
    await ctx.plugin(dbPlugin);
    await ctx.plugin(contextFitPlugin, { keep: 1, ratio: 0.9, summary: false, compress: { at: 1000, keep: 4 } });

    let capturedWorkMessages: piAi.Message[] = [];
    let compressCalls = 0;
    ctx.on('session/request', (request) => {
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
    session.add('给出结论');
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
    const config = { summary: false, compress: { at: 200000, keep: 6 } };
    await ctx.plugin(contextFitPlugin, config);

    //M 无需重新压缩，模型首条消息直接使用已有摘要。
    const messages: string[] = [];
    ctx.on('session/request', (request) => {
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
