/**
 * 访问令牌：别的机器来的 /api/、/files/ 请求要带一个有效的令牌。
 * 两种来源：config.yaml 的 server.token（固定的主令牌，不列出来、不能在这里删），
 * 加上存在运行时 data/tokens.json 里的多个令牌（每个有名字，永久或临时几分钟）。和 0.4 同一个文件、同一种格式。
 * 管令牌的四个接口也在这里，只许本机：局域网带着令牌也不行，免得临时令牌给自己换出永久的。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type * as fastify from 'fastify';
import * as filesModule from '../../utils/Files.ts';
import type { Http } from './index.ts';
import * as failureModule from '../../utils/Failure.ts';


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


/** 令牌表。只由 Http 的构造函数来建。 */
export class Tokens {
  /** data/tokens.json 里的令牌，内存里的一份。 */
  private list: TokenInfo[] = [];

  /**
   * 读令牌文件，在 http.app 上登记管令牌的四个接口。
   * @param http HTTP 服务：登记接口、查是不是本机。
   * @param file 令牌文件 data/tokens.json 的绝对路径。
   * @param fixed 固定的主令牌 server.token；空串表示没有。
   * 副作用：读令牌文件，并在 `http.app` 上登记四条本机令牌管理接口。
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

  /**
   * 判断当前是否没有任何可用令牌（无主令牌且动态令牌也都过期）。
   * @returns 一个能用的令牌都没有时为 true（此时外部请求免校验）。
   */
  none(): boolean {
    //M 无主令牌且没有未过期的动态令牌时，对外免除令牌拦截。
    return this.fixed === '' && !this.list.some((item) => this.alive(item));
  }

  /**
   * 这个值是不是一个有效的令牌；是文件里的就记下用的时间。
   * @param value 请求带来的值；空串一定不对。
   * @returns 有效是 true。
   * 副作用：命中文件里的动态令牌时，在内存更新其 `usedAt` 时间戳。
   */
  check(value: string): boolean {
    if (value === '') return false;

    if (value === this.fixed) return true;

    //M 未命中主令牌时检索未过期的动态令牌，命中则视为有效并记录最近使用时间。
    const token = this.list.find((item) => item.value === value && this.alive(item));
    if (token === undefined) return false;

    token.usedAt = Date.now();
    return true;
  }

  /**
   * 管令牌的四个接口共用本机校验，通过后执行对应操作。
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
    //G 令牌管理接口只允许本机调用，防止局域网凭临时令牌给自己签发永久令牌。
    if (!this.http.isLocal(request)) {
      await reply.code(403).send({ error: '令牌只能在本机管' });
      return reply;
    }
    //M 本机校验通过后执行操作，失败交给 HTTP 插件返回。
    return act();
  }

  /**
   * 建一个令牌。请求体是外面进来的，在这里校验一次。
   * @param body { name, minutes? }：minutes 不写、null、0 是永久。
   * @returns 新的令牌。
   * @throws name 空、minutes 不是正数时抛 Failure(400)。
   * 副作用：写令牌文件。
   */
  private create(body: { name?: unknown; minutes?: unknown }): TokenInfo {
    let label = '';
    if (typeof body.name === 'string') {
      label = body.name.trim();
    }
    //G 令牌名称为空时回 400 拒绝创建，确保每条令牌都有明确用途说明。
    if (label === '') {
      throw new failureModule.Failure(400, '要写 name：给谁用的');
    }
    let minutes: number | undefined;
    if (body.minutes !== undefined && body.minutes !== null && body.minutes !== 0) {
      minutes = Number(body.minutes);
    }
    //G 指定了有效分钟数时校验必须为正数，否则回 400。
    if (minutes !== undefined && !(minutes > 0)) {
      throw new failureModule.Failure(400, `临时令牌的分钟数要大于 0，现在是 ${String(body.minutes)}`);
    }
    const now = Date.now();
    const token: TokenInfo = {
      id: `${String(now)}${crypto.randomBytes(3).toString('hex')}`,
      name: label,
      value: `jmb_${crypto.randomBytes(18).toString('base64url')}`,
      createdAt: now,
    };
    if (minutes !== undefined) {
      token.minutes = minutes;
      token.expiresAt = now + minutes * 60_000;
    }
    //M 将新令牌记入内存列表并原子写盘保存，立即生效。
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
    //M 按 ID 查找要刷新的令牌，不存在时抛出 404。
    const token = this.find(id);
    token.value = `jmb_${crypto.randomBytes(18).toString('base64url')}`;
    if (token.minutes !== undefined) {
      token.expiresAt = Date.now() + token.minutes * 60_000;
    }
    //M 将更新后的令牌值与过期时间原子写盘保存。
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
    //G 按 ID 查找令牌，不存在时统一抛出 404 供上层路由返回。
    const token = this.list.find((item) => item.id === id);
    if (token === undefined) {
      throw new failureModule.Failure(404, `没有令牌 ${id}`);
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

  /** 写令牌文件：先写临时文件再改名（utils/Files.ts 的 writeTextAtomic），写到一半断电也不会坏；改名失败就抛错，不退回直接写。 */
  private save(): void {
    const text = `${JSON.stringify(this.list, null, 2)}\n`;
    //M 将完整令牌表原子写盘持久化，防止写一半断电损坏 tokens.json。
    filesModule.writeTextAtomic(this.file, text);
  }
}
