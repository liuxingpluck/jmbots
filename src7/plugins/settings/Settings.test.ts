/** 离线验证设置路由通过事件核对模型、读取启动时间及关闭 HTTP。 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as events from '../../utils/RequestEvent.ts';
import * as settings from './index.ts';


const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});


/** 挂真实设置路由和内存事件总线，配置与记忆全部写测试的临时目录。 */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-settings-test-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.yaml'), [
    'providers:',
    '  mock:',
    '    base_url: http://127.0.0.1:9',
    'default_model: mock/listed',
    'bots: []',
    '',
  ].join('\n'));

  const ctx = new cordis.Context();
  const app = fastify.default();
  cleanups.push(() => app.close(), () => ctx.fiber.dispose());

  const bots = new Map<string, { memory: string }>();
  ctx.provide('resources', {
    root,
    config: { providers: { mock: {} } },
    dir: (...segments: string[]) => {
      const target = path.join(root, ...segments);
      fs.mkdirSync(target, { recursive: true });
      return target;
    },
  });
  ctx.provide('http', { app });
  ctx.provide('bots', {
    get: (bot: string) => bots.get(bot),
    add: ({ name }: { name: string }) => {
      const bot = { memory: fs.mkdtempSync(path.join(root, 'bot-memory-')) };
      bots.set(name, bot);
      return bot;
    },
  });
  await ctx.plugin(settings);
  return { ctx, app };
}


/** 记录重启路径的进程操作，测试不拉起或退出实际进程。 */
function mockRestart(order: string[]) {
  const original = process.env['JMBOTS_SUPERVISED'];
  delete process.env['JMBOTS_SUPERVISED'];
  const finished = Promise.withResolvers<void>();
  const exit = spyOn(process, 'exit').mockImplementation((() => {
    order.push('exit');
    finished.resolve();
  }) as typeof process.exit);
  const spawn = spyOn(childProcess, 'spawn').mockImplementation((() => {
    order.push('spawn');
    return { pid: 123, unref: () => undefined };
  }) as unknown as typeof childProcess.spawn);
  cleanups.push(() => {
    exit.mockRestore();
    spawn.mockRestore();
    if (original !== undefined) {
      process.env['JMBOTS_SUPERVISED'] = original;
    }
  });
  return { spawn, exit, finished: finished.promise };
}


test('模型目录应答时校验模型，明确查不到则拒绝新建', async () => {
  const { ctx, app } = await setup();
  const models: string[] = [];
  events.onRequestEvent(ctx, 'model-catalog/request', 'model-catalog/result', (request) => {
    models.push(request.model);
    if (request.model !== 'mock/listed') return {};

    return {
      info: {
        id: request.model,
        name: '测试模型',
        kind: 'chat' as const,
        contextWindow: 128000,
        thinking: ['off'],
        price: { input: 0, output: 0 },
      },
    };
  });

  const listed = await app.inject({ method: 'POST', url: '/api/bots', payload: { name: '在清单', model: 'mock/listed' } });
  expect(listed.statusCode).toBe(200);
  const missing = await app.inject({ method: 'POST', url: '/api/bots', payload: { name: '缺型号', model: 'mock/missing' } });
  expect(missing.statusCode).toBe(400);
  expect(missing.json<{ error: string }>()).toEqual({ error: '模型清单里没有 mock/missing' });
  expect(models).toEqual(['mock/listed', 'mock/missing']);
});

test('没有模型目录应答时只校验供应商，两个并发新建保留各自记录', async () => {
  const { app } = await setup();
  const [first, second] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/bots', payload: { name: '机器人甲', model: 'mock/first' } }),
    app.inject({ method: 'POST', url: '/api/bots', payload: { name: '机器人乙', model: 'mock/second' } }),
  ]);
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);

  const response = await app.inject({ method: 'GET', url: '/api/settings' });
  expect(response.json().config.bots).toEqual(expect.arrayContaining([
    { name: '机器人甲', model: 'mock/first', language: 'zh' },
    { name: '机器人乙', model: 'mock/second', language: 'zh' },
  ]));

  const bad = await app.inject({ method: 'POST', url: '/api/bots', payload: { name: '坏供应商', model: 'unknown/model' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json<{ error: string }>()).toEqual({ error: '模型 unknown/model 的供应商不在 providers 里' });
});

test('探活事件无人应答时返回错误，释放重启入口', async () => {
  const { ctx, app } = await setup();
  const order: string[] = [];
  const restart = mockRestart(order);
  const input = { method: 'POST', url: '/api/settings/apply' } as const;
  const unavailable = await app.inject(input);
  const retries = await app.inject(input);
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json().error).toContain('读取服务启动时间失败');
  expect(retries.statusCode).toBe(503);

  events.onRequestEvent(ctx, 'http/request', 'http/result', () => ({ ok: false, error: '模拟探活失败' }));
  const failed = await app.inject(input);
  expect(failed.statusCode).toBe(503);
  expect(failed.json<{ error: string }>()).toEqual({ error: '模拟探活失败' });
  expect(restart.spawn).not.toHaveBeenCalled();
  expect(restart.exit).not.toHaveBeenCalled();
});

test.each([
  { closeHasListener: true, wants: ['inject', 'close', 'close-result', 'spawn', 'exit'] },
  { closeHasListener: false, wants: ['inject', 'close', 'spawn', 'exit'] },
])('探活应答后会请求关闭，关闭监听状态为 $closeHasListener', async ({ closeHasListener, wants }) => {
  const { ctx, app } = await setup();
  const order: string[] = [];
  const restart = mockRestart(order);
  ctx.on('http/request', (request) => { order.push(request.action); });
  events.onRequestEvent(ctx, 'http/request', 'http/result', (request) => {
    if (request.action === 'close') {
      order.push('close-result');
      return { ok: true };
    }
    expect(request).toMatchObject({ method: 'GET', url: '/api/ui/info' });
    return { ok: true, statusCode: 200, body: '{"startedAt":42}' };
  }, {
    filter: (request) => request.action === 'inject' || closeHasListener,
  });

  const input = { method: 'POST', url: '/api/settings/apply' } as const;
  const response = await app.inject(input);
  if (response.statusCode === 200) {
    const duplicate = await app.inject(input);
    await restart.finished;
    expect(duplicate.statusCode).toBe(409);
  }
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: true, startedAt: 42 });
  expect(order).toEqual([...wants]);
}, 12_000);
