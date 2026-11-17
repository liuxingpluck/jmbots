/**
 * 访问令牌：别的机器来的 /api/、/files/ 请求要带一个有效的令牌。
 * 两种来源：config.yaml 的 server.token（固定的主令牌，不列出来、不能在这里删），
 * 加上存在运行时 data/tokens.json 里的多个令牌（每个有名字，永久或临时几分钟）。和 0.4 同一个文件、同一种格式。
 * 管令牌的四个接口也在这里，只许本机：局域网带着令牌也不行，免得临时令牌给自己换出永久的。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type * as fastify from 'fastify';
import type { Http } from './index.ts';


/** 一个令牌。 */
export interface TokenInfo {
  /** 号：建的时间戳加随机数；刷新、删的时候用。 */
  id: string;
  /** 名字：给谁用的，比如 grokbots、Claude、手机。 */
  name: string;
  /** 值：请求带的就是它，jmb_ 开头。 */
  value: string;
  /** 临时的：建好或刷新后几分钟失效；永久的没有这一项。 */
  minutes?: number;
  /** 建的时间，毫秒。 */
  createdAt: number;
  /** 失效的时间，毫秒；永久的没有。 */
  expiresAt?: number;
  /** 最近一次用的时间，毫秒；只记在内存里，下次存盘时带上。 */
  usedAt?: number;
}


/** 带状态码的错误：管令牌的接口抛它，route 照状态码回。 */
class Failure extends Error {
  /**
   * @param status 状态码：400 请求不对，404 没有这个令牌。
   * @param message 一句话。
   */
  constructor(readonly status: number, message: string) {
    super(message);
  }
}


/** 令牌表。只由 Http 的构造函数来建。 */
export class Tokens {
  /** data/tokens.json 里的令牌，内存里的一份。 */
  private list: TokenInfo[] = [];

  /**
   * 读令牌文件，在 http.app 上登记管令牌的四个接口。
   * @param http HTTP 服务：登记接口、查是不是本机。
   * @param file 令牌文件 data/tokens.json 的绝对路径。
   * @param fixed 固定的主令牌 server.token；空串表示没有。
   * 副作用：读文件。
   */
  constructor(
    private readonly http: Http,
    private readonly file: string,
    private readonly fixed: string,
  ) {
    //M 文件是外面进来的：读不出来（没有、坏了）就当空表，和 0.4 一样。
    try {
      this.list = JSON.parse(fs.readFileSync(file, 'utf8')) as TokenInfo[];
    } catch {
      this.list = [];
    }

    //M 四个接口：列（新的在前）、建、刷新（换新值，临时的重新计时）、删。
    const app = http.app;
    app.get('/api/tokens', (request, reply) => {
      return this.route(request, reply, () => this.list.toSorted((a, b) => b.createdAt - a.createdAt));
    });
    app.post<{ Body: { name?: unknown; minutes?: unknown } | null }>('/api/tokens', (request, reply) => {
      return this.route(request, reply, () => this.create(request.body ?? {}));
    });
    app.post<{ Params: { id: string } }>('/api/tokens/:id/refresh', (request, reply) => {
      return this.route(request, reply, () => this.refresh(request.params.id));
    });
    app.delete<{ Params: { id: string } }>('/api/tokens/:id', (request, reply) => {
      return this.route(request, reply, () => {
        this.find(request.params.id);
        this.list = this.list.filter((item) => item.id !== request.params.id);
        this.save();
        return { ok: true };
      });
    });
  }

  /** @returns 一个能用的令牌都没有（没有主令牌，文件里的也都过期了）：这时候外面来的请求不查。 */
  none(): boolean {
    return this.fixed === '' && !this.list.some((item) => this.alive(item));
  }

  /**
   * 这个值是不是一个有效的令牌；是文件里的就记下用的时间。
   * @param value 请求带来的值；空串一定不对。
   * @returns 有效是 true。
   */
  check(value: string): boolean {
    if (value === '') return false;

    if (value === this.fixed) return true;

    const token = this.list.find((item) => item.value === value && this.alive(item));
    if (token === undefined) return false;

    token.usedAt = Date.now();
    return true;
  }

  /**
   * 管令牌的四个接口共用：不是本机回 403；act 抛 Failure 照它的状态码回；否则回 act 的结果。
   * @param request 请求。
   * @param reply 回应。
   * @param act 这个接口要做的事。
   * @returns 回给浏览器的东西。
   */
  private async route(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
    act: () => unknown,
  ): Promise<unknown> {
    if (!this.http.isLocal(request)) {
      await reply.code(403).send({ error: '令牌只能在本机管' });
      return reply;
    }
    try {
      return act();
    } catch (error) {
      if (!(error instanceof Failure)) throw error;

      await reply.code(error.status).send({ error: error.message });
      return reply;
    }
  }

  /**
   * 建一个令牌。请求体是外面进来的，在这里校验一次。
   * @param body { name, minutes? }：minutes 不写、null、0 是永久。
   * @returns 新的令牌。
   * @throws name 空、minutes 不是正数时抛 Failure(400)。
   * 副作用：写令牌文件。
   */
  private create(body: { name?: unknown; minutes?: unknown }): TokenInfo {
    const label = typeof body.name === 'string' ? body.name.trim() : '';
    if (label === '') {
      throw new Failure(400, '要写 name：给谁用的');
    }
    const minutes = body.minutes === undefined || body.minutes === null || body.minutes === 0
      ? undefined
      : Number(body.minutes);
    if (minutes !== undefined && !(minutes > 0)) {
      throw new Failure(400, `临时令牌的分钟数要大于 0，现在是 ${String(body.minutes)}`);
    }
    const now = Date.now();
    const token: TokenInfo = {
      id: `${String(now)}${crypto.randomBytes(3).toString('hex')}`,
      name: label,
      value: `jmb_${crypto.randomBytes(18).toString('base64url')}`,
      createdAt: now,
      ...(minutes === undefined ? {} : { minutes, expiresAt: now + minutes * 60_000 }),
    };
    this.list.push(token);
    this.save();
    return token;
  }

  /**
   * 刷新一个令牌：换一个新值（旧值马上失效）；临时的从现在重新计时。
   * @param id 号。
   * @returns 刷新后的令牌。
   * @throws 没有这个号时抛 Failure(404)。
   * 副作用：写令牌文件。
   */
  private refresh(id: string): TokenInfo {
    const token = this.find(id);
    token.value = `jmb_${crypto.randomBytes(18).toString('base64url')}`;
    if (token.minutes !== undefined) {
      token.expiresAt = Date.now() + token.minutes * 60_000;
    }
    this.save();
    return token;
  }

  /**
   * 照号找一个令牌。
   * @param id 号。
   * @returns 那一个。
   * @throws 没有时抛 Failure(404)。
   */
  private find(id: string): TokenInfo {
    const token = this.list.find((item) => item.id === id);
    if (token === undefined) {
      throw new Failure(404, `没有令牌 ${id}`);
    }
    return token;
  }

  /**
   * @param token 文件里的一个令牌。
   * @returns 没过期（永久的一直没过期）。
   */
  private alive(token: TokenInfo): boolean {
    return token.expiresAt === undefined || token.expiresAt > Date.now();
  }

  /** 写令牌文件：先写 .tmp 再改名，写到一半断电也不会坏。 */
  private save(): void {
    fs.writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.list, null, 2)}\n`, 'utf8');
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
