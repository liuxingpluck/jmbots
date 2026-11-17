/**
 * 基地服务：入口读一次 engine.index_url，ctx.base 统一处理地址、JSON 请求和超时。
 * 网页的更新、自启、记忆库、RAG 接口原样转给基地；没配地址或基地没响应统一回 503。
 * 基地自己的 HTTP 状态码、类型和正文原样保留。设计：docs/src7插件设计/base-bridge.md。
 */
import * as cordis from 'cordis';
import type * as fastify from 'fastify';

//M 服务只依赖配置；HTTP 路由等 http 就绪再登记，其他插件也能单独使用基地请求。
export const name = 'base-bridge';
export const inject = ['resources'];

declare module 'cordis' {
  interface Context {
    base: Base;
  }
}

/** 基地回的状态和正文；调用方按业务处理 404、409 等响应，连接失败才抛错。 */
export interface BaseReply {
  status: number;
  body: unknown;
}

/** 网页路径对应的基地路径，以及是否原样带查询串。 */
interface Route {
  method: 'GET' | 'POST';
  from: string;
  to: string;
  query: boolean;
}

//M 八条转发都采用同一套故障口径，不再用空列表伪装基地在线。
const ROUTES: Route[] = [
  { method: 'GET', from: '/api/update', to: '/update', query: false },
  { method: 'POST', from: '/api/update/apply', to: '/update/apply', query: false },
  { method: 'GET', from: '/api/autostart', to: '/autostart', query: false },
  { method: 'POST', from: '/api/autostart', to: '/autostart', query: false },
  { method: 'GET', from: '/api/memory/health', to: '/health', query: true },
  { method: 'GET', from: '/api/memory/search', to: '/search', query: true },
  { method: 'GET', from: '/api/rag/search', to: '/rag/search', query: true },
  { method: 'POST', from: '/api/rag/index', to: '/rag/index', query: false },
];
const TIMEOUT_MS = 15_000;

/** 基地请求服务；url 已在插件入口校验，空串表示没配。 */
export class Base extends cordis.Service {
  constructor(ctx: cordis.Context, readonly url: string) {
    super(ctx, 'base');
  }

  /** GET JSON，返回 HTTP 状态和解析后的正文。 */
  getJson(route: string, timeoutMs: number): Promise<BaseReply> {
    return this.json('GET', route, timeoutMs);
  }

  /** POST JSON；route 也接受 notify.url 的完整地址，保留单独通知地址的配置。 */
  postJson(route: string, body: unknown, timeoutMs: number): Promise<BaseReply> {
    return this.json('POST', route, timeoutMs, body);
  }

  /** 地址拼接、请求体和超时集中在这里；没配地址和网络故障保留不同原因。 */
  private async request(method: 'GET' | 'POST', route: string, timeoutMs: number, body?: unknown): Promise<Response> {
    //M 完整地址用于 notify.url；其余调用都使用入口处理好的基地地址。
    const absolute = /^https?:\/\//iu.test(route);
    if (!absolute && this.url === '') throw new Error('没配 engine.index_url');
    const url = absolute ? route : this.url + route;
    try {
      return await fetch(url, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        ...(method === 'GET' ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      });
    } catch {
      throw new Error('基地没响应');
    }
  }

  /** 读完响应也在请求的超时内；空正文和旧接口的纯文本照样交给调用方。 */
  private async json(method: 'GET' | 'POST', route: string, timeoutMs: number, body?: unknown): Promise<BaseReply> {
    const response = await this.request(method, route, timeoutMs, body);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new Error('基地没响应');
    }
    //M HTTP 错误不等于断连：记忆摄取的 409、旧基地的 404 要由调用方判断。
    let result: unknown = text;
    try {
      result = text === '' ? undefined : JSON.parse(text) as unknown;
    } catch {
      //M 旧接口可能回纯文本；通知等调用只需要状态码。
    }
    return { status: response.status, body: result };
  }

  /** 网页转发保留基地的原始状态、类型和正文。 */
  async forward(route: Route, request: fastify.FastifyRequest, reply: fastify.FastifyReply): Promise<fastify.FastifyReply> {
    //M 查询串不拆开重组，避免改变检索参数的编码。
    const mark = request.url.indexOf('?');
    const target = route.to + (route.query && mark >= 0 ? request.url.slice(mark) : '');
    try {
      const response = await this.request(route.method, target, TIMEOUT_MS, route.method === 'POST' ? request.body ?? {} : undefined);
      const text = await response.text();
      const type = response.headers.get('content-type') ?? 'application/json; charset=utf-8';
      return reply.code(response.status).type(type).send(text);
    } catch {
      const error = this.url === '' ? '没配 engine.index_url' : '基地没响应';
      return reply.code(503).send({ error });
    }
  }
}

/** 入口校验地址一次，再登记服务和可选的 HTTP 转发。 */
export function apply(ctx: cordis.Context): void {
  const raw = (ctx.resources.raw['engine'] as Record<string, unknown> | undefined)?.['index_url'];
  if (raw !== undefined && typeof raw !== 'string') throw new Error('engine.index_url 要是字符串');
  const url = (raw ?? '').trim().replace(/\/+$/u, '');
  //M 空串允许独立运行；非空地址必须是 HTTP(S)，写错就停本插件，其他可选调用方仍能启动。
  if (url !== '') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('engine.index_url 要是完整的 HTTP(S) 地址');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search !== '' || parsed.hash !== '') {
      throw new Error('engine.index_url 要是 HTTP(S) 地址，不能带查询串或片段');
    }
  }
  const base = new Base(ctx, url);
  //M 服务与 HTTP 分开挂，没装 http 的工具会话也能使用 ctx.base。
  void ctx.inject(['http'], (sub) => {
    for (const route of ROUTES) {
      sub.http.app.route({
        method: route.method,
        url: route.from,
        handler: (request, reply) => base.forward(route, request, reply),
      });
    }
  });
}
