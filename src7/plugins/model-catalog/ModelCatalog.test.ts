/**
 * model-catalog（含并入的 Fallback / Queue）单元测试：
 *   1. 清单合并（手写 + list_models: false）与 model-catalog/cooldown 维护 limitedUntil（过期自动清除）；
 *   2. 真实 Sessions.run() 链路下：挂在前方的 session/before-model 插件先写 system，排在后面的 ModelFallback 接管调用 chat()；
 *      429 限流连续触发两次 session/model-failed 即掐断、发 model-catalog/cooldown（同步进 ModelCatalog）与 model-catalog/fallback，切备选成功；再次请求直接走 cooldown；
 *   3. 上下文超长（context-overflow）：按 ModelCatalog 窗口降序挑更大上下文候选；
 *   4. Queue 并发排队与取消信号，以及 config.fallback 入口校验和 fallback: false 关闭开关。
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as traceText from '../../../web/src/locales/Trace.ts';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as utils from '../../utils/index.ts';
import * as fallback from './Fallback.ts';
import * as checks from '../../utils/Checks.ts';
import type { FallbackInfo } from './Fallback.ts';
import { Queue } from './Queue.ts';
import * as catalogPlugin from './index.ts';


const closers: (() => Promise<unknown> | void)[] = [];
const catalogOptions = {
  timeoutMs: 1000,
  onFallback: (reason: events.FallbackReason) => ({ requestId: reason }),
};

const routeMissing = 'HTTP 400 {"error":{"message":"hy4free 服务信息找不到"}}';

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 搭建真实 Tools + Sessions + MockResources，再按先后挂载插件。 */
async function setupWorld(options: {
  raw?: Record<string, unknown>;
  pluginConfig?: catalogPlugin.ModelCatalogConfig;
  beforeMount?: (ctx: cordis.Context) => void;
  /** 先放进运行时目录 models/ 的模型介绍：文件名 → 内容。 */
  notes?: Record<string, string>;
} = {}): Promise<{
  ctx: cordis.Context;
  fallbackEvents: FallbackInfo[];
  cooldownEvents: catalogPlugin.CooldownInfo[];
}> {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  //M 临时运行时目录：模型介绍和评价（Notes.ts）在它下面建 models/。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'models'));
  utils.eachEntry(options.notes ?? {}, (file, text) => {
    fs.writeFileSync(path.join(root, 'models', file), text, 'utf8');
  });

  const providerConfig = {
    mock: { baseUrl: 'http://127.0.0.1:0', apiKey: '', api: 'openai-completions' as const },
  };
  const modelWindows: Record<string, number> = {
    'mock/primary': 128000,
    'mock/small': 64000,
    'mock/medium': 200000,
    'mock/huge': 256000,
  };
  const raw = options.raw ?? {
    providers: {
      mock: {
        list_models: false,
        models: {
          primary: { context_window: 128000, max_output_tokens: 4096, price: { input: 1, output: 2 } },
          small: { context_window: 64000, max_output_tokens: 4096, price: { input: 0, output: 0 } },
          medium: { context_window: 200000, max_output_tokens: 4096, price: { input: 1, output: 2 } },
          huge: { context_window: 256000, max_output_tokens: 4096, price: { input: 1, output: 2 } },
        },
      },
    },
  };

  class MockResources extends cordis.Service {
    readonly db = new Database(':memory:');
    readonly root = root;
    readonly raw = raw;
    readonly config = {
      defaultModel: 'mock/primary',
      sessionCacheMax: 500,
      thinking: 'low' as const,
      retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
      providers: providerConfig,
    };
    constructor(parent: cordis.Context) {
      super(parent, 'resources');
    }
    getModel(id: string): { contextWindow: number } {
      return { contextWindow: modelWindows[id] ?? 128000 };
    }
  }

  const fallbackEvents: FallbackInfo[] = [];
  const cooldownEvents: catalogPlugin.CooldownInfo[] = [];
  ctx.on('model-catalog/fallback', (info) => fallbackEvents.push(info));
  ctx.on('model-catalog/cooldown', (info) => cooldownEvents.push(info));

  await ctx.plugin(MockResources);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);

  if (options.beforeMount !== undefined) {
    options.beforeMount(ctx);
  }

  //M 默认夹具提供两级备选，个别用例可替换回退设置。
  const fallbackConfig = { chain: ['mock/medium', 'mock/huge'] };
  const pluginConfig = options.pluginConfig ?? { fallback: fallbackConfig };
  await ctx.plugin(catalogPlugin, pluginConfig);

  return { ctx, fallbackEvents, cooldownEvents };
}


test('1. ModelCatalog 清单合并与 model-catalog/cooldown 维护 limitedUntil', async () => {
  const world = await setupWorld();
  const list = world.ctx.modelCatalog.list();
  expect(list.map((item) => item.id)).toEqual(['mock/primary', 'mock/small', 'mock/medium', 'mock/huge']);
  expect(world.ctx.modelCatalog.find('mock/primary')?.limitedUntil).toBeUndefined();

  const future = Date.now() + 60_000;
  world.ctx.emit('model-catalog/cooldown', { model: 'mock/primary', until: future, reason: '429 rate limit' });
  expect(world.ctx.modelCatalog.find('mock/primary')?.limitedUntil).toBe(future);

  const expired = Date.now() - 1000;
  world.ctx.emit('model-catalog/cooldown', { model: 'mock/small', until: expired, reason: '429 expired' });
  expect(world.ctx.modelCatalog.find('mock/small')?.limitedUntil).toBeUndefined();
});

test('模型查询事件返回清单项，查不到模型时仍回执', async () => {
  const { ctx } = await setupWorld();
  const known = { action: 'find', model: 'mock/primary' } as const;
  const found = await events.requestEvent(ctx, 'model-catalog/request', 'model-catalog/result', known, catalogOptions);
  expect(found.info).toEqual(ctx.modelCatalog.find(known.model));
  expect(found.info?.contextWindow).toBe(128000);

  const unknown = { action: 'find', model: 'mock/missing' } as const;
  const missing = await events.requestEvent(ctx, 'model-catalog/request', 'model-catalog/result', unknown, catalogOptions);
  expect(missing.requestId).toStartWith('req_');
  expect(missing.info).toBeUndefined();
});

test('模型清单未挂载时查询立即走无人接单退路', async () => {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  const lookup = { action: 'find', model: 'mock/primary' } as const;
  const result = await events.requestEvent(ctx, 'model-catalog/request', 'model-catalog/result', lookup, catalogOptions);
  expect(result).toEqual({ requestId: 'unhandled', fallback: 'unhandled' });
});

test('prompt 事件：交回模型介绍评价和清单里有的模型的思考档；没有介绍时两段都是空串', async () => {
  const notes = {
    'mock__primary.md': '# mock/primary\n\n主力模型。\n',
    'other__model.md': '# other/model\n\n清单里没有。\n',
  };
  const { ctx } = await setupWorld({ notes });
  const ask = { action: 'prompt' } as const;
  const result = await events.requestEvent(ctx, 'model-catalog/request', 'model-catalog/result', ask, catalogOptions);
  expect(result.prompt).toContain('- mock/primary：主力模型。');
  expect(result.prompt).toContain('- other/model：清单里没有。');

  //M 思考档只写清单里查得到的模型。
  const levels = ctx.modelCatalog.find('mock/primary')?.thinking.join('、') ?? '';
  expect(result.levelsText).toBe(`能用的思考档（写 thinking 只能从里面挑）：\n- mock/primary：${levels}`);

  const empty = await setupWorld();
  const none = await events.requestEvent(empty.ctx, 'model-catalog/request', 'model-catalog/result', ask, catalogOptions);
  expect(none).toMatchObject({ prompt: '', levelsText: '' });
});

test('prompt 事件：读介绍出错时回空回执，调用方当没有介绍', async () => {
  const { ctx } = await setupWorld();
  //M 删掉 models/：getList 读目录抛错，onError 打日志、回不带 prompt 的回执，不等超时。
  fs.rmSync(path.join(ctx.resources.root, 'models'), { recursive: true, force: true });
  const ask = { action: 'prompt' } as const;
  const result = await events.requestEvent(ctx, 'model-catalog/request', 'model-catalog/result', ask, catalogOptions);
  expect(result.requestId).toStartWith('req_');
  expect(result.prompt).toBeUndefined();
  expect(result.levelsText).toBeUndefined();
});


test('2. 限流回退：前置插件先改 system，429 重试超 1 次掐断、发 cooldown 与 fallback，下轮直接走冷却', async () => {
  const seenModels: string[] = [];
  const seenSystems: string[][] = [];

  const world = await setupWorld({
    beforeMount: (ctx) => {
      //M 模拟排在前面的 prompt 等插件先向 request.system 加段话。
      ctx.on('session/before-model', (request) => {
        request.system.push('前置系统提示');
      });
    },
  });

  world.ctx.sessions.chat = async (request) => {
    seenModels.push(request.model);
    seenSystems.push([...request.system]);
    if (request.model === 'mock/primary') {
      //M 模拟底层 pi 重试 2 次（> RATE_LIMIT_RETRIES = 1）后由 ModelFallback 主动 abort 切换。
      world.ctx.emit('session/model-failed', { session: request.session, model: 'mock/primary', error: 'HTTP 429 rate limit retry after 30s', ms: 10 });
      world.ctx.emit('session/model-failed', { session: request.session, model: 'mock/primary', error: 'HTTP 429 rate limit retry after 30s', ms: 10 });
      throw new Error('aborted');
    }
    return piAi.fauxAssistantMessage(`由 ${request.model} 回复`);
  };

  //M 第 1 轮：primary 限流 → 记进冷却 → 切到 mock/medium 回复；且前置系统提示保留。
  const session1 = world.ctx.sessions.create({ kind: 't', bot: '测试', model: 'mock/primary' });
  session1.queueUserMessage('你好');
  await session1.run();

  expect(session1.row.state).toBe('done');
  expect(session1.row.reply).toBe('由 mock/medium 回复');
  expect(seenModels).toEqual(['mock/primary', 'mock/medium']);
  expect(seenSystems[1]).toContain('前置系统提示');
  expect(world.cooldownEvents.length).toBe(1);
  expect(world.cooldownEvents[0]?.model).toBe('mock/primary');
  expect(world.ctx.modelCatalog.find('mock/primary')?.limitedUntil).toBeGreaterThan(Date.now());
  expect(world.fallbackEvents.map((item) => ({ from: item.from, to: item.to, reason: item.reason }))).toEqual([
    { from: 'mock/primary', to: 'mock/medium', reason: 'rate-limit' },
  ]);

  //M 第 2 轮：mock/primary 仍在冷却期 → 不再尝试 primary，直接发 cooldown 并走 mock/medium。
  seenModels.length = 0;
  world.fallbackEvents.length = 0;
  const session2 = world.ctx.sessions.create({ kind: 't', bot: '测试', model: 'mock/primary' });
  session2.queueUserMessage('再来一次');
  await session2.run();

  expect(session2.row.state).toBe('done');
  expect(seenModels).toEqual(['mock/medium']);
  expect(world.fallbackEvents.map((item) => ({ from: item.from, to: item.to, reason: item.reason }))).toEqual([
    { from: 'mock/primary', to: 'mock/medium', reason: 'cooldown' },
  ]);
});


test('3. 上下文超长：过滤掉更小窗口候选并按窗口降序优先尝试最大模型', async () => {
  const seenModels: string[] = [];
  const world = await setupWorld({
    pluginConfig: {
      fallback: {
        chain: ['mock/small', 'mock/medium', 'mock/huge'],
      },
    },
  });

  world.ctx.sessions.chat = async (request) => {
    seenModels.push(request.model);
    if (request.model === 'mock/primary') {
      throw new Error('maximum context length exceeded');
    }
    return piAi.fauxAssistantMessage(`超大窗口 ${request.model}`);
  };

  const session = world.ctx.sessions.create({ kind: 't', bot: '测试', model: 'mock/primary' });
  session.queueUserMessage('长文');
  await session.run();

  expect(session.row.state).toBe('done');
  expect(session.row.reply).toBe('超大窗口 mock/huge');
  expect(seenModels).toEqual(['mock/primary', 'mock/huge']);
  expect(world.fallbackEvents[0]?.reason).toBe('context-overflow');
});

test.each([routeMissing, '400 service information not found'])('上游服务缺失时切到备用模型：%s', async (detail) => {
  const world = await setupWorld();
  const tried: string[] = [];
  const switchLines: { text: string; vars: Record<string, unknown> }[] = [];

  //M 用流水接收的同一个跟踪事件验证换模记录和文案占位符。
  world.ctx.on('trace', (where, text, _code, vars) => {
    if (where !== 'ModelFallback.onRequest') return;

    switchLines.push({ text, vars });
  });

  world.ctx.sessions.chat = async (request) => {
    tried.push(request.model);
    if (request.model === 'mock/primary') {
      throw new Error(detail);
    }
    return piAi.fauxAssistantMessage(request.model);
  };

  const session = world.ctx.sessions.create({ kind: 't', bot: '测试', model: 'mock/primary' });
  session.queueUserMessage('沿备用链继续');
  await session.run();

  expect(session.row.state).toBe('done');
  expect(session.row.reply).toBe('mock/medium');
  expect(tried).toEqual(['mock/primary', 'mock/medium']);
  expect(world.cooldownEvents).toHaveLength(0);
  expect(world.fallbackEvents).toEqual([
    { session, from: 'mock/primary', to: 'mock/medium', reason: 'upstream-unavailable' },
  ]);
  expect(switchLines).toEqual([{
    text: 'trace.modelCatalog.fallback.upstream-unavailable',
    vars: {
      session: session.id,
      bot: '测试',
      from: 'mock/primary',
      to: 'mock/medium',
      reason: 'upstream-unavailable',
    },
  }]);

  const line = switchLines[0]!;
  const parameters = traceText.getTraceParams(line.text, line.vars);
  const caption = traceText.getTraceText('zh', line.text, parameters);
  expect(caption).toBe('模型从 mock/primary 切到 mock/medium，上游服务信息找不到');
});

test.each([
  'HTTP 400 unknown parameter: service',
  'HTTP 401 unauthorized: service information not found (quota API)',
])('参数或鉴权失败直接保留原错误：%s', async (detail) => {
  const world = await setupWorld();
  const tried: string[] = [];
  world.ctx.sessions.chat = async (request) => {
    tried.push(request.model);
    throw new Error(detail);
  };

  const session = world.ctx.sessions.create({ kind: 't', bot: '测试', model: 'mock/primary' });
  session.queueUserMessage('失败直接返回');
  await session.run();

  expect(session.row.state).toBe('failed');
  expect(session.row.reply).toBe(`出错了：${detail}`);
  expect(tried).toEqual(['mock/primary']);
  expect(world.fallbackEvents).toHaveLength(0);
  expect(world.cooldownEvents).toHaveLength(0);
});

test('备用模型鉴权失败后保留原错误并停止后续尝试', async () => {
  const world = await setupWorld();
  const tried: string[] = [];
  const unauthorized = 'HTTP 401 invalid API key';
  world.ctx.sessions.chat = async (request) => {
    tried.push(request.model);
    if (request.model === 'mock/primary') {
      throw new Error(routeMissing);
    }
    throw new Error(unauthorized);
  };

  const session = world.ctx.sessions.create({ kind: 't', bot: '测试', model: 'mock/primary' });
  session.queueUserMessage('备用鉴权失败');
  await session.run();

  expect(session.row.state).toBe('failed');
  expect(session.row.reply).toBe(`出错了：${unauthorized}`);
  expect(tried).toEqual(['mock/primary', 'mock/medium']);
  expect(world.fallbackEvents).toHaveLength(1);
});

test('服务缺失耗尽备用链后汇总每次失败，连续换模按实际顺序记录', async () => {
  const fallbackConfig = {
    chain: ['mock/medium', 'mock/huge'],
    include_siblings: false,
  };
  const world = await setupWorld({ pluginConfig: { fallback: fallbackConfig } });
  const tried: string[] = [];
  world.ctx.sessions.chat = async (request) => {
    tried.push(request.model);
    throw new Error(routeMissing);
  };

  const session = world.ctx.sessions.create({ kind: 't', bot: '测试', model: 'mock/primary' });
  session.queueUserMessage('备用链耗尽');
  await session.run();

  expect(session.row.state).toBe('failed');
  expect(session.row.reply).toContain('换了 3 个模型都没成功');
  expect(session.row.reply).toContain('服务信息找不到');
  expect(tried).toEqual(['mock/primary', 'mock/medium', 'mock/huge']);
  expect(world.cooldownEvents).toHaveLength(0);
  expect(world.fallbackEvents).toEqual([
    { session, from: 'mock/primary', to: 'mock/medium', reason: 'upstream-unavailable' },
    { session, from: 'mock/medium', to: 'mock/huge', reason: 'upstream-unavailable' },
  ]);
});


test('4. Queue 并发上限与取消信号、fallback: false 开关与配置校验', async () => {
  const queue = new Queue({ perModel: 1, models: {}, providers: { p: 1 } });
  let releaseFirst = (): void => undefined;
  const firstHold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const runningFirst = queue.run('p/m1', async () => {
    await firstHold;
    return 'first';
  });

  const abortedController = new AbortController();
  const secondQueued = queue.run('p/m2', async () => 'second', abortedController.signal);
  abortedController.abort();
  await expect(secondQueued).rejects.toThrow('排队时被喊停了');

  releaseFirst();
  expect(await runningFirst).toBe('first');

  //M fallback: false 关闭回退，保持 ModelCatalog 目录仍可查。
  const disabledWorld = await setupWorld({ pluginConfig: { fallback: false } });
  expect(disabledWorld.ctx.modelCatalog.list().length).toBe(4);
  let fallbackRan = false;
  disabledWorld.ctx.sessions.chat = async () => {
    fallbackRan = true;
    throw new Error('HTTP 429 rate limit');
  };
  const session = disabledWorld.ctx.sessions.create({ kind: 't', bot: '测试', model: 'mock/primary' });
  session.queueUserMessage('不回退');
  await session.run();
  expect(fallbackRan).toBe(true);
  expect(disabledWorld.fallbackEvents.length).toBe(0);

  //M 非法子配置入口抛错。
  const badCtx = {
    resources: {
      raw: {},
      config: { defaultModel: 'mock/primary', providers: {} },
    },
  } as unknown as cordis.Context;
  expect(() => catalogPlugin.apply(badCtx, { fallback: { max_tries: -1 } })).toThrow('plugins[model-catalog].config.fallback.max_tries 要是不小于 0 整数');
});


test('回退忽略旧 engine，插件配置支持显式的链、0 和 false', async () => {
  const { ctx } = await setupWorld();
  ctx.resources.raw['engine'] = {
    fallback_chain: ['mock/huge'],
    fallback_max_tries: 1,
    fallback_include_siblings: false,
    rate_limit_cooldown_minutes: 1,
  };

  //M 只填旧键时按现有回退默认值处理。
  const defaults = fallback.readFallbackSettings(ctx, undefined);
  expect(defaults.chain).toEqual(['mock/primary']);
  expect(defaults.maxTries).toBe(5);
  expect(defaults.siblings).toBe(true);
  expect(defaults.cooldownMs).toBe(300_000);

  //M 新位置的 0 和 false 都是有效的显式配置。
  const config = { fallback: { chain: ['mock/small'], max_tries: 0, include_siblings: false, cooldown_minutes: 0 } };
  const settings = fallback.readFallbackSettings(ctx, config);
  expect(settings.chain).toEqual(['mock/small']);
  expect(settings.maxTries).toBe(0);
  expect(settings.siblings).toBe(false);
  expect(settings.cooldownMs).toBe(0);
});

test('骨架从 models 读取思考档和重试，旧 engine 不生效', () => {
  const shared = { providers: { mock: { base_url: 'http://127.0.0.1:9' } }, default_model: 'mock/primary' };
  const engine = { thinking: 'medium', retry: { times: 2, wait_ms: 25, timeout_ms: 6000 } };

  //M 只填旧键时使用默认值。
  const oldConfig = { ...shared, engine };
  const defaults = checks.checkConfig(oldConfig);
  expect(defaults.thinking).toBe('low');
  expect(defaults.retry).toEqual({ times: 5, waitMs: 3000, timeoutMs: 120_000 });

  //M 新配置缺项时各自使用默认值。
  const models = { thinking: 'high', retry: { times: 4 } };
  const currentConfig = { ...shared, engine, models };
  const current = checks.checkConfig(currentConfig);
  expect(current.thinking).toBe('high');
  expect(current.retry).toEqual({ times: 4, waitMs: 3000, timeoutMs: 120_000 });
});
