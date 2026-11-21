/**
 * relay 的两条 HTTP 接口：外部助手轮询收件、交回信。
 * 令牌由 http 统一查（本机来的不查，别的机器要带令牌），这里不另外查。请求里的东西在这里校验一次。
 */
import type { Http } from '../http/index.ts';
import type { Relay } from './index.ts';
import * as checks from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';


/** 收件的三种状态，GET /api/relay/inbox 的 state 只许写这几个。 */
const STATES = new Set(['pending', 'replied', 'expired']);


/**
 * 在 http.app 上登记两条接口。要在 ready（开始监听）之前调。
 *   GET  /api/relay/inbox?since=&bot=&state=&helper=&limit=  → { items, last }
 *   POST /api/relay/reply { id | chat, text, bot?, helper?, reply_to?, file?, done? } → { ok: true, item }
 * @param http HTTP 服务。
 * @param relay relay 插件本体。
 * 副作用：在 http.app 上加两条路由。
 */
export function routes(http: Http, relay: Relay): void {
  //M 收件：外部助手定时来拉自己的那几条；查询参数在这里转成数、查一遍，参数不对就抛带 400 的业务错误。
  http.app.get<{ Querystring: Record<string, string | undefined> }>('/api/relay/inbox', (request) => {
    const query = request.query;
    const since = checks.checkCount(query['since'], 'since') ?? 0;
    let limit = Math.min(checks.checkCount(query['limit'], 'limit') ?? 50, 200);
    if (limit === 0) {
      limit = 50;
    }
    //M 三个筛选条件：没写、空串都当不筛（text 回 undefined）。
    const only = { bot: text(query['bot']), state: text(query['state']), helper: text(query['helper']) };
    //G state 写了别的词：直接 400，不拿去查。
    if (only.state !== undefined && !STATES.has(only.state)) {
      throw new failureModule.Failure(400, 'state 只能写 pending、replied、expired');
    }
    //M 使用公开的 InboxItem 视图回 { items, last }，owner 是布尔值，回话地址留在库里。
    return relay.list(since, limit, only);
  });
  //M 回信：正文原样交给 relay.accept 查和落库，来源记成 http。
  http.app.post<{ Body: unknown }>('/api/relay/reply', (request) => {
    const item = relay.accept(request.body, 'http');
    return { ok: true, item };
  });
}


/**
 * 查询参数里的字符串；没写、空串是 undefined。
 * @param value 查询参数的值。
 * @returns 字符串或 undefined。
 */
function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;

  return undefined;
}
