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

/** 带主令牌的测试配置，核对要令牌的前缀。 */
class TokenResources extends FakeResources {
  override readonly raw = { server: { port: 1, token: 'secret', trusted_ips: ['192.0.2.12'] } };
}

test('别的机器访问 /programs/ 要令牌，和 /api/ 一样；本机免', async () => {
  const ctx = new cordis.Context();
  try {
    await ctx.plugin(TokenResources);
    await ctx.plugin(httpPlugin);
    ctx.http.app.get('/programs/demo/', (request) => ({ verified: ctx.http.isVerified(request) }));

    const remote = { method: 'GET', url: '/programs/demo/', remoteAddress: '192.168.1.5' } as const;
    const denied = await ctx.http.app.inject(remote);
    expect(denied.statusCode).toBe(401);

    const withToken = { ...remote, url: '/programs/demo/?token=secret' };
    const allowed = await ctx.http.app.inject(withToken);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<{ verified: boolean }>().verified).toBe(true);

    const local = await ctx.http.app.inject('/programs/demo/');
    expect(local.statusCode).toBe(200);
    expect(local.json<{ verified: boolean }>().verified).toBe(true);

    //G 受信地址仍可浏览，只有带有效令牌才标记为已核验的远程请求。
    const trusted = { ...remote, remoteAddress: '192.0.2.12' };
    const trustedBrowsing = await ctx.http.app.inject(trusted);
    expect(trustedBrowsing.statusCode).toBe(200);
    expect(trustedBrowsing.json<{ verified: boolean }>().verified).toBe(false);
    const trustedWithToken = { ...withToken, remoteAddress: trusted.remoteAddress };
    const trustedVerified = await ctx.http.app.inject(trustedWithToken);
    expect(trustedVerified.json<{ verified: boolean }>().verified).toBe(true);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('没有配置令牌的远程界面访问照旧放行，客户端头无法伪造核验标记', async () => {
  const ctx = new cordis.Context();
  try {
    await ctx.plugin(FakeResources);
    await ctx.plugin(httpPlugin);
    ctx.http.app.get('/programs/demo/', (request) => ({ verified: ctx.http.isVerified(request) }));
    const request = {
      method: 'GET' as const,
      url: '/programs/demo/',
      remoteAddress: '192.0.2.11',
      headers: { authorization: 'Bearer forged', 'x-jmbots-key': 'forged', 'x-forwarded-for': '127.0.0.1' },
    };
    const response = await ctx.http.app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ verified: boolean }>().verified).toBe(false);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('别的机器用编码地址（/%61pi/…）也要令牌：路由解码后命中的接口不能免令牌', async () => {
  const ctx = new cordis.Context();
  try {
    await ctx.plugin(TokenResources);
    await ctx.plugin(httpPlugin);
    ctx.http.app.get('/api/secret', () => '接口');
    ctx.http.app.get('/files/secret', () => '文件');
    ctx.http.app.get('/programs/demo/', () => '界面');
    //M 照网页插件的兜底路由，没对上的地址都落到这里，模式是 /*。
    ctx.http.app.get('/*', () => '网页');

    //G 修之前这几个都是 200：http 按原始地址查前缀，路由却解码后命中 /api/、/files/、/programs/。
    for (const url of ['/%61pi/secret', '/%66iles/secret', '/%70rograms/demo/']) {
      const remote = { method: 'GET', url, remoteAddress: '192.168.1.5' } as const;
      const denied = await ctx.http.app.inject(remote);
      expect(denied.statusCode).toBe(401);
    }

    //G 落到兜底 /* 的地址只要解码后在前缀下，也要令牌，不按兜底路由的模式放行。
    const fallback = { method: 'GET', url: '/%61pi/nothing', remoteAddress: '192.168.1.5' } as const;
    const fallbackDenied = await ctx.http.app.inject(fallback);
    expect(fallbackDenied.statusCode).toBe(401);

    //G 解不开的 %xx 按要令牌处理；路由自己也可能先回 400，总之不能是 200。
    const broken = { method: 'GET', url: '/%E0%A4%A/secret', remoteAddress: '192.168.1.5' } as const;
    const brokenResult = await ctx.http.app.inject(broken);
    expect([400, 401]).toContain(brokenResult.statusCode);

    //M 带令牌、本机来的照常能用；不在前缀下的网页照常免令牌。
    const withToken = { method: 'GET', url: '/%61pi/secret?token=secret', remoteAddress: '192.168.1.5' } as const;
    const allowed = await ctx.http.app.inject(withToken);
    expect(allowed.body).toBe('接口');
    const local = await ctx.http.app.inject('/%61pi/secret');
    expect(local.body).toBe('接口');
    const page = { method: 'GET', url: '/sessions/abc', remoteAddress: '192.168.1.5' } as const;
    const pageResult = await ctx.http.app.inject(page);
    expect(pageResult.body).toBe('网页');
  } finally {
    await ctx.fiber.dispose();
  }
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

test('停服拒绝远程、网页请求和与当前进程不匹配的请求', async () => {
  const ctx = new cordis.Context();
  try {
    await ctx.plugin(FakeResources);
    await ctx.plugin(httpPlugin);
    const route = { method: 'POST', url: '/api/service/stop' } as const;
    const headers = { 'x-jmbots-window': '1', 'x-jmbots-expected-pid': '0' };
    const remote = await ctx.http.app.inject({ ...route, headers, remoteAddress: '192.0.2.12' });
    const browser = await ctx.http.app.inject({ ...route, headers: { ...headers, origin: 'http://localhost' } });
    const wrongPid = await ctx.http.app.inject({ ...route, headers });
    expect(remote.statusCode).toBe(403);
    expect(browser.statusCode).toBe(403);
    expect(wrongPid.statusCode).toBe(409);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('合成主站先确认受理，等待 programs 和主库关闭后正常退出', async () => {
  //M 单开子进程和随机回环端口，退出只影响该子进程。
  const code = `
    import * as cordis from 'cordis';
    import * as http from './src7/plugins/http/index.ts';
    const ctx = new cordis.Context();
    const received = Promise.withResolvers();
    ctx.provide('resources', {
      raw: { server: { port: 1 } },
      dir: () => 'src7/plugins/http/fixtures-no-tokens',
      db: { close: () => console.log('db-closed') },
    });
    ctx.provide('programs', { shutdown: async () => {
      await received.promise;
      console.log('programs-closed');
    } });
    await ctx.plugin(http);
    const base = await ctx.http.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(base + '/api/service/stop', {
      method: 'POST',
      headers: { 'x-jmbots-window': '1', 'x-jmbots-expected-pid': String(process.pid) },
    });
    const body = await response.json();
    if (response.status !== 202 || body.pid !== process.pid) process.exit(2);
    console.log('accepted');
    received.resolve();
  `;
  const cmd = [process.execPath, '--eval', code];
  const child = Bun.spawn({
    cmd,
    env: { ...process.env, JMBOTS_SUPERVISED: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(8000),
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const [status, output, error] = await Promise.all([child.exited, stdout, stderr]);
  expect(status, error).toBe(0);
  expect(output.trim().split(/\r?\n/u)).toEqual(['accepted', 'programs-closed', 'db-closed']);
}, 10000);
