/**
 * 外网代理网页登录鉴权（仅对携带阿里云 Nginx 注入请求头 `X-External-Proxy: 1` 的请求生效）。
 * 家里 127.0.0.1 与内网虚拟机 192.168.200.* 直连无此请求头，`required` 恒为 false，零打扰。
 * 开启后通过 HMAC-SHA256 签名签发 30 天 HttpOnly 会话 Cookie，并提供登录限速保护。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as fastify from 'fastify';
import * as checksModule from '../../utils/Checks.ts';
import * as filesModule from '../../utils/Files.ts';


//==========================================================
//M 协议常量与配置类型
//==========================================================

/** 阿里云反向代理注入的外网来源标记请求头。 */
export const EXTERNAL_PROXY_HEADER = 'x-external-proxy';

/** 外网会话 Cookie 名称。 */
export const SESSION_COOKIE_NAME = 'jmb_web_session';

/** 会话有效期：30 天（秒与毫秒）。 */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

/** 单 IP 连续输错密码触发冷却的阈值与冷却时长。 */
const MAX_LOGIN_FAILS = 10;
const LOGIN_COOLDOWN_MS = 60_000;
const FAIL_RECORD_STALE_MS = 10 * 60_000;

/** 外网未登录也放行的公开 API 路径集合。 */
const PUBLIC_API_ROUTES = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout',
]);

/** 密码核验器：支持 scrypt 盐值哈希或 SHA-256 常量时间摘要核验。 */
interface PasswordVerifier {
  /** 核验算法类别。 */
  kind: 'scrypt' | 'sha256';
  /** scrypt 用的随机盐；sha256 模式为空 Buffer。 */
  salt: Buffer;
  /** 目标摘要字节，核验时走 timingSafeEqual。 */
  hash: Buffer;
  /** 混入 Cookie 签名密钥派生的摘要指纹，改密码后旧 Cookie 自动失效。 */
  tag: string;
}

/** 校验通过后的外网登录运行规格。 */
export interface WebAuthSpec {
  /** 允许登录的唯一用户名。 */
  username: string;
  /** 密码核验器。 */
  verifier: PasswordVerifier;
  /** HMAC-SHA256 签名密钥（绑定用户名与密码指纹）。 */
  signingKey: Buffer;
}

/** 单个来源地址的登录失败计数与冷却截止时刻。 */
interface LoginFailRecord {
  /** 当前连续失败次数。 */
  fails: number;
  /** 冷却结束时间戳（毫秒），未冷却时为 0。 */
  blockedUntil: number;
  /** 最近一次更新时间戳（毫秒），供淘汰陈旧记录。 */
  updatedAt: number;
}

/** 外网请求在 onRequest 阶段的鉴权判定结果。 */
export type ExternalAuthDecision = 'not_external' | 'pass_verified' | 'pass_unverified' | 'blocked';


//==========================================================
//M 密码哈希生成与配置解析
//==========================================================

/**
 * 生成 `scrypt$<saltHex>$<hashHex>` 格式的密码哈希串，供配置写入或单测构造。
 * @param password 明文密码。
 * @param saltHex 可选 16 进制盐（至少 8 字节）；省略时随机生成 16 字节。
 * @returns 可直接写入 `web_auth.password_scrypt` 的哈希文本。
 */
export function hashPasswordScrypt(password: string, saltHex?: string): string {
  //M 允许单测固定盐复现结果，生产省略时用密码学随机数生成盐。
  let salt = crypto.randomBytes(16);
  if (saltHex !== undefined) {
    salt = Buffer.from(saltHex, 'hex');
  }
  const derived = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}


/**
 * 判断请求是否带有外网反向代理标记 `X-External-Proxy: 1`。
 * @param request Fastify 请求。
 * @returns 带 `x-external-proxy: 1` 时为 true。
 */
export function isExternalProxyRequest(request: fastify.FastifyRequest): boolean {
  return request.headers[EXTERNAL_PROXY_HEADER] === '1';
}


/**
 * 读取或初始化运行时持久化签名种子，保证主站重启或平滑换版后 30 天内手机免重登。
 * @param dataDir 运行时 `data` 目录路径。
 * @returns 签名种子文本。
 */
function loadOrCreateSeed(dataDir: string): string {
  const keyFile = path.join(dataDir, 'web_auth.key');
  //M 已有合法种子时直接复用，避免重启冲掉已登录设备的会话。
  if (fs.existsSync(keyFile)) {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing.length >= 64) return existing;
  }

  //M 首次启用时生成 32 字节随机种子并原子落盘。
  const created = crypto.randomBytes(32).toString('hex');
  filesModule.writeTextAtomic(keyFile, `${created}\n`, false);
  return created;
}


/**
 * 解析配置里的密码核验器（支持 `password_scrypt`、`password_sha256`、`password` 三选一）。
 * @param written `web_auth` 配置对象。
 * @param label 报错前缀。
 * @returns 常量时间密码核验器。
 */
function parsePasswordVerifier(written: Record<string, unknown>, label: string): PasswordVerifier {
  if (written['password_scrypt'] !== undefined) {
    const text = checksModule.checkNonEmptyText(written['password_scrypt'], `${label}.password_scrypt`).trim();
    const parts = text.split('$');
    const saltHex = parts[1] ?? '';
    const hashHex = parts[2] ?? '';
    const validHex = /^[0-9a-f]+$/iu;
    //G 格式须为 scrypt$<saltHex>$<hashHex>，且盐与哈希均为偶数长度十六进制。
    const badSalt = saltHex.length < 16 || saltHex.length % 2 !== 0 || !validHex.test(saltHex);
    const badHash = hashHex.length < 64 || hashHex.length % 2 !== 0 || !validHex.test(hashHex);
    if (parts.length !== 3 || parts[0] !== 'scrypt' || badSalt || badHash) {
      throw new Error(`${label}.password_scrypt 格式不对，应为 scrypt$<saltHex>$<hashHex>`);
    }
    return {
      kind: 'scrypt',
      salt: Buffer.from(saltHex, 'hex'),
      hash: Buffer.from(hashHex, 'hex'),
      tag: text.toLowerCase(),
    };
  }

  if (written['password_sha256'] !== undefined) {
    const hex = checksModule.checkNonEmptyText(written['password_sha256'], `${label}.password_sha256`).trim();
    //G SHA-256 摘要固定为 64 位十六进制字符。
    if (!/^[0-9a-f]{64}$/iu.test(hex)) {
      throw new Error(`${label}.password_sha256 要写成 64 位十六进制 SHA-256 摘要`);
    }
    return {
      kind: 'sha256',
      salt: Buffer.alloc(0),
      hash: Buffer.from(hex, 'hex'),
      tag: hex.toLowerCase(),
    };
  }

  if (written['password'] !== undefined) {
    const plain = checksModule.checkNonEmptyText(written['password'], `${label}.password`);
    //M 明文配置在内存里先做一次 SHA-256，后续校验统一走定长 timingSafeEqual。
    const hash = crypto.createHash('sha256').update(plain, 'utf8').digest();
    return {
      kind: 'sha256',
      salt: Buffer.alloc(0),
      hash,
      tag: hash.toString('hex'),
    };
  }

  throw new Error(`${label} 要写 password_scrypt、password_sha256 或 password 之一`);
}


/**
 * 校验并构造可选的 `web_auth` 配置。未配置时返回 undefined（外网 Cookie 鉴权不开启）。
 * @param raw `server.web_auth` 或 `plugins[http].config.web_auth` 原始值。
 * @param dataDir 运行时 `data` 目录（仅在开启 `web_auth` 且未显式写 `secret` 时读写种子）。
 * @param label 配置路径名，供报错提示。
 * @returns 校验后的运行规格，或 undefined。
 */
export function readWebAuthConfig(raw: unknown, dataDir: string, label = 'server.web_auth'): WebAuthSpec | undefined {
  if (raw === undefined) return undefined;

  const written = checksModule.checkRecord(raw, label);
  const username = checksModule.checkNonEmptyText(written['username'], `${label}.username`).trim();
  if (username === '') {
    throw new Error(`${label}.username 要写成非空的文字`);
  }

  const verifier = parsePasswordVerifier(written, label);
  let seed = '';
  if (written['secret'] !== undefined) {
    seed = checksModule.checkNonEmptyText(written['secret'], `${label}.secret`);
  }
  if (seed === '') {
    seed = loadOrCreateSeed(dataDir);
  }

  //M 将用户名与密码指纹混入 HMAC 密钥派生，修改账号或密码后旧会话 Cookie 立即自动作废。
  const signingKey = crypto.createHmac('sha256', seed).update(`${username}\n${verifier.tag}`).digest();
  return { username, verifier, signingKey };
}


//==========================================================
//M 请求头、Cookie 编解码与密码比对辅助
//==========================================================

/**
 * 用常量时间比对输入密码与配置核验器。
 * @param password 用户提交的密码。
 * @param verifier 配置核验器。
 * @returns 匹配时为 true。
 */
function verifyPassword(password: string, verifier: PasswordVerifier): boolean {
  if (verifier.kind === 'scrypt') {
    const actual = crypto.scryptSync(password, verifier.salt, verifier.hash.length);
    return crypto.timingSafeEqual(actual, verifier.hash);
  }
  const actual = crypto.createHash('sha256').update(password, 'utf8').digest();
  return crypto.timingSafeEqual(actual, verifier.hash);
}


/**
 * 检测反向代理转发协议是否为 HTTPS，决定是否附加 Cookie 的 `Secure` 属性。
 * @param request Fastify 请求。
 * @returns `X-Forwarded-Proto` 首段为 `https` 时返回 true。
 */
function isHttpsForwarded(request: fastify.FastifyRequest): boolean {
  const raw = request.headers['x-forwarded-proto'];
  let first = '';
  if (typeof raw === 'string') {
    first = raw;
  }
  if (Array.isArray(raw)) {
    first = raw[0] ?? '';
  }
  const proto = (first.split(',')[0] ?? '').trim().toLowerCase();
  return proto === 'https';
}


/**
 * 提取客户端限速键：仅在外网反代请求头存在时采用 Nginx 传来的真实客户端 IP。
 * @param request Fastify 请求。
 * @returns 用于登录限速统计的来源地址标识。
 */
function getClientIpKey(request: fastify.FastifyRequest): string {
  if (!isExternalProxyRequest(request)) return request.ip;

  const realIp = request.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim() !== '') return realIp.trim();

  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const head = (forwarded.split(',')[0] ?? '').trim();
    if (head !== '') return head;
  }
  return request.ip;
}


/**
 * 从请求头 `Cookie` 中取出指定名字的原始值。
 * @param cookieHeader 请求头 `request.headers.cookie`。
 * @param targetName 目标 Cookie 名。
 * @returns 匹配到的值；未带时返回空串。
 */
function readCookieValue(cookieHeader: string | undefined, targetName: string): string {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return '';

  for (const segment of cookieHeader.split(';')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;

    const key = segment.slice(0, eq).trim();
    if (key === targetName) return segment.slice(eq + 1).trim();
  }
  return '';
}


/**
 * 拼装 `Set-Cookie` 响应头文本。
 * @param value Cookie 值；登出清空时传空串。
 * @param maxAge 存活秒数；登出清空时传 0。
 * @param secure 是否附加 `; Secure`。
 * @returns 完整的 `Set-Cookie` 头内容。
 */
function formatSessionCookie(value: string, maxAge: number, secure: boolean): string {
  let cookie = `${SESSION_COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${String(maxAge)}`;
  if (secure) {
    cookie += '; Secure';
  }
  return cookie;
}


//==========================================================
//M 外网会话鉴权控制器与路由挂载
//==========================================================

/** 负责签发核验会话 Cookie、维护登录限速并挂载 `/api/auth/*` 接口。 */
export class WebAuth {
  /** 各客户端 IP 的连续登录失败记录。 */
  private readonly failures = new Map<string, LoginFailRecord>();

  /**
   * @param app Fastify 实例，用于登记 `/api/auth/status`、`login`、`logout`。
   * @param spec 外网鉴权规格；未配置时为 undefined。
   * @param now 时钟函数，单测可注入假时钟验证冷却与过期。
   */
  constructor(
    app: fastify.FastifyInstance,
    private readonly spec: WebAuthSpec | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.registerRoutes(app);
  }

  /**
   * 在 `Http.check` 最前面裁决外网代理请求。
   * @param request Fastify 请求。
   * @param reply Fastify 回应。
   * @param route 去掉查询串后的请求路径。
   * @param guarded 路径是否落在 `/api/`、`/files/`、`/programs/` 受保护前缀下。
   * @returns 鉴权裁决结果。
   */
  async checkExternal(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
    route: string,
    guarded: boolean,
  ): Promise<ExternalAuthDecision> {
    //G 未配 web_auth 或未带 X-External-Proxy: 1 时，不启用外网拦截，交回原有本机/内网逻辑。
    if (this.spec === undefined || !isExternalProxyRequest(request)) return 'not_external';

    //M 携带有效签名 Cookie 时放行并标记已核验身份，手机/PC 无需额外传 ?token=。
    if (this.readAuthenticatedUser(request) !== undefined) return 'pass_verified';

    //M 未登录时放行健康检查、登录状态/提交接口与全部前端静态资源，让浏览器加载出 React 登录页。
    if (!guarded || PUBLIC_API_ROUTES.has(route)) return 'pass_unverified';

    //G 其余受保护接口一律返回 401，引导前端渲染 AuthGate 登录界面。
    await reply.code(401).send({ error: '请先登录', code: 'unauthorized' });
    return 'blocked';
  }

  /**
   * 登记 `/api/auth/status`、`/api/auth/login`、`/api/auth/logout` 三个轻量接口。
   * @param app Fastify 实例。
   */
  private registerRoutes(app: fastify.FastifyInstance): void {
    app.get('/api/auth/status', (_request, reply) => {
      reply.header('cache-control', 'no-store');
      //G 仅当请求带 X-External-Proxy: 1 且配置了 web_auth 时 required 才为 true。
      if (this.spec === undefined || !isExternalProxyRequest(_request)) {
        return { required: false, authenticated: false };
      }

      const username = this.readAuthenticatedUser(_request);
      if (username === undefined) return { required: true, authenticated: false };

      return { required: true, authenticated: true, username };
    });

    app.post('/api/auth/login', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (this.spec === undefined) {
        return reply.code(404).send({ error: '未配置网页登录' });
      }

      const now = this.now();
      this.pruneStaleFailures(now);
      const ipKey = getClientIpKey(request);
      const record = this.failures.get(ipKey);
      //G 处于连续输错冷却期内时直接拒绝，防止暴力枚举密码。
      if (record !== undefined && record.blockedUntil > now) {
        return reply.code(429).send({ error: '尝试太频繁，请 1 分钟后再试', code: 'rate_limited' });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      let username = '';
      if (typeof body['username'] === 'string') {
        username = body['username'].trim();
      }
      let password = '';
      if (typeof body['password'] === 'string') {
        password = body['password'];
      }

      //G 账号不区分大小写、密码严格区分（先做定长密码摘要核验再汇总，避免泄露账号是否存在）。
      const passwordOk = password !== '' && verifyPassword(password, this.spec.verifier);
      const userOk = username.toLowerCase() === this.spec.username.toLowerCase();
      if (!userOk || !passwordOk) {
        this.recordFailure(ipKey, now);
        return reply.code(401).send({ error: '账号或密码不对' });
      }

      //M 登录成功后清零该来源失败计数，签发 30 天 HttpOnly 会话 Cookie。
      this.failures.delete(ipKey);
      const token = this.issueToken(this.spec.username, now + SESSION_MAX_AGE_MS);
      const cookie = formatSessionCookie(token, SESSION_MAX_AGE_SECONDS, isHttpsForwarded(request));
      reply.header('set-cookie', cookie);
      return { ok: true, username: this.spec.username };
    });

    app.post('/api/auth/logout', (request, reply) => {
      reply.header('cache-control', 'no-store');
      const cookie = formatSessionCookie('', 0, isHttpsForwarded(request));
      reply.header('set-cookie', cookie);
      return { ok: true };
    });
  }

  /**
   * 签发带过期时刻的 HMAC-SHA256 会话令牌。
   * @param username 登录用户名。
   * @param expiresAt 过期毫秒时间戳。
   * @returns `<payloadBase64Url>.<sigBase64Url>` 字符串。
   */
  private issueToken(username: string, expiresAt: number): string {
    const payload = Buffer.from(JSON.stringify({ u: username, exp: expiresAt }), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', this.spec!.signingKey).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  /**
   * 核验请求携带的会话 Cookie，有效且未过期时返回用户名。
   * @param request Fastify 请求。
   * @returns 已核验用户名；无 Cookie、篡改或已过期时返回 undefined。
   */
  private readAuthenticatedUser(request: fastify.FastifyRequest): string | undefined {
    if (this.spec === undefined) return undefined;

    const rawToken = readCookieValue(request.headers.cookie, SESSION_COOKIE_NAME);
    if (rawToken === '') return undefined;

    const dot = rawToken.indexOf('.');
    if (dot <= 0 || rawToken.indexOf('.', dot + 1) !== -1) return undefined;

    const payloadPart = rawToken.slice(0, dot);
    const sigPart = rawToken.slice(dot + 1);
    const expectedSig = crypto.createHmac('sha256', this.spec.signingKey).update(payloadPart).digest();
    const actualSig = Buffer.from(sigPart, 'base64url');
    if (actualSig.length !== expectedSig.length) return undefined;
    if (!crypto.timingSafeEqual(actualSig, expectedSig)) return undefined;

    try {
      const parsed = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
        u?: unknown;
        exp?: unknown;
      };
      if (parsed.u !== this.spec.username) return undefined;
      if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) return undefined;
      if (parsed.exp <= this.now()) return undefined;

      return this.spec.username;
    } catch {
      return undefined;
    }
  }

  /**
   * 累加一次登录失败，满阈值后开启 60 秒冷却窗口。
   * @param ipKey 来源地址键。
   * @param now 当前毫秒时间戳。
   */
  private recordFailure(ipKey: string, now: number): void {
    const current = this.failures.get(ipKey) ?? { fails: 0, blockedUntil: 0, updatedAt: now };
    const nextFails = current.fails + 1;
    if (nextFails >= MAX_LOGIN_FAILS) {
      this.failures.set(ipKey, { fails: 0, blockedUntil: now + LOGIN_COOLDOWN_MS, updatedAt: now });
      return;
    }
    this.failures.set(ipKey, { fails: nextFails, blockedUntil: 0, updatedAt: now });
  }

  /**
   * 清理闲置超过 10 分钟的失败计数，防止公网扫描撑大内存表。
   * @param now 当前毫秒时间戳。
   */
  private pruneStaleFailures(now: number): void {
    if (this.failures.size < 128) return;

    for (const [key, item] of this.failures) {
      if (now - item.updatedAt > FAIL_RECORD_STALE_MS && item.blockedUntil <= now) {
        this.failures.delete(key);
      }
    }
  }
}
