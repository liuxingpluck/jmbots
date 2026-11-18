/**
 * relay 的两条 HTTP 接口：外部助手轮询收件、交回信。
 * 令牌由 http 统一查（本机来的不查，别的机器要带令牌），这里不另外查。请求里的东西在这里校验一次。
 */
import type * as fastify from 'fastify';
import type { Http } from '../http/index.ts';
import type { Relay } from './index.ts';
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
  //M 收件：外部助手定时来拉自己的那几条；查询参数在这里转成数、查一遍，出错由 answer 回 400。
  http.app.get<{ Querystring: Record<string, unknown> }>('/api/relay/inbox', (request, reply) => {
    return answer(reply, () => {
      const query = request.query;
      const since = whole(query['since'], 0, 'since');
      let limit = Math.min(whole(query['limit'], 50, 'limit'), 200);
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
  });
  //M 回信：正文原样交给 relay.accept 查和落库，来源记成 http。
  http.app.post<{ Body: unknown }>('/api/relay/reply', (request, reply) => {
    return answer(reply, () => ({ ok: true, item: relay.accept(request.body, 'http') }));
  });
}


/**
 * 两条接口共用：act 抛 Failure 照它的状态码回；否则回 act 的结果。
 * @param reply 回应。
 * @param act 这条接口要做的事。
 * @returns 回给调用方的东西。
 */
async function answer(reply: fastify.FastifyReply, act: () => unknown): Promise<unknown> {
  try {
    //M 跑这条接口自己的事，结果原样交给 Fastify 回。
    return act();
  } catch (error) {
    //G 不是 Failure 的（程序自己的错）原样抛，让 Fastify 回 500。
    if (!(error instanceof failureModule.Failure)) throw error;

    //M Failure 是查参数时抛的：照它带的状态码回 { error }。
    await reply.code(error.status).send({ error: error.message });
    return reply;
  }
}


/**
 * 查询参数里的非负整数。
 * @param value 查询参数的值。
 * @param fallback 没写时用它。
 * @param key 参数名，报错用。
 * @returns 整数。
 * @throws 写了但不是非负整数时抛 Failure(400)。
 */
function whole(value: unknown, fallback: number, key: string): number {
  if (value === undefined || value === '') return fallback;
  //M 查询参数都是字符串：先转成数，不是非负整数就 400。
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new failureModule.Failure(400, `${key} 要写成非负整数`);
  return number;
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
