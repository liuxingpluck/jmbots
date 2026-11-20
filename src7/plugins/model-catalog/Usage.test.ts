/** 离线验证用量查询事件，以及模型清单应答或缺席时的记账。 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fastify from 'fastify';
import * as catalogPlugin from './index.ts';
import type { Session } from '../../Sessions.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as usagePlugin from './Usage.ts';


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

const query = { sessions: ['session-1'], from: 0, to: Number.MAX_SAFE_INTEGER, limit: 10 };
const eventOptions = {
  timeoutMs: 1000,
  onFallback: (reason: events.FallbackReason) => ({ requestId: reason, rows: [], truncated: false }),
};

/** 测试只用内存库，不依赖运行实例。 */
class FakeResources extends cordis.Service {
  /** 每个测试使用独立内存数据库。 */
  readonly db = new Database(':memory:');
  /** 模型介绍目录也放测试自己的临时根，不接触运行时目录。 */
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-merge-'));
  /** 没有供应商，不发起真实联网请求。 */
  readonly raw = {};
  /** 空模型供应商表，供宿主入口遍历。 */
  readonly config = { providers: {} };

  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
    closers.unshift(() => this.db.close());
    //M 最后只删除这个测试自己创建的临时根目录。
    closers.unshift(() => fs.rmSync(this.root, { recursive: true, force: true }));
  }
}


test('用量事件返回按模型价格入账的调用，目录缺席时按零计费', async () => {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources);
  //M 子模块不再是独立插件，测试用与原入口相同的resources依赖创建服务。
  const plugin = {
    inject: ['resources'],
    apply: (sub: cordis.Context): void => {
      //M 只挂计量子模块，模型目录的价格回执由本例自行提供。
      new usagePlugin.Usage(sub);
    },
  };
  await ctx.plugin(plugin);

  const stop = events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', (request) => {
    if (request.action !== 'find') return {};

    const { model } = request;
    return {
      info: {
        id: model,
        name: model,
        kind: 'chat' as const,
        contextWindow: 1000,
        thinking: [],
        price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.4 },
      },
    };
  });
  const session = { id: 'session-1', row: { bot: '助手', kind: 'work' } } as Session;
  const reply = piAi.fauxAssistantMessage('完成');
  const usage = { ...reply.usage, input: 1000000, output: 500000, cacheRead: 1000000, cacheWrite: 500000 };
  const message = { ...reply, usage, durationMs: 12 };
  const model = `${reply.provider}/${reply.model}`;

  //M 等本轮事件投递和入账完成后，再卸掉模型目录。
  ctx.emit('session/new-message', session, message);
  await Bun.sleep(0);
  stop();

  //M 同样的非零用量没有价格时要留下记录，失败尝试也单独记一行。
  ctx.emit('session/new-message', session, message);
  ctx.emit('session/model-failed', { session, model, ms: 4, error: '测试连接失败' });
  await Bun.sleep(0);

  const firstPage = { ...query, limit: 2 };
  const result = await events.requestEvent(ctx, 'model-catalog/usage', 'model-catalog/usage-result', firstPage, eventOptions);
  expect(result.requestId).toStartWith('req_');
  expect(result.rows.map((row) => row.cost)).toEqual([2.3, 0]);
  expect(result.truncated).toBe(true);

  const all = await events.requestEvent(ctx, 'model-catalog/usage', 'model-catalog/usage-result', query, eventOptions);
  expect(all.rows[2]).toMatchObject({ ok: false, input: 0, cost: 0, ms: 4, error: '测试连接失败' });
  expect(all.truncated).toBe(false);
});

test('用量插件未挂载时查询退回空列表', async () => {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  const result = await events.requestEvent(ctx, 'model-catalog/usage', 'model-catalog/usage-result', query, eventOptions);
  expect(result).toEqual({ requestId: 'unhandled', rows: [], truncated: false, fallback: 'unhandled' });
});


/** 宿主声明 sessions 依赖，本测试不发起会话或模型调用。 */
class FakeSessions extends cordis.Service {
  /** @param ctx 测试上下文；副作用：提供依赖服务名 sessions。 */
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
  }
}


/** 可选 HTTP 在模型插件启动之后出现，验证路由仍被挂上。 */
class FakeHttp extends cordis.Service {
  /** 只接受 inject 请求的内存 Fastify 实例，不监听端口。 */
  readonly app = fastify.default();

  /** @param ctx 测试上下文；副作用：提供 HTTP 实例并登记关闭清理。 */
  constructor(ctx: cordis.Context) {
    super(ctx, 'http');
    //M 关闭测试自己的 Fastify，不影响项目中正在运行的服务。
    closers.unshift(() => this.app.close());
  }
}


test('model-catalog自动挂用量，晚到的HTTP保持路径，卸载撤掉服务与监听', async () => {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources);
  await ctx.plugin(FakeSessions);
  let scope: cordis.Context | undefined;
  const config: catalogPlugin.ModelCatalogConfig = { fallback: false, usage: {} };

  //M 调真实宿主入口；保留其插件作用域，用来单独卸载而不关闭测试数据库。
  const plugin = {
    inject: catalogPlugin.inject,
    apply: (sub: cordis.Context): void => {
      scope = sub;
      //M 必须沿用宿主的显式inject，不能用无依赖的测试包装绕过Cordis边界。
      catalogPlugin.apply(sub, config);
    },
  };
  await ctx.plugin(plugin);
  expect(ctx.get('usage')).toBeInstanceOf(usagePlugin.Usage);
  expect(ctx.get('modelCatalog')).toBeDefined();

  //M 模型目录与计量均无 HTTP 也可先启动，HTTP 之后出现只挂一份原路径。
  await ctx.plugin(FakeHttp);
  await Bun.sleep(0);
  const app = ctx.http.app;
  const response = await app.inject({ method: 'GET', url: '/api/usage' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ by: 'day', group: 'model', rows: [] });
  const invalid = await app.inject({ method: 'GET', url: '/api/usage?by=year' });
  expect(invalid.statusCode).toBe(400);

  const session = { id: 'session-1', row: { bot: '助手', kind: 'work' } } as Session;
  const message = piAi.fauxAssistantMessage('宿主记账');
  ctx.emit('session/new-message', session, message);
  const model = `${message.provider}/${message.model}`;
  ctx.emit('session/model-failed', { session, model, ms: 1, error: '离线测试' });
  await Bun.sleep(0);
  const result = await events.requestEvent(ctx, 'model-catalog/usage', 'model-catalog/usage-result', query, eventOptions);
  expect(result.rows).toHaveLength(2);
  expect(result.rows.map((row) => row.ok)).toEqual([true, false]);
  expect(result.rows.map((row) => row.cost)).toEqual([0, 0]);

  //M 只卸载模型插件作用域，确认服务、查询响应器与计量监听都撤销。
  expect(scope).toBeDefined();
  await scope!.fiber.dispose();
  expect(ctx.get('usage')).toBeUndefined();
  const gone = await events.requestEvent(ctx, 'model-catalog/usage', 'model-catalog/usage-result', query, eventOptions);
  expect(gone.requestId).toBe('unhandled');
  ctx.emit('session/new-message', session, message);
  await Bun.sleep(0);
  const count = ctx.resources.db.query('SELECT COUNT(*) AS n FROM model_usage').get();
  expect(count).toEqual({ n: 2 });
});


test('usage空配置入口拒绝非法类型和未定义字段，早于数据库或模型副作用', () => {
  const values = [null, false, [], { unknown: true }];
  for (const value of values) {
    const config = { usage: value } as unknown as catalogPlugin.ModelCatalogConfig;
    const ctx = {} as cordis.Context;
    //G 非法配置必须先报 usage 的错误，不能因缺 resources 等依赖而走到业务层。
    const apply = () => catalogPlugin.apply(ctx, config);
    expect(apply).toThrow('model-catalog.config.usage');
  }
});
