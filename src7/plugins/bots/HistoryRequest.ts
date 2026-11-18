/**
 * 发出 channel/history 请求，等渠道插件回 channel/history-result。只有 bots 的历史工具用，所以放在 bots 里。
 */
import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import type { ChannelHistoryRequest, ChannelHistoryResult } from '../../Channels.ts';


/**
 * 发出 channel/history 请求并按局部 requestId 等待 channel/history-result。
 * @param ctx Cordis 上下文。
 * @param req 历史查询请求。
 * @param timeoutMs 超时毫秒数。
 * @returns 历史查询结果。
 */
export async function requestChannelHistory(
  ctx: cordis.Context,
  req: Omit<ChannelHistoryRequest, 'requestId'>,
  timeoutMs = 15_000,
): Promise<ChannelHistoryResult> {
  const requestId = `his_${crypto.randomUUID()}`;
  const fullRequest: ChannelHistoryRequest = { ...req, requestId };

  return await new Promise<ChannelHistoryResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispose: () => void = () => undefined;

    const finish = (result: ChannelHistoryResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      dispose();
      resolve(result);
    };

    //M 监听匹配本请求 requestId 的渠道历史回传事件并组装标准查询结果。
    dispose = ctx.on('channel/history-result', (event) => {
      if (event.requestId !== requestId) return;
      const result: ChannelHistoryResult = {
        ok: event.ok,
        items: event.items,
        nextCursor: event.nextCursor,
        scope: event.scope,
        completeness: event.completeness,
      };
      if (event.error !== undefined) {
        result.error = event.error;
      }
      //M 补齐可选 error 字段后结束等待并交回历史查询结果。
      finish(result);
    });

    //G 等待超时时以 history_timeout 收口，不悬空调用方工具轮。
    timer = setTimeout(() => {
      finish({
        ok: false,
        items: [],
        nextCursor: null,
        scope: req.sourceSnapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'history_timeout', message: '等待渠道历史结果超时' },
      });
    }, timeoutMs);

    //M 串行发出历史查询请求；若无渠道插件接单或抛出异常则返回明确错误码。
    void ctx.serial('channel/history', fullRequest).then(() => {
      if (settled) return;
      if (fullRequest.handled === true) return;
      //G 没有渠道接单时回报 channel_unavailable，方便上层提示用户或模型。
      finish({
        ok: false,
        items: [],
        nextCursor: null,
        scope: req.sourceSnapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'channel_unavailable', message: `渠道 ${req.channel} 不支持或未接入历史查询` },
      });
    }).catch((error: unknown) => {
      let message = String(error);
      if (error instanceof Error) {
        message = error.message;
      }
      //M 查询异常以 history_error 收口交回原因。
      finish({
        ok: false,
        items: [],
        nextCursor: null,
        scope: req.sourceSnapshot.visibility.scope,
        completeness: 'unsupported',
        error: { code: 'history_error', message },
      });
    });
  });
}
