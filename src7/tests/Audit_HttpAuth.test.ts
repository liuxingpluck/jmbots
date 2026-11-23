/**
 * http 插件（Tokens 令牌管理、Http 鉴权/核验、WebAuth 外网反代登录、FilesApi 与 Static/Embedded 边界）防回归单元测试：
 *   1. Tokens CRUD 全生命周期：新建永久/临时令牌、倒序列表、刷新轮换使旧值立即失效、删除与重启持久化；
 *   2. Tokens 权限与入参边界：远程即使携带主令牌也拒 403、携带 X-External-Proxy: 1 也拒 403、空名/非法分钟 400、未知 ID 404；
 *   3. Tokens 过期与 none() 语义：临时令牌过期即失效，无主令牌且全部动态令牌过期时 none() 回到 true；
 *   4. Http.check 与 requireVerified：?token= 优先于 Bearer、trusted_ips 免令牌浏览但 requireVerified 拦截 403、allow 精确放行；
 *   5. Http.apply 入口校验：缺失/越界 server.port、非法 token/host/trusted_ips 均在启动期抛错；
 *   6. WebAuth 密码哈希解析、Cookie 签名防篡改、改密自动作废旧会话、10 次输错 429 冷却与 Secure 头透传；
 *   7. FilesApi 上传文件名净化、越界 /files/../../ 拦截、反转 Range 416，以及 Embedded.readAsset 目录穿越拦截。
 * 全程隔离临时目录与内存 Fastify inject，不开端口、零外网依赖。
 * 跑法：bun test ./src7/tests/Audit_HttpAuth.test.ts --timeout 60000
 */
import * as bunTest from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as embedded from '../utils/Embedded.ts';
import * as httpPlugin from '../plugins/http/index.ts';
import * as staticModule from '../plugins/http/Static.ts';
import type { TokenInfo } from '../plugins/http/Tokens.ts';
import * as webAuthModule from '../plugins/http/WebAuth.ts';


/** 每个用例结束后按逆序释放的清理函数队列。 */
const closers: Array<() => Promise<unknown> | void> = [];

bunTest.afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 创建隔离临时目录并登记自动删除。 */
function makeTempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  closers.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}


/** 假资源服务配置。 */
interface FakeResourcesOptions {
  /** 隔离临时根目录。 */
  root: string;
  /** 顶层原始配置。 */
  raw: Record<string, unknown>;
}

/** 假资源服务，仅提供隔离临时根目录与 server 原始配置段。 */
class FakeResources extends cordis.Service {
  readonly pluginStatus: never[] = [];
  readonly config = { plugins: [] };
  readonly root: string;
  readonly raw: Record<string, unknown>;

  constructor(ctx: cordis.Context, options: FakeResourcesOptions) {
    super(ctx, 'resources');
    this.root = options.root;
    this.raw = options.raw;
  }

  ensureRuntimeDir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }
}


/**
 * 构建挂好 http 插件的离线测试世界（仅用 app.inject，不绑定真实端口）。
 * @param server server 配置段。
 * @param root 可选复用临时根目录（用于模拟重启持久化）。
 */
async function setupHttp(
  server: Record<string, unknown>,
  root?: string,
): Promise<{ ctx: cordis.Context; root: string }> {
  let dir = root ?? '';
  if (root === undefined) {
    dir = makeTempRoot('audit-http-');
  }
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources, { root: dir, raw: { server } });
  await ctx.plugin(httpPlugin);
  return { ctx, root: dir };
}


/** 从 Set-Cookie 头提取 Cookie 名值对。 */
function extractCookiePair(header: string | string[] | undefined): string {
  let raw = '';
  if (typeof header === 'string') {
    raw = header;
  }
  if (Array.isArray(header)) {
    raw = header[0] ?? '';
  }
  return (raw.split(';')[0] ?? '').trim();
}


bunTest.describe('Audit_HttpAuth：HTTP 鉴权、令牌管理与文件边界', () => {
  bunTest.test('1. Tokens 全生命周期：创建永久/临时令牌、倒序列表、刷新作废旧值、删除并持久化到磁盘', async () => {
    const { ctx, root } = await setupHttp({ port: 1, token: 'master-key' });
    ctx.http.app.get('/api/ping', () => ({ pong: true }));

    const createdPerm = await ctx.http.app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: '  永久助手  ', minutes: 0 },
    });
    bunTest.expect(createdPerm.statusCode).toBe(200);
    const perm = createdPerm.json<TokenInfo>();
    bunTest.expect(perm.name).toBe('永久助手');
    bunTest.expect(perm.value.startsWith('jmb_')).toBe(true);
    bunTest.expect(perm.expiresAt).toBeUndefined();

    await Bun.sleep(5);
    const createdTemp = await ctx.http.app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: '临时手机', minutes: 15 },
    });
    bunTest.expect(createdTemp.statusCode).toBe(200);
    const temp = createdTemp.json<TokenInfo>();
    bunTest.expect(temp.minutes).toBe(15);
    bunTest.expect(typeof temp.expiresAt).toBe('number');

    //M 列表按 createdAt 倒序排列，最新创建的排第一。
    const listed = await ctx.http.app.inject({ method: 'GET', url: '/api/tokens' });
    bunTest.expect(listed.json<TokenInfo[]>().map((item) => item.id)).toEqual([temp.id, perm.id]);

    //M 刷新后旧令牌立即失效，新令牌可正常通过远程鉴权。
    const oldVal = perm.value;
    const refreshed = await ctx.http.app.inject({ method: 'POST', url: `/api/tokens/${perm.id}/refresh` });
    bunTest.expect(refreshed.statusCode).toBe(200);
    const newVal = refreshed.json<TokenInfo>().value;
    bunTest.expect(newVal).not.toBe(oldVal);

    const oldReq = await ctx.http.app.inject({
      method: 'GET',
      url: `/api/ping?token=${oldVal}`,
      remoteAddress: '198.51.100.10',
    });
    const newReq = await ctx.http.app.inject({
      method: 'GET',
      url: `/api/ping?token=${newVal}`,
      remoteAddress: '198.51.100.10',
    });
    bunTest.expect(oldReq.statusCode).toBe(401);
    bunTest.expect(newReq.statusCode).toBe(200);

    //M 删除临时令牌后重启（同目录重挂 Http），永久令牌仍可认证、已删令牌保持不存在。
    const deleted = await ctx.http.app.inject({ method: 'DELETE', url: `/api/tokens/${temp.id}` });
    bunTest.expect(deleted.statusCode).toBe(200);

    const restarted = await setupHttp({ port: 1, token: 'master-key' }, root);
    restarted.ctx.http.app.get('/api/ping', () => ({ pong: true }));
    const afterRestart = await restarted.ctx.http.app.inject({
      method: 'GET',
      url: '/api/ping',
      remoteAddress: '198.51.100.10',
      headers: { authorization: `Bearer ${newVal}` },
    });
    bunTest.expect(afterRestart.statusCode).toBe(200);
    const afterList = await restarted.ctx.http.app.inject({ method: 'GET', url: '/api/tokens' });
    bunTest.expect(afterList.json<TokenInfo[]>()).toHaveLength(1);
  });

  bunTest.test('2. Tokens 权限铁壁：远程即使持主令牌也 403，本机带 X-External-Proxy: 1 也 403', async () => {
    const { ctx } = await setupHttp({ port: 1, token: 'master-secret' });

    const remoteWithMaster = await ctx.http.app.inject({
      method: 'POST',
      url: '/api/tokens',
      remoteAddress: '203.0.113.5',
      headers: { authorization: 'Bearer master-secret' },
      payload: { name: '试图越权建永久令牌' },
    });
    bunTest.expect(remoteWithMaster.statusCode).toBe(403);
    bunTest.expect(remoteWithMaster.json<{ error: string }>().error).toContain('只能在本机管');

    //G 经外网反代进来的 127.0.0.1 请求绝不被视为本机。
    const proxiedLocal = await ctx.http.app.inject({
      method: 'GET',
      url: '/api/tokens',
      remoteAddress: '127.0.0.1',
      headers: { 'x-external-proxy': '1', authorization: 'Bearer master-secret' },
    });
    bunTest.expect(proxiedLocal.statusCode).toBe(403);
  });

  bunTest.test('3. Tokens 入参校验与 404：拒绝空名、非正/NaN 分钟，未知 ID 刷新和删除均返回 404', async () => {
    const { ctx } = await setupHttp({ port: 1, token: 'master' });
    const badCreates = [{ name: '' }, { name: '   ' }, { name: 'a', minutes: -5 }, { name: 'a', minutes: 'abc' }];
    for (const payload of badCreates) {
      const res = await ctx.http.app.inject({ method: 'POST', url: '/api/tokens', payload });
      bunTest.expect(res.statusCode).toBe(400);
    }

    const missRefresh = await ctx.http.app.inject({ method: 'POST', url: '/api/tokens/no-such-id/refresh' });
    const missDelete = await ctx.http.app.inject({ method: 'DELETE', url: '/api/tokens/no-such-id' });
    bunTest.expect(missRefresh.statusCode).toBe(404);
    bunTest.expect(missDelete.statusCode).toBe(404);
  });

  bunTest.test('4. 临时动态令牌过期后立即失效，无主令牌且无有效动态令牌时远程降级免校验但未核验身份', async () => {
    const root = makeTempRoot('audit-http-exp-');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const expiredToken: TokenInfo = {
      id: 'exp-1',
      name: '已过期',
      value: 'jmb_expired_token_value',
      minutes: 1,
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1000,
    };
    fs.writeFileSync(path.join(dataDir, 'tokens.json'), JSON.stringify([expiredToken]), 'utf8');

    const { ctx } = await setupHttp({ port: 1, token: '' }, root);
    ctx.http.app.get('/api/probe', (req) => ({ verified: ctx.http.isVerified(req) }));

    //M 无主令牌且唯一动态令牌已过期：none() 为 true，远程可访问但 isVerified 仍为 false。
    const res = await ctx.http.app.inject({
      method: 'GET',
      url: '/api/probe?token=jmb_expired_token_value',
      remoteAddress: '198.51.100.20',
    });
    bunTest.expect(res.statusCode).toBe(200);
    bunTest.expect(res.json<{ verified: boolean }>().verified).toBe(false);

    //M 若存在主令牌，则过期动态令牌被直接拒绝 401。
    const strict = await setupHttp({ port: 1, token: 'real-master' }, root);
    strict.ctx.http.app.get('/api/probe', () => ({ ok: true }));
    const denied = await strict.ctx.http.app.inject({
      method: 'GET',
      url: '/api/probe?token=jmb_expired_token_value',
      remoteAddress: '198.51.100.20',
    });
    bunTest.expect(denied.statusCode).toBe(401);
  });

  bunTest.test('5. Http.check 与 requireVerified：?token= 覆盖 Bearer，trusted_ips 写操作被 requireVerified 拦 403', async () => {
    const { ctx } = await setupHttp({ port: 1, token: 'valid-key', trusted_ips: ['192.0.2.50'] });
    ctx.http.app.post('/api/sensitive', (req) => {
      ctx.http.requireVerified(req, '敏感写操作');
      return { ok: true };
    });

    //G ?token= 优先于 Authorization 头：若 query 带错令牌，即便 Bearer 正确也必须拒绝 401。
    const badQuery = await ctx.http.app.inject({
      method: 'POST',
      url: '/api/sensitive?token=wrong',
      remoteAddress: '198.51.100.7',
      headers: { authorization: 'Bearer valid-key' },
    });
    bunTest.expect(badQuery.statusCode).toBe(401);

    //G trusted_ips 未带令牌时放行进路由但未核验身份，requireVerified 必须抛出 403。
    const trustedNoToken = await ctx.http.app.inject({
      method: 'POST',
      url: '/api/sensitive',
      remoteAddress: '192.0.2.50',
    });
    bunTest.expect(trustedNoToken.statusCode).toBe(403);
    bunTest.expect(trustedNoToken.json<{ error: string }>().error).toContain('需要先完成身份核验');

    //M 携带有效 Bearer 令牌后核验通过，返回 200。
    const okReq = await ctx.http.app.inject({
      method: 'POST',
      url: '/api/sensitive',
      remoteAddress: '192.0.2.50',
      headers: { authorization: 'Bearer valid-key' },
    });
    bunTest.expect(okReq.statusCode).toBe(200);
  });

  bunTest.test('6. Http.allow 仅精确放行登记路径，不影响兄弟接口或子路径鉴权', async () => {
    const { ctx } = await setupHttp({ port: 1, token: 'top-token' });
    ctx.http.allow('/api/public/guide');
    ctx.http.app.get('/api/public/guide', (req) => ({ ok: true, verified: ctx.http.isVerified(req) }));
    ctx.http.app.get('/api/public/guide/extra', () => ({ ok: true }));
    ctx.http.app.get('/api/public/secret', () => ({ ok: true }));

    const openRes = await ctx.http.app.inject({
      method: 'GET',
      url: '/api/public/guide',
      remoteAddress: '198.51.100.9',
    });
    bunTest.expect(openRes.statusCode).toBe(200);
    bunTest.expect(openRes.json<{ verified: boolean }>().verified).toBe(false);

    const subRes = await ctx.http.app.inject({
      method: 'GET',
      url: '/api/public/guide/extra',
      remoteAddress: '198.51.100.9',
    });
    const sibRes = await ctx.http.app.inject({
      method: 'GET',
      url: '/api/public/secret',
      remoteAddress: '198.51.100.9',
    });
    bunTest.expect(subRes.statusCode).toBe(401);
    bunTest.expect(sibRes.statusCode).toBe(401);
  });

  bunTest.test('7. Http.apply 配置入口校验：拒绝缺端口、越界端口、非法 token、空 host 与畸形 trusted_ips', async () => {
    const badServers: Record<string, unknown>[] = [
      {},
      { port: 0 },
      { port: 70000 },
      { port: 30086, token: 123 },
      { port: 30086, host: '' },
      { port: 30086, trusted_ips: '127.0.0.1' },
      { port: 30086, trusted_ips: ['   '] },
    ];

    for (const server of badServers) {
      const ctx = new cordis.Context();
      const root = makeTempRoot('audit-http-cfg-');
      closers.push(() => ctx.fiber.dispose());
      await ctx.plugin(FakeResources, { root, raw: { server } });
      bunTest.expect(() => httpPlugin.apply(ctx)).toThrow();
    }
  });

  bunTest.test('8. WebAuth 配置校验：支持 scrypt/sha256/明文，拒绝畸形哈希与缺失密码字段', () => {
    const dataDir = makeTempRoot('audit-webauth-cfg-');
    const scryptHash = webAuthModule.hashPasswordScrypt('MyPass123!', '00112233445566778899aabbccddeeff');
    const sha256Hash = crypto.createHash('sha256').update('MyPass123!', 'utf8').digest('hex');

    const s1 = webAuthModule.readWebAuthConfig(
      { username: 'admin', password_scrypt: scryptHash, secret: 's1' },
      dataDir,
    );
    const s2 = webAuthModule.readWebAuthConfig(
      { username: 'admin', password_sha256: sha256Hash, secret: 's2' },
      dataDir,
    );
    const s3 = webAuthModule.readWebAuthConfig({ username: 'admin', password: 'plain' }, dataDir);

    bunTest.expect(s1?.verifier.kind).toBe('scrypt');
    bunTest.expect(s2?.verifier.kind).toBe('sha256');
    bunTest.expect(s3?.verifier.kind).toBe('sha256');
    bunTest.expect(fs.existsSync(path.join(dataDir, 'web_auth.key'))).toBe(true);

    const badWebAuths: unknown[] = [
      { username: '  ', password: 'x' },
      { username: 'admin' },
      { username: 'admin', password_scrypt: 'scrypt$short$deadbeef' },
      { username: 'admin', password_sha256: 'not-64-hex' },
    ];
    for (const bad of badWebAuths) {
      bunTest.expect(() => webAuthModule.readWebAuthConfig(bad, dataDir)).toThrow();
    }
  });

  bunTest.test('9. WebAuth 安全边界：Cookie 篡改拒 401、HTTPS 透传 Secure、改密后旧 Cookie 立即作废', async () => {
    const root = makeTempRoot('audit-webauth-sec-');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    let clock = 1_700_000_000_000;

    const specA = webAuthModule.readWebAuthConfig(
      { username: 'Boss', password_scrypt: webAuthModule.hashPasswordScrypt('OldPass!'), secret: 'fixed-seed-abc' },
      dataDir,
    );
    const ctxA = new cordis.Context();
    closers.push(() => ctxA.fiber.dispose());
    await ctxA.plugin(FakeResources, { root, raw: { server: { port: 1 } } });
    const httpA = new httpPlugin.Http(ctxA, {
      port: 1,
      token: 'unused',
      host: '127.0.0.1',
      trustedIps: ['127.0.0.1'],
      webAuth: specA,
      now: () => clock,
    });
    httpA.app.get('/api/private', (req) => ({ ok: true, verified: httpA.isVerified(req) }));

    //M 未登录外网代理请求被拦 401。
    const unauth = await httpA.app.inject({
      method: 'GET',
      url: '/api/private',
      headers: { 'x-external-proxy': '1' },
    });
    bunTest.expect(unauth.statusCode).toBe(401);

    //M 账号大小写不敏感登录成功，X-Forwarded-Proto: https 必须附带 Secure 与 HttpOnly。
    const login = await httpA.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-external-proxy': '1', 'x-forwarded-proto': 'https' },
      payload: { username: 'boss', password: 'OldPass!' },
    });
    bunTest.expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie'] ?? '');
    bunTest.expect(setCookie).toContain('HttpOnly');
    bunTest.expect(setCookie).toContain('SameSite=Lax');
    bunTest.expect(setCookie).toContain('Secure');

    const cookiePair = extractCookiePair(login.headers['set-cookie']);
    const authed = await httpA.app.inject({
      method: 'GET',
      url: '/api/private',
      headers: { 'x-external-proxy': '1', cookie: cookiePair },
    });
    bunTest.expect(authed.statusCode).toBe(200);
    bunTest.expect(authed.json<{ verified: boolean }>().verified).toBe(true);

    //G 篡改 Cookie 签名中间字节（避开 base64url 末位忽略位）后必须 100% 拒绝 401。
    const dotPos = cookiePair.indexOf('.');
    let flipped = 'A';
    if (cookiePair.charAt(dotPos + 5) === 'A') {
      flipped = 'B';
    }
    const tampered = `${cookiePair.slice(0, dotPos + 5)}${flipped}${cookiePair.slice(dotPos + 6)}`;
    const badSig = await httpA.app.inject({
      method: 'GET',
      url: '/api/private',
      headers: { 'x-external-proxy': '1', cookie: tampered },
    });
    bunTest.expect(badSig.statusCode).toBe(401);

    //G 修改密码后，即使 seed 相同，旧 Cookie 也必须立刻失效。
    const specB = webAuthModule.readWebAuthConfig(
      { username: 'Boss', password_scrypt: webAuthModule.hashPasswordScrypt('NewPass!'), secret: 'fixed-seed-abc' },
      dataDir,
    );
    const ctxB = new cordis.Context();
    closers.push(() => ctxB.fiber.dispose());
    await ctxB.plugin(FakeResources, { root, raw: { server: { port: 1 } } });
    const httpB = new httpPlugin.Http(ctxB, {
      port: 1,
      token: '',
      host: '127.0.0.1',
      trustedIps: ['127.0.0.1'],
      webAuth: specB,
      now: () => clock,
    });
    httpB.app.get('/api/private', () => ({ ok: true }));
    const oldCookieRejected = await httpB.app.inject({
      method: 'GET',
      url: '/api/private',
      headers: { 'x-external-proxy': '1', cookie: cookiePair },
    });
    bunTest.expect(oldCookieRejected.statusCode).toBe(401);

    //G 超过 30 天有效期后，原实例内旧 Cookie 也自动过期拒绝 401。
    clock += 31 * 24 * 60 * 60 * 1000;
    const expiredCookie = await httpA.app.inject({
      method: 'GET',
      url: '/api/private',
      headers: { 'x-external-proxy': '1', cookie: cookiePair },
    });
    bunTest.expect(expiredCookie.statusCode).toBe(401);
  });

  bunTest.test('10. WebAuth 暴力破解限速：同 IP 连错 10 次触发 429 冷却，60 秒后自动解封', async () => {
    const root = makeTempRoot('audit-webauth-rl-');
    let clock = 1_700_000_000_000;
    const spec = webAuthModule.readWebAuthConfig({ username: 'u1', password: 'correct', secret: 'seed' }, root);
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    await ctx.plugin(FakeResources, { root, raw: { server: { port: 1 } } });
    const httpSvc = new httpPlugin.Http(ctx, {
      port: 1,
      token: '',
      host: '127.0.0.1',
      trustedIps: ['127.0.0.1'],
      webAuth: spec,
      now: () => clock,
    });

    const headers = { 'x-external-proxy': '1', 'x-real-ip': '203.0.113.88' };
    for (let i = 0; i < 10; i += 1) {
      const fail = await httpSvc.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers,
        payload: { username: 'u1', password: 'wrong' },
      });
      bunTest.expect(fail.statusCode).toBe(401);
    }

    //G 第 11 次即便提交正确密码也处于 60 秒冷却中，必须返回 429。
    const blocked = await httpSvc.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { username: 'u1', password: 'correct' },
    });
    bunTest.expect(blocked.statusCode).toBe(429);

    //M 推进假时钟越过 60 秒冷却期后恢复正常登录。
    clock += 61_000;
    const recovered = await httpSvc.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { username: 'u1', password: 'correct' },
    });
    bunTest.expect(recovered.statusCode).toBe(200);
  });

  bunTest.test('11. FilesApi 上传文件名净化、空请求体落盘、/files 路径穿越拦截与反转 Range 返回 416', async () => {
    const { ctx, root } = await setupHttp({ port: 1, token: '' });
    await staticModule.registerStatic(ctx, ctx.http.app);
    await ctx.http.app.ready();

    //M 危险字符与超长文件名被安全清洗，纯非法字符回退为“未命名”。
    const dirtyName = encodeURIComponent('a:b*c?"<>|  file.verylongextensionname');
    const up1 = await ctx.http.app.inject({ method: 'PUT', url: `/api/uploads/${dirtyName}`, payload: 'hello' });
    bunTest.expect(up1.statusCode).toBe(200);
    const info1 = up1.json<{ name: string; size: number }>();
    bunTest.expect(info1.name).not.toMatch(/[\\/:*?"<>|]/u);
    bunTest.expect(info1.size).toBe(5);

    const emptyName = encodeURIComponent('***???');
    const up2 = await ctx.http.app.inject({ method: 'PUT', url: `/api/uploads/${emptyName}` });
    bunTest.expect(up2.statusCode).toBe(200);
    bunTest.expect(up2.json<{ name: string; size: number }>()).toMatchObject({ name: '未命名', size: 0 });

    //G /files/* 访问敏感文件与路径穿越必须被拦（FilesApi 回 403，且绝不返回密钥正文），越界列根目录回 403。
    fs.writeFileSync(path.join(root, 'config.yaml'), 'secret: 1', 'utf8');
    const escDirect = await ctx.http.app.inject({ method: 'GET', url: '/files/bots/../config.yaml' });
    bunTest.expect(escDirect.statusCode).toBe(403);
    bunTest.expect(escDirect.body).not.toContain('secret: 1');
    const escNorm = await ctx.http.app.inject({ method: 'GET', url: '/files/bots/../../config.yaml' });
    bunTest.expect([403, 404]).toContain(escNorm.statusCode);
    bunTest.expect(escNorm.body).not.toContain('secret: 1');

    const escList = await ctx.http.app.inject({
      method: 'GET',
      url: `/api/files/list?path=${encodeURIComponent(root)}`,
    });
    bunTest.expect(escList.statusCode).toBe(403);

    //G 反转 Range (start > end) 返回 416。
    const okFile = path.join(root, 'bots', 'b1', 'data.txt');
    fs.mkdirSync(path.dirname(okFile), { recursive: true });
    fs.writeFileSync(okFile, '0123456789', 'utf8');
    const badRange = await ctx.http.app.inject({
      method: 'GET',
      url: `/api/files?path=${encodeURIComponent(okFile)}`,
      headers: { range: 'bytes=8-2' },
    });
    bunTest.expect(badRange.statusCode).toBe(416);
  });

  bunTest.test('12. Embedded.readAsset 静态资源防穿越：空路径与 ../ 逃出 dist/web 均返回 undefined', async () => {
    bunTest.expect(await embedded.readAsset('')).toBeUndefined();
    bunTest.expect(await embedded.readAsset('../package.json')).toBeUndefined();
    bunTest.expect(await embedded.readAsset('../../package.json')).toBeUndefined();
    bunTest.expect(await embedded.readAsset('assets/../../src7/Main.ts')).toBeUndefined();
  });
});
