/**
 * 基地调用方的回归：晚挂服务不漏用，独立界面仍可读，故障重启不退出进程。
 * 跑法：bun test ./src7/plugins/base-bridge/Consumers.test.ts
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import fastify from 'fastify';
import * as notify from '../notify/index.ts';
import * as settings from '../settings/index.ts';
import * as webApi from '../web-api/index.ts';

//M 工具只在测试里直接调用，不进入模型或会话执行器。
interface Tool {
  definition: { name: string };
  run(args: Record<string, unknown>): unknown;
}

//M 调用方使用内存库和 Fastify inject；覆盖地址用例另起临时假目标，结束后一起释放。
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

//M 最小上下文仅记录工具、事件和可选服务；配置路径只拼出来，不创建或读取文件。
function world(allowRestart = false) {
  const app = fastify();
  const db = new Database(':memory:');
  const services = new Map<string, unknown>();
  const tools = new Map<string, Tool>();
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const traces: unknown[][] = [];
  closers.push(async () => {
    await app.close();
    db.close();
  });
  const ctx = {
    resources: { db, root: path.join(os.tmpdir(), 'jm-base-consumers-unused'), raw: { server: { port: 32086 } } },
    http: { app },
    tools: { register: (tool: Tool) => tools.set(tool.definition.name, tool) },
    bots: { channel: () => () => undefined },
    sessions: { find: () => [] },
    get: (name: string) => services.get(name),
    effect: (start: () => unknown) => start(),
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      const handlers = listeners.get(name) ?? [];
      handlers.push(listener);
      listeners.set(name, handlers);
    },
    emit: (...args: unknown[]) => {
      //M 重启路径先发这条 trace 再安排退出；即便回归误入成功分支，也在安排退出之前中止。
      if (!allowRestart && args[0] === 'trace' && args[1] === 'Settings.restart') throw new Error('测试禁止实际重启');
      traces.push(args);
    },
  } as unknown as cordis.Context;
  return { ctx, app, services, tools, listeners, traces };
}

describe('基地调用方', () => {
  //M notify 在 apply 时没有基地服务，稍后挂上仍能用；默认只传相对路径。
  test('通知工具用时现取基地服务', async () => {
    const { ctx, services, tools } = world();
    notify.apply(ctx, {});
    const tool = tools.get('notify_user');
    if (tool === undefined) throw new Error('没有登记 notify_user');
    const notice = { title: '测试', body: '稍后挂基地' };
    expect(await tool.run(notice)).toBe('没挂 base-bridge，无法发送基地通知');
    const calls: unknown[][] = [];
    services.set('base', {
      postJson: async (...args: unknown[]) => {
        calls.push(args);
        return { status: 200, body: { ok: true } };
      },
    });
    expect(await tool.run(notice)).toBe('已发出通知');
    expect(calls).toEqual([['/notify', { ...notice, url: 'http://127.0.0.1:32086/' }, 3000]]);
  });

  //M 显式通知地址不依赖基地插件，真正发到临时假目标，避免只验证 mock 参数。
  test('没挂基地服务时，显式通知地址仍能收到通知', async () => {
    const remote = fastify();
    const received: unknown[] = [];
    closers.push(() => remote.close());
    remote.post('/desktop', async (request) => {
      received.push(request.body);
      return { ok: true };
    });
    const address = await remote.listen({ host: '127.0.0.1', port: 0 });
    const { ctx, services, tools } = world();
    notify.apply(ctx, { url: `${address}/desktop` });
    expect(services.has('base')).toBe(false);
    const tool = tools.get('notify_user');
    if (tool === undefined) throw new Error('没有登记 notify_user');
    const notice = { title: '独立通知', body: '只发到临时假目标' };
    expect(await tool.run(notice)).toBe('已发出通知');
    expect(received).toEqual([{ ...notice, url: 'http://127.0.0.1:32086/' }]);
  });

  //M 独立通知地址优先；工具说明失败原因，后台事件消化失败而不追加通知或跟踪。
  test('通知覆盖地址不丢失，基地断开时事件静默结束', async () => {
    const { ctx, services, tools, listeners, traces } = world();
    notify.apply(ctx, { url: '  https://notify.example/desktop  ' });
    const tool = tools.get('notify_user');
    if (tool === undefined) throw new Error('没有登记 notify_user');
    const calls: unknown[][] = [];
    services.set('base', {
      postJson: async (...args: unknown[]) => {
        calls.push(args);
        throw new Error('基地没响应');
      },
    });
    expect(await tool.run({ title: '测试', body: '失败会说明原因' })).toBe('基地没响应');
    const before = traces.length;
    for (const listener of listeners.get('approval/asked') ?? []) {
      expect(listener({ title: '待确认' })).toBeUndefined();
    }
    for (const listener of listeners.get('progress/update') ?? []) {
      expect(listener({ sessionId: 'base-consumers', id: 'notice-failure', stage: 'done', text: '任务完成' })).toBeUndefined();
    }
    //M 等 send 内部处理被拒绝的 Promise；未处理的拒绝会由测试运行器直接报错。
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call[0] === 'https://notify.example/desktop' && call[2] === 3000)).toBe(true);
    expect(traces).toHaveLength(before);
  });

  //M 后端信息与基地无关；同一后端在基地缺失、失败、恢复时 startedAt 保持一致。
  test('界面信息始终可读，基地恢复后带上壳子版本', async () => {
    const { ctx, app, services } = world();
    webApi.apply(ctx);
    const missing = await app.inject({ method: 'GET', url: '/api/ui/info' });
    const first = missing.json();
    expect(missing.statusCode).toBe(200);
    expect(first.startedAt).toBeGreaterThan(0);
    expect(first.shell).toBeNull();
    expect(first.server).toEqual({ version: first.version, builtAt: first.builtAt });
    services.set('base', {
      getJson: async () => {
        throw new Error('基地没响应');
      },
    });
    const offline = await app.inject({ method: 'GET', url: '/api/ui/info' });
    expect(offline.statusCode).toBe(200);
    expect(offline.json()).toEqual(first);
    const calls: unknown[][] = [];
    services.set('base', {
      getJson: async (...args: unknown[]) => {
        calls.push(args);
        return { status: 200, body: { version: '  test-shell  ', builtAt: 123 } };
      },
    });
    const online = await app.inject({ method: 'GET', url: '/api/ui/info' });
    expect(online.statusCode).toBe(200);
    expect(online.json()).toEqual({ ...first, shell: { version: 'test-shell', builtAt: 123 } });
    expect(calls).toEqual([['/version', 800]]);
  });

  //M 用退出替身验证守护模式的两个入口，避免结束测试进程。
  test('没有基地服务时守护重启退回本地退出', async () => {
    const previous = process.env['JMBOTS_SUPERVISED'];
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    process.env['JMBOTS_SUPERVISED'] = '1';
    try {
      for (const url of ['/api/service/restart', '/api/settings/apply']) {
        const { ctx, app, traces } = world(true);
        app.get('/api/ui/info', async () => ({ startedAt: 42 }));
        settings.apply(ctx);
        const response = await app.inject({ method: 'POST', url });
        expect(response.statusCode).toBe(200);
        expect(response.json<{ ok: boolean }>().ok).toBe(true);
        expect(traces.some((args) => args[1] === 'Settings.restart')).toBe(true);
      }
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(exit).toHaveBeenCalledTimes(2);
      exit.mockRestore();
      if (previous === undefined) delete process.env['JMBOTS_SUPERVISED'];
      else process.env['JMBOTS_SUPERVISED'] = previous;
    }
  });

  //M 只请求受守护模式的失败分支；环境变量恢复，且 ctx.emit 会阻止任何真实退出安排。
  test('请基地重启时基地没响应返回 503', async () => {
    const { ctx, app, services, traces } = world();
    app.get('/api/ui/info', async () => ({ startedAt: 42 }));
    settings.apply(ctx);
    const previous = process.env['JMBOTS_SUPERVISED'];
    process.env['JMBOTS_SUPERVISED'] = '1';
    try {
      const calls: unknown[][] = [];
      services.set('base', {
        postJson: async (...args: unknown[]) => {
          calls.push(args);
          throw new Error('基地没响应');
        },
      });
      const offline = await app.inject({ method: 'POST', url: '/api/service/restart' });
      expect(offline.statusCode).toBe(503);
      expect(offline.json<{ error: string }>()).toEqual({ error: '基地没响应' });
      expect(calls).toEqual([['/restart', {}, 15_000]]);
      expect(traces).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env['JMBOTS_SUPERVISED'];
      else process.env['JMBOTS_SUPERVISED'] = previous;
    }
  });
});
