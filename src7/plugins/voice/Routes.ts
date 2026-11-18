/** 语音线路标记、固定失败原因及本地模型的资源准入。 */

import type * as cordis from 'cordis';
import * as events from '../../utils/RequestEvent.ts';

export type Place = 'local' | 'cloud';
export type Stage = 'asr' | 'tts' | 'judge' | 'turn';
export type Report = (place: Place, reason?: string) => void;

/** 只保留可公开的失败原因，不传供应商响应或凭据。 */
export class RouteFailure extends Error {}

/** 输入仅用于本地资源准入，未收到回执时不启动模型。 */
export async function allowLocal(ctx: cordis.Context, signal?: AbortSignal, heavy = true): Promise<void> {
  const request = { action: 'can-start', who: 'voice', heavy } as const;
  const options = {
    signal,
    timeoutMs: 2000,
    onFallback: () => ({ requestId: '', ok: false, reason: '资源守卫未放行' }),
  };
  //G 本地模型加载先取得 programs 的实时资源回执。
  const checked = await events.requestEvent(ctx, 'resource/request', 'resource/result', request, options);
  if (!checked.ok) {
    const reason = checked.reason;
    throw new RouteFailure(reason);
  }
}

/** 把鉴权、超时等上游失败归一为可记录的语音切换原因。 */
export function getFailure(error: unknown, fallback: string): string {
  if (error instanceof RouteFailure) return error.message;

  if (error instanceof Error && error.name === 'TimeoutError') return '上游超时';

  return fallback;
}

/** 对云端状态码给出固定原因，避免把响应原文写入 trace。 */
export function getHttpFailure(status: number): RouteFailure {
  //G 限流和额度问题共用一条可安全公开的原因。
  if (status === 429 || status === 402) return new RouteFailure('云端额度不足或限流');

  //G 认证拒绝不暴露上游返回的凭据信息。
  if (status === 401 || status === 403) return new RouteFailure('云端授权拒绝');

  //G 其它非成功状态使用固定的服务失败提示。
  return new RouteFailure('云端服务未接受请求');
}
