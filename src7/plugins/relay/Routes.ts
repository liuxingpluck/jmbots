/**
 * relay 的两条 HTTP 接口：外部助手轮询收件、交回信。
 * 令牌由 http 统一查（本机来的不查，别的机器要带令牌），这里不另外查。请求里的东西在这里校验一次。
 */
import type * as fastify from 'fastify';
import type { Http } from '../http/index.ts';
import type { Relay } from './index.ts';


/** 带状态码的错误：relay 抛它，接口照状态码回。 */
export class Failure extends Error {
  /**
   * @param status 状态码：400 请求不对，404 没有这个收件号。
   * @param message 一句话。
   */
  constructor(readonly status: number, message: string) {
    super(message);
  }
}


/** 收件的三种状态，GET /api/relay/inbox 的 state 只许写这几个。 */
const STATES = new Set(['pending', 'replied', 'expired']);


/**
 * 在 http.app 上登记两条接口。要在 ready（开始监听）之前调。
 *   GET  /api/relay/inbox?since=&bot=&state=&helper=&limit=  → { items, last }
 *   POST /api/relay/reply { id | chat, text, bot?, helper?, reply_to?, file?, done? } → { ok: true, item }
 * @param http HTTP 服务。
 * @param relay relay 插件本体。
 */
export function routes(http: Http, relay: Relay): void {
  http.app.get<{ Querystring: Record<string, unknown> }>('/api/relay/inbox', (request, reply) => {
    return answer(reply, () => {
      const query = request.query;
      const since = whole(query['since'], 0, 'since');
      const limit = Math.min(whole(query['limit'], 50, 'limit'), 200);
      const only = { bot: text(query['bot']), state: text(query['state']), helper: text(query['helper']) };
      if (only.state !== undefined && !STATES.has(only.state)) {
        throw new Failure(400, 'state 只能写 pending、replied、expired');
      }
      return relay.list(since, limit === 0 ? 50 : limit, only);
    });
  });
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
    return act();
  } catch (error) {
    if (!(error instanceof Failure)) throw error;

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
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Failure(400, `${key} 要写成非负整数`);
  return number;
}


/**
 * 查询参数里的字符串；没写、空串是 undefined。
 * @param value 查询参数的值。
 * @returns 字符串或 undefined。
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
