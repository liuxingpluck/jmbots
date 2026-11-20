/**
 * 基地服务、基地通知与更新监听（由 base-bridge 与原 notify、update-watch 合并）：
 *   1. Base 服务（ctx.base）与更新、自启动的网页接口；
 *   2. 通知模块（Notify.ts，默认关闭）：config.notify 开启时登记 notify_user 工具并转发待确认/长任务结束 toast；
 *   3. 更新监听（UpdateWatch.ts，默认关闭）：config.update_watch 开启时定时检查 GET /update，卸载时清理定时器。
 * 设计见同目录 说明.md 的「设计要点」一节（含 update-watch）。
 */
import * as cordis from 'cordis';
import type * as fastify from 'fastify';
import { onRequestEvent, type RequestEnvelope, type ResultEnvelope } from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as notifyModule from './Notify.ts';
import * as updateWatchModule from './UpdateWatch.ts';


export { mountNotify, readNotifySettings, type NotifySettings } from './Notify.ts';
export { mountUpdateWatch, readUpdateWatchSettings, UpdateWatch, type UpdateWatchSettings } from './UpdateWatch.ts';


//M 服务只依赖配置；HTTP、tools、更新监听各自按需 inject，其他最小单测只挂 resources 就能用 ctx.base。
export const name = 'base-bridge';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.2.5';
export const inject = ['resources'];

/** 基地子模块共享的地址配置路径，供错误提示使用。 */
const INDEX_URL_PATH = 'plugins[base-bridge].config.index_url';

/** base/request 请求载荷，settings 和 web-api 用它向基地请求重启等操作。 */
export interface BaseRequest extends RequestEnvelope {
  /** GET 还是 POST。 */
  method: 'GET' | 'POST';
  /** 相对基地根地址的路径（如 /version、/restart）；也可以是完整的 HTTP(S) 地址。 */
  route: string;
  /** 基地这次请求最多等多久，毫秒；发的一方 requestEvent 的等待要比它多 1 秒，让这边先把结构化的错误交回。 */
  timeoutMs: number;
  /** POST 的 JSON 正文；GET 不用。 */
  body?: unknown;
}

/** base/result 回执载荷。 */
export interface BaseResult extends ResultEnvelope {
  /** 基地回了话（不管状态码）是 true；没配地址、连不上、超时是 false。 */
  ok: boolean;
  /** 基地回的 HTTP 状态码；404、409 这类由发的一方自己判断。 */
  status?: number;
  /** 基地回的正文：能解析成 JSON 的是对象，旧接口的纯文本原样，空正文没有。 */
  body?: unknown;
  /** ok 是 false 时的原因：“没配基地地址”“基地没响应”。 */
  error?: string;
}

declare module 'cordis' {
  interface Context {
    /** 基地服务，实现在 src7/plugins/base-bridge/index.ts；别的插件改发 base/request，本插件内部（通知、更新监听）照旧用它。 */
    base: Base;
  }
  interface Events {
    /**
     * 请求（serial）：向基地转发 GET / POST JSON 请求。本插件听，回 base/result。
     * 谁发：src7/plugins/settings/index.ts 的 Settings.askBase；src7/plugins/web-api/index.ts 的 WebApi.shellVersion
     * 谁接：src7/plugins/base-bridge/index.ts 的 Base.constructor
     */
    'base/request'(request: BaseRequest): void | Promise<void>;
    /**
     * 回执（emit）：基地响应或断连错误回执，按 requestId 配对。
     * 谁发：src7/plugins/base-bridge/index.ts 的 Base.constructor
     * 谁接：src7/plugins/settings/index.ts 的 Settings.askBase；src7/plugins/web-api/index.ts 的 WebApi.shellVersion
     */
    'base/result'(result: BaseResult): void;
  }
}

/** 基地回的状态和正文；调用方按业务处理 404、409 等响应，连接失败才抛错。 */
export interface BaseReply {
  status: number;
  body: unknown;
}

/** 网页路径对应的基地路径。 */
interface Route {
  method: 'GET' | 'POST';
  from: string;
  to: string;
}

//M 基地的网页接口只保留更新和自启动。记忆检索由 memory 插件直连。
const ROUTES: Route[] = [
  { method: 'GET', from: '/api/update', to: '/update' },
  { method: 'POST', from: '/api/update/apply', to: '/update/apply' },
  { method: 'GET', from: '/api/autostart', to: '/autostart' },
  { method: 'POST', from: '/api/autostart', to: '/autostart' },
];
const TIMEOUT_MS = 15_000;

/** 基地请求服务；url 已在插件入口校验，空串表示没配。 */
export class Base extends cordis.Service {
  /**
   * 创建基地 HTTP 客户端并注册为 Cordis `base` 服务。
   * @param ctx Cordis 上下文。
   * @param url 去掉末尾斜杠的基地根地址；空串表示未配置。
   * 副作用：将当前实例注册为 `ctx.base` 服务。
   */
  constructor(ctx: cordis.Context, readonly url: string) {
    super(ctx, 'base');

    //M 没配地址、连不上、超时（getJson、postJson 抛的错）由 onError 转成 { ok: false, error }，发的一方不干等。
    const requestOptions = {
      onError: (error: unknown) => {
        const message = textModule.getErrorMessage(error);
        return { ok: false, error: message };
      },
    };

    //M 设置和网页插件发请求请基地办事，办完回 base/result。
    onRequestEvent(
      ctx,
      'base/request',
      'base/result',
      (request) => this.onRequest(request),
      requestOptions,
    );
  }

  /**
   * 响应 base/request：GET 调 getJson，POST 调 postJson，原样交回状态码和正文。
   * @param request 别的插件用 requestEvent 发来的请求。
   * @returns 回执正文：ok 是 true，带基地的状态码和正文。
   * @throws 没配地址、基地没响应时 getJson、postJson 抛的错原样抛，由 onRequestEvent 的 onError 转成 { ok: false, error }。
   */
  private async onRequest(request: BaseRequest): Promise<Omit<BaseResult, 'requestId'>> {
    //T 跟踪：别的插件经事件请基地办事。
    const vars = { method: request.method, path: request.route, requestId: request.requestId };
    this.ctx.emit('trace', 'Base.onRequest', 'trace.base.request', `base/request（${request.method}）`, vars);

    //M GET：问基地要 JSON。
    if (request.method === 'GET') {
      const reply = await this.getJson(request.route, request.timeoutMs);
      return { ok: true, status: reply.status, body: reply.body };
    }

    //M POST：带正文发给基地。
    const reply = await this.postJson(request.route, request.body, request.timeoutMs);
    return { ok: true, status: reply.status, body: reply.body };
  }

  /**
   * 向基地发送 GET 请求并解析 JSON 响应。
   * @param route 相对基地根地址的路径（或完整 HTTP(S) 地址）。
   * @param timeoutMs 请求与读取响应体的超时时间（毫秒）。
   * @returns HTTP 状态码与解析后的正文。
   * @throws 未配置基地地址、网络故障或超时时抛错。
   */
  getJson(route: string, timeoutMs: number): Promise<BaseReply> {
    //M 复用统一的 json 封装发起 GET 请求并按状态码/正文规则交回结果。
    return this.json('GET', route, timeoutMs);
  }

  /**
   * 向基地发送 POST JSON 请求；route 也接受 notify.url 的完整地址，保留单独通知地址的配置。
   * @param route 相对基地根地址的路径，或完整的 HTTP(S) 地址。
   * @param body 要序列化为 JSON 的请求体。
   * @param timeoutMs 请求与读取响应体的超时时间（毫秒）。
   * @returns HTTP 状态码与解析后的正文。
   * @throws 未配置基地地址、网络故障或超时时抛错。
   */
  postJson(route: string, body: unknown, timeoutMs: number): Promise<BaseReply> {
    //M 复用统一的 json 封装发起 POST 请求并带回基地响应给业务方判断。
    return this.json('POST', route, timeoutMs, body);
  }

  /** 地址拼接、请求体和超时集中在这里；没配地址和网络故障保留不同原因。 */
  private async request(method: 'GET' | 'POST', route: string, timeoutMs: number, body?: unknown): Promise<Response> {
    //M 完整地址用于 notify.url；其余调用都使用入口处理好的基地地址。
    const absolute = /^https?:\/\//iu.test(route);
    if (!absolute && this.url === '') throw new Error(`没配 ${INDEX_URL_PATH}`);

    let url = this.url + route;
    if (absolute) {
      url = route;
    }
    const init: RequestInit = {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (method !== 'GET') {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    try {
      return await fetch(url, init);
    } catch {
      throw new Error('基地没响应');
    }
  }

  /** 读完响应也在请求的超时内；空正文和旧接口的纯文本照样交给调用方。 */
  private async json(method: 'GET' | 'POST', route: string, timeoutMs: number, body?: unknown): Promise<BaseReply> {
    //M 先拿到原始 Response，再在下面统一于超时内读取响应体并尝试解析 JSON。
    const response = await this.request(method, route, timeoutMs, body);
    let text: string;
    try {
      //M 超时窗口内把响应体读成文本，读取失败视作基地断连。
      text = await response.text();
    } catch {
      throw new Error('基地没响应');
    }
    if (text === '') return { status: response.status, body: undefined };

    //M 保留上游状态，调用方据业务处理错误。
    let result: unknown = text;
    try {
      result = JSON.parse(text) as unknown;
    } catch {
      //M 旧接口可能回纯文本；通知等调用只需要状态码。
    }
    return { status: response.status, body: result };
  }

  /**
   * 网页转发保留基地的原始状态、类型和正文；未配置基地地址或基地断连时回 503。
   * @param route 转发路由配置（方法和目标路径）。
   * @param request Fastify 传入的前端请求。
   * @param reply Fastify 响应对象。
   * @returns 已写入状态码、内容类型与正文的 reply。
   */
  async forward(
    route: Route,
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    let bodyPayload: unknown;
    if (route.method === 'POST') {
      bodyPayload = request.body ?? {};
    }
    try {
      //M 当前转发的接口只需路径和 POST 正文。
      const response = await this.request(route.method, route.to, TIMEOUT_MS, bodyPayload);
      const text = await response.text();
      const type = response.headers.get('content-type') ?? 'application/json; charset=utf-8';
      return reply.code(response.status).type(type).send(text);
    } catch {
      let error = '基地没响应';
      if (this.url === '') {
        error = `没配 ${INDEX_URL_PATH}`;
      }
      //M 区分未配基地地址与基地无响应两种原因，统一以 503 JSON 告知前端。
      return reply.code(503).send({ error });
    }
  }
}

/**
 * 入口校验地址及 notify / update_watch 子配置一次，再登记 ctx.base 与可选子模块。
 * @param ctx Cordis 给本插件的上下文（依赖 resources）。
 * @param config `plugins[base-bridge].config`（可选，可含 `index_url`、`notify`、`update_watch`）。
 * @throws `config` 类型非法或 `index_url` 格式不合法时抛错。
 * 副作用：注册 `ctx.base` 服务；通过 `ctx.inject` 按需挂载 4 条转发路由、通知工具与更新监听。
 */
export function apply(ctx: cordis.Context, config?: unknown): void {
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new Error('base-bridge 配置要是对象');
  }
  const own = (config ?? {}) as Record<string, unknown>;
  //M 读取并校验 notify 与 update_watch 子配置，决定后续按需挂载哪些子模块。
  const notifySettings = notifyModule.readNotifySettings(own['notify']);
  const watchSettings = updateWatchModule.readUpdateWatchSettings(own['update_watch']);

  //M 基地服务、默认通知和更新监听共用一个校验后的地址。
  const raw = own['index_url'];
  if (raw !== undefined && typeof raw !== 'string') throw new Error(`${INDEX_URL_PATH} 要是字符串`);

  const url = (raw ?? '').trim().replace(/\/+$/u, '');
  //M 空串允许独立运行；非空地址必须是 HTTP(S)，写错就停本插件，其他可选调用方仍能启动。
  if (url !== '') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${INDEX_URL_PATH} 要是完整的 HTTP(S) 地址`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`${INDEX_URL_PATH} 要是 HTTP(S) 地址，不能带查询串或片段`);
    }
  }
  //M 校验通过后先向 ctx 登记 base 服务，供转发路由及后续插件使用。
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
  //M notify 与 update_watch 默认关闭；开启后才按各自依赖 inject，不影响无 tools 的轻量挂法。
  if (notifySettings.enabled) {
    void ctx.inject(['tools'], (sub) => {
      notifyModule.mountNotify(sub, notifySettings);
    });
  }
  //M 更新监听用 resources 读取默认机器人、sessions 找前台会话；待确认走 approval/request 事件，不再硬等 approval 挂上。
  if (watchSettings.enabled) {
    void ctx.inject(['sessions'], (sub) => {
      updateWatchModule.mountUpdateWatch(sub, watchSettings);
    });
  }
}
