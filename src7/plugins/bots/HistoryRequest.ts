/**
 * 发出 channel/history 请求，等渠道插件回 channel/history-result。只有 bots 的历史工具用，所以放在 bots 里。
 */
import type * as cordis from 'cordis';
import * as protocol from '../../Channels.ts';
import * as requestEvents from '../../utils/RequestEvent.ts';


/**
 * 发出 channel/history 请求并按局部 requestId 等待 channel/history-result。
 * @param ctx Cordis 上下文。
 * @param req 历史查询请求。
 * @param timeoutMs 超时毫秒数。
 * @returns 历史查询结果。
 */
export async function requestChannelHistory(
  ctx: cordis.Context,
  req: Omit<protocol.ChannelHistoryRequest, 'requestId'>,
  timeoutMs = 15_000,
): Promise<protocol.ChannelHistoryResult> {
  const scope = req.sourceSnapshot.visibility.scope;
  //M 保留历史工具原有的错误码，调用者可以区分没人接、超时与异常。
  const onFallback = (cause: requestEvents.FallbackReason, detail?: string): protocol.ChannelHistoryResultEvent => {
    let code = 'history_timeout';
    let message = '等待渠道历史结果超时';
    if (cause === 'unhandled') {
      code = 'channel_unavailable';
      message = `渠道 ${req.channel} 不支持或未接入历史查询`;
    }
    if (cause === 'error') {
      code = 'history_error';
      message = detail ?? '';
    }
    const failed = protocol.getHistoryError(scope, 'unsupported', code, message);
    return { ...failed, requestId: '' };
  };

  const options = { prefix: 'his', timeoutMs, keepAlive: true, onFallback };
  //M 公共工具按请求号等结果，信封字段留在协议层，避免进入模型的工具结果。
  const event = await requestEvents.requestEvent(ctx, 'channel/history', 'channel/history-result', req, options);
  const result: protocol.ChannelHistoryResult = {
    ok: event.ok,
    items: event.items,
    nextCursor: event.nextCursor,
    scope: event.scope,
    completeness: event.completeness,
  };
  if (event.error !== undefined) {
    result.error = event.error;
  }
  return result;
}
