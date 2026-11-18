/** 离线验证用量查询事件，以及模型清单应答或缺席时的记账。 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as usagePlugin from './index.ts';


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
  readonly db = new Database(':memory:');

  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
    closers.unshift(() => this.db.close());
  }
}


test('用量事件返回按模型价格入账的调用，目录缺席时按零计费', async () => {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources);
  await ctx.plugin(usagePlugin);

  const stop = events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', ({ model }) => ({
    info: {
      id: model,
      name: model,
      kind: 'chat' as const,
      contextWindow: 1000,
      thinking: [],
      price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.4 },
    },
  }));
  const session = { id: 'session-1', row: { bot: '助手', kind: 'work' } } as Session;
  const reply = piAi.fauxAssistantMessage('完成');
  const usage = { ...reply.usage, input: 1000000, output: 500000, cacheRead: 1000000, cacheWrite: 500000 };
  const message = { ...reply, usage, durationMs: 12 };
  const model = `${reply.provider}/${reply.model}`;

  //M 等本轮事件投递和入账完成后，再卸掉模型目录。
  ctx.emit('session/message', session, message);
  await Bun.sleep(0);
  stop();

  //M 同样的非零用量没有价格时要留下记录，失败尝试也单独记一行。
  ctx.emit('session/message', session, message);
  ctx.emit('model/failed', { session, model, ms: 4, error: '测试连接失败' });
  await Bun.sleep(0);

  const firstPage = { ...query, limit: 2 };
  const result = await events.requestEvent(ctx, 'usage/list', 'usage/list-result', firstPage, eventOptions);
  expect(result.requestId).toStartWith('req_');
  expect(result.rows.map((row) => row.cost)).toEqual([2.3, 0]);
  expect(result.truncated).toBe(true);

  const all = await events.requestEvent(ctx, 'usage/list', 'usage/list-result', query, eventOptions);
  expect(all.rows[2]).toMatchObject({ ok: false, input: 0, cost: 0, ms: 4, error: '测试连接失败' });
  expect(all.truncated).toBe(false);
});

test('用量插件未挂载时查询退回空列表', async () => {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  const result = await events.requestEvent(ctx, 'usage/list', 'usage/list-result', query, eventOptions);
  expect(result).toEqual({ requestId: 'unhandled', rows: [], truncated: false });
});
