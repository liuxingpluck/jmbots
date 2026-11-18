/**
 * 免令牌来源地址的单元测试（2026-11-14 23:50 EST，用户：本机和网关 192.168.200.1 访问不用令牌，别的局域网、外网地址要令牌）。
 * 跑法：bun test src7/plugins/http/Trusted.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as events from '../../utils/RequestEvent.ts';
import * as httpPlugin from './index.ts';

const { trustedIp } = httpPlugin;

const eventOptions = {
  timeoutMs: 1000,
  onFallback: (reason: events.FallbackReason) => ({ requestId: '', ok: false, error: reason }),
};

/** HTTP 测试用的内存配置；注入请求只在 Fastify 进程内运行。 */
class FakeResources extends cordis.Service {
  readonly raw = { server: { port: 1 } };
  readonly pluginStatus = [];

  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }

  /** 用固定的测试路径模拟不存在的令牌文件。 */
  dir(): string {
    return 'src7/plugins/http/fixtures-no-tokens';
  }
}

describe('免令牌的来源地址', () => {
  const trusted = ['127.0.0.1', '::1', '192.168.200.1'];
  test('本机免', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2']) expect(trustedIp(ip, trusted)).toBe(true);
  });
  test('网关免（写在 trusted_ips 里）', () => {
    expect(trustedIp('192.168.200.1', trusted)).toBe(true);
    expect(trustedIp('::ffff:192.168.200.1', trusted)).toBe(true);
  });
  test('别的地址要令牌；不写 trusted_ips 时网关也要', () => {
    for (const ip of ['192.168.200.130', '192.168.1.5', '8.8.8.8', '10.0.0.1']) expect(trustedIp(ip, trusted)).toBe(false);
    expect(trustedIp('192.168.200.1', ['127.0.0.1', '::1'])).toBe(false);
  });
});

test('HTTP 插件应答注入请求及关闭请求', async () => {
  const ctx = new cordis.Context();
  try {
    await ctx.plugin(FakeResources);
    await ctx.plugin(httpPlugin);
    ctx.http.app.post('/probe', (_, reply) => reply.code(201).send('已收到'));

    const health = { action: 'inject', method: 'GET', url: '/api/health' } as const;
    const healthResult = await events.requestEvent(ctx, 'http/request', 'http/result', health, eventOptions);
    expect(healthResult.ok).toBe(true);
    expect(healthResult.statusCode).toBe(200);
    expect(JSON.parse(healthResult.body ?? '')).toEqual({ ok: true, problems: [] });

    const probe = { action: 'inject', method: 'POST', url: '/probe' } as const;
    const probeResult = await events.requestEvent(ctx, 'http/request', 'http/result', probe, eventOptions);
    expect(probeResult).toMatchObject({ ok: true, statusCode: 201, body: '已收到' });

    const close = { action: 'close', waitMs: 500 } as const;
    const closeResult = await events.requestEvent(ctx, 'http/request', 'http/result', close, eventOptions);
    expect(closeResult.ok).toBe(true);

    const closed = await events.requestEvent(ctx, 'http/request', 'http/result', health, eventOptions);
    expect(closed).toMatchObject({ ok: false, error: expect.any(String) });
    expect(closed.requestId).toStartWith('req_');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('HTTP 插件未挂载时使用无人接单退路', async () => {
  const ctx = new cordis.Context();
  try {
    const probe = { action: 'inject', method: 'GET', url: '/api/health' } as const;
    const result = await events.requestEvent(ctx, 'http/request', 'http/result', probe, eventOptions);
    expect(result).toEqual({ requestId: '', ok: false, error: 'unhandled' });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('关闭超过等待上限时回执失败，Fastify 继续关闭', async () => {
  const ctx = new cordis.Context();
  const finishClose = Promise.withResolvers<void>();
  const closingStarted = Promise.withResolvers<void>();
  try {
    await ctx.plugin(FakeResources);
    await ctx.plugin(httpPlugin);
    ctx.http.app.addHook('onClose', async () => {
      closingStarted.resolve();
      await finishClose.promise;
    });

    const close = { action: 'close', waitMs: 10 } as const;
    const pending = events.requestEvent(ctx, 'http/request', 'http/result', close, eventOptions);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: '等待 HTTP 关闭超时' });
    await closingStarted.promise;
  } finally {
    finishClose.resolve();
    await ctx.fiber.dispose();
  }
});
