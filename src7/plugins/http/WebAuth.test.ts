/**
 * 外网反向代理 Cookie 登录鉴权（WebAuth.ts）的单元测试。
 * 覆盖：本地/内网零打扰、X-External-Proxy: 1 拦截与静态页放行、scrypt/明文配置核验、
 * 30 天签名 Cookie 签发与防篡改、登出失效、单 IP 连续输错限速冷却、重启保持会话。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cordis from 'cordis';
import { afterEach, describe, expect, test } from 'bun:test';
import * as httpPlugin from './index.ts';
import * as webAuthModule from './WebAuth.ts';


/** 当前用例创建的临时目录，用例结束后统一清理。 */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


/** 在插件目录下创建隔离测试数据目录。 */
function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(import.meta.dir, '.webauth-test-'));
  tempDirs.push(dir);
  return dir;
}


/** 取出 Set-Cookie 头里的 `name=value` 段，供下一次请求放进 Cookie 请求头。 */
function extractCookiePair(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
  return (first.split(';')[0] ?? '').trim();
}


describe('外网反向代理 Cookie 鉴权', () => {
  test('本机与内网请求不带 X-External-Proxy: 1 时 required 恒为 false，照常放行', async () => {
    const dataDir = makeTempDataDir();
    const scryptHash = webAuthModule.hashPasswordScrypt('synthetic-pass-1', '00112233445566778899aabbccddeeff');
    const ctx = new cordis.Context();
    try {
      ctx.provide('resources', {
        raw: {
          server: {
            port: 1,
            token: 'lan-secret',
            trusted_ips: ['192.168.200.1', '192.168.200.130'],
            web_auth: { username: 'owner', password_scrypt: scryptHash },
          },
        },
        pluginStatus: [],
        ensureRuntimeDir: () => dataDir,
      });
      await ctx.plugin(httpPlugin);
      ctx.http.app.get('/api/work', (request) => ({ ok: true, verified: ctx.http.isVerified(request) }));

      //M 家里本机 127.0.0.1 直连：required 为 false，业务接口直接通过且已核验。
      const localStatus = await ctx.http.app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(localStatus.statusCode).toBe(200);
      expect(localStatus.json<unknown>()).toEqual({ required: false, authenticated: false });
      const localWork = await ctx.http.app.inject({ method: 'GET', url: '/api/work' });
      expect(localWork.statusCode).toBe(200);
      expect(localWork.json<unknown>()).toEqual({ ok: true, verified: true });

      //M 内网虚拟机直连 192.168.200.130：required 同样为 false，零打扰。
      const vmStatus = await ctx.http.app.inject({
        method: 'GET',
        url: '/api/auth/status',
        remoteAddress: '192.168.200.130',
      });
      expect(vmStatus.statusCode).toBe(200);
      expect(vmStatus.json<unknown>()).toEqual({ required: false, authenticated: false });
      const vmWork = await ctx.http.app.inject({
        method: 'GET',
        url: '/api/work',
        remoteAddress: '192.168.200.130',
      });
      expect(vmWork.statusCode).toBe(200);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  test('带 X-External-Proxy: 1 时未登录拦截 /api/*，放行健康检查与静态页，登录签 Cookie 后放行，登出失效', async () => {
    const dataDir = makeTempDataDir();
    const scryptHash = webAuthModule.hashPasswordScrypt('synthetic-pass-2', 'fedcba9876543210fedcba9876543210');
    const ctx = new cordis.Context();
    try {
      ctx.provide('resources', {
        raw: {
          server: {
            port: 1,
            token: 'lan-secret',
            trusted_ips: ['127.0.0.1', '192.168.200.1'],
            web_auth: { username: 'admin', password_scrypt: scryptHash },
          },
        },
        pluginStatus: [],
        ensureRuntimeDir: () => dataDir,
      });
      await ctx.plugin(httpPlugin);
      ctx.http.app.get('/api/work', (request) => ({ ok: true, verified: ctx.http.isVerified(request) }));
      ctx.http.app.get('/work-decision/', () => '<html>decision</html>');
      ctx.http.app.get('/assets/main.js', () => 'console.log(1)');

      const extHeaders = { 'x-external-proxy': '1', 'x-forwarded-proto': 'https' };

      //M 外网未登录：status 返回 required: true, authenticated: false。
      const statusBefore = await ctx.http.app.inject({
        method: 'GET',
        url: '/api/auth/status',
        remoteAddress: '192.168.200.1',
        headers: extHeaders,
      });
      expect(statusBefore.statusCode).toBe(200);
      expect(statusBefore.json<unknown>()).toEqual({ required: true, authenticated: false });

      //M 外网未登录：/api/health 和前端 HTML/JS 静态资源正常放行，保证能加载出 React 登录壳。
      const health = await ctx.http.app.inject({ method: 'GET', url: '/api/health', headers: extHeaders });
      expect(health.statusCode).toBe(200);
      const htmlPage = await ctx.http.app.inject({ method: 'GET', url: '/work-decision/', headers: extHeaders });
      expect(htmlPage.statusCode).toBe(200);
      const jsAsset = await ctx.http.app.inject({ method: 'GET', url: '/assets/main.js', headers: extHeaders });
      expect(jsAsset.statusCode).toBe(200);

      //G 外网未登录：业务接口（含 URL 编码写法）一律回 401 请先登录。
      for (const target of ['/api/work', '/%61pi/work']) {
        const denied = await ctx.http.app.inject({
          method: 'GET',
          url: target,
          remoteAddress: '192.168.200.1',
          headers: extHeaders,
        });
        expect(denied.statusCode).toBe(401);
        expect(denied.json<unknown>()).toEqual({ error: '请先登录', code: 'unauthorized' });
      }

      //G 密码错误返回 401，不下发有效会话。
      const badLogin = await ctx.http.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: extHeaders,
        payload: { username: 'admin', password: 'wrong-password' },
      });
      expect(badLogin.statusCode).toBe(401);
      expect(badLogin.json<unknown>()).toEqual({ error: '账号或密码不对' });

      //M 正确账号密码：返回 ok 并下发 30 天 HttpOnly + SameSite=Lax + Secure Cookie。
      const goodLogin = await ctx.http.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: extHeaders,
        payload: { username: 'admin', password: 'synthetic-pass-2' },
      });
      expect(goodLogin.statusCode).toBe(200);
      expect(goodLogin.json<unknown>()).toEqual({ ok: true, username: 'admin' });
      const rawSetCookie = String(goodLogin.headers['set-cookie'] ?? '');
      expect(rawSetCookie).toContain('HttpOnly');
      expect(rawSetCookie).toContain('SameSite=Lax');
      expect(rawSetCookie).toContain('Path=/');
      expect(rawSetCookie).toContain('Max-Age=2592000');
      expect(rawSetCookie).toContain('Secure');
      const cookiePair = extractCookiePair(goodLogin.headers['set-cookie']);

      //M 携带有效 Cookie 访问：status 显示已登录，业务接口放行且标记已核验。
      const authedHeaders = { ...extHeaders, cookie: cookiePair };
      const statusAfter = await ctx.http.app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: authedHeaders,
      });
      expect(statusAfter.json<unknown>()).toEqual({ required: true, authenticated: true, username: 'admin' });
      const workOk = await ctx.http.app.inject({
        method: 'GET',
        url: '/api/work',
        remoteAddress: '192.168.200.1',
        headers: authedHeaders,
      });
      expect(workOk.statusCode).toBe(200);
      expect(workOk.json<unknown>()).toEqual({ ok: true, verified: true });

      //G 即便外网已登录，本机专属的 /api/tokens 依然严格拒绝外网代理访问（403）。
      const tokensBlocked = await ctx.http.app.inject({
        method: 'GET',
        url: '/api/tokens',
        remoteAddress: '127.0.0.1',
        headers: authedHeaders,
      });
      expect(tokensBlocked.statusCode).toBe(403);

      //G 篡改 Cookie 签名后立即拒回 401。
      const tampered = await ctx.http.app.inject({
        method: 'GET',
        url: '/api/work',
        headers: { ...extHeaders, cookie: `${cookiePair}x` },
      });
      expect(tampered.statusCode).toBe(401);

      //M 退出登录：下发 Max-Age=0 清空 Cookie，之后不再通过鉴权。
      const logout = await ctx.http.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: authedHeaders,
      });
      expect(logout.statusCode).toBe(200);
      expect(String(logout.headers['set-cookie'] ?? '')).toContain('Max-Age=0');
      const clearedPair = extractCookiePair(logout.headers['set-cookie']);
      const afterLogout = await ctx.http.app.inject({
        method: 'GET',
        url: '/api/work',
        headers: { ...extHeaders, cookie: clearedPair },
      });
      expect(afterLogout.statusCode).toBe(401);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  test('单 IP 连续输错 10 次触发 60 秒限速冷却，30 天后过期，重启主站不冲掉未过期会话且改密即作废', async () => {
    const dataDir = makeTempDataDir();
    let clock = 1_700_000_000_000;
    const spec1 = webAuthModule.readWebAuthConfig(
      { username: 'ops', password: 'first-synthetic-password' },
      dataDir,
    );

    const ctx1 = new cordis.Context();
    let savedCookie = '';
    try {
      ctx1.provide('resources', {
        raw: { server: { port: 1 } },
        pluginStatus: [],
        ensureRuntimeDir: () => dataDir,
      });
      new httpPlugin.Http(ctx1, {
        port: 1,
        token: '',
        host: '127.0.0.1',
        trustedIps: ['127.0.0.1'],
        webAuth: spec1,
        now: () => clock,
      });
      ctx1.http.app.get('/api/secret', () => ({ ok: true }));

      const attackerHeaders = { 'x-external-proxy': '1', 'x-forwarded-for': '203.0.113.9' };
      //G 连续 10 次错误密码均返回 401，第 10 次后进入 60 秒冷却。
      for (let i = 0; i < 10; i += 1) {
        const res = await ctx1.http.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: attackerHeaders,
          payload: { username: 'ops', password: 'bad' },
        });
        expect(res.statusCode).toBe(401);
      }
      const cooled = await ctx1.http.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: attackerHeaders,
        payload: { username: 'ops', password: 'first-synthetic-password' },
      });
      expect(cooled.statusCode).toBe(429);

      //M 另一正常客户端 IP 不受攻击者冷却牵连。
      const normalLogin = await ctx1.http.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-external-proxy': '1', 'x-forwarded-for': '198.51.100.2' },
        payload: { username: 'ops', password: 'first-synthetic-password' },
      });
      expect(normalLogin.statusCode).toBe(200);
      savedCookie = extractCookiePair(normalLogin.headers['set-cookie']);

      //M 60 秒冷却过后，原 IP 恢复可正常登录。
      clock += 60_001;
      const recovered = await ctx1.http.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: attackerHeaders,
        payload: { username: 'ops', password: 'first-synthetic-password' },
      });
      expect(recovered.statusCode).toBe(200);
    } finally {
      await ctx1.fiber.dispose();
    }

    //M 模拟主站进程换版重启（复用同一 dataDir 下的 web_auth.key）：原先签发的 Cookie 依然有效。
    const specRestarted = webAuthModule.readWebAuthConfig(
      { username: 'ops', password: 'first-synthetic-password' },
      dataDir,
    );
    const ctx2 = new cordis.Context();
    try {
      ctx2.provide('resources', {
        raw: { server: { port: 1 } },
        pluginStatus: [],
        ensureRuntimeDir: () => dataDir,
      });
      new httpPlugin.Http(ctx2, {
        port: 1,
        token: '',
        host: '127.0.0.1',
        trustedIps: ['127.0.0.1'],
        webAuth: specRestarted,
        now: () => clock,
      });
      ctx2.http.app.get('/api/secret', () => ({ ok: true }));

      const stillValid = await ctx2.http.app.inject({
        method: 'GET',
        url: '/api/secret',
        headers: { 'x-external-proxy': '1', cookie: savedCookie },
      });
      expect(stillValid.statusCode).toBe(200);

      //G 推进时钟超过 30 天有效期后，旧 Cookie 自动失效。
      clock += 30 * 24 * 60 * 60 * 1000 + 1000;
      const expired = await ctx2.http.app.inject({
        method: 'GET',
        url: '/api/secret',
        headers: { 'x-external-proxy': '1', cookie: savedCookie },
      });
      expect(expired.statusCode).toBe(401);
    } finally {
      await ctx2.fiber.dispose();
    }

    //G 修改密码后，即使仍在有效期内，旧 Cookie 也会因签名密钥指纹变更立即失效。
    clock = 1_700_000_100_000;
    const specChanged = webAuthModule.readWebAuthConfig(
      { username: 'ops', password: 'rotated-synthetic-password' },
      dataDir,
    );
    const ctx3 = new cordis.Context();
    try {
      ctx3.provide('resources', {
        raw: { server: { port: 1 } },
        pluginStatus: [],
        ensureRuntimeDir: () => dataDir,
      });
      new httpPlugin.Http(ctx3, {
        port: 1,
        token: '',
        host: '127.0.0.1',
        trustedIps: ['127.0.0.1'],
        webAuth: specChanged,
        now: () => clock,
      });
      ctx3.http.app.get('/api/secret', () => ({ ok: true }));
      const revoked = await ctx3.http.app.inject({
        method: 'GET',
        url: '/api/secret',
        headers: { 'x-external-proxy': '1', cookie: savedCookie },
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await ctx3.fiber.dispose();
    }
  });
});
