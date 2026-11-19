/**
 * 通用请求-回执事件工具（#113 插件解耦底座）：
 *   1. requestEvent：先挂回执监听与超时/中止守卫，再 serial 派发请求；没人接单（handled !== true）立即退回，不傻等超时；
 *   2. onRequestEvent：统一在进入异步逻辑前标 handled = true，完成后仅当存在 requestId 时回发配对回执。
 * 说明：供插件之间一问一答，复用请求与回执的等待逻辑。渠道协议见 src7/Channels.ts。
 */
import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import * as textModule from './Text.ts';


/** 请求未获得正常业务回执时的退回原因。 */
export type FallbackReason = 'unhandled' | 'timeout' | 'aborted' | 'error';

/** 仅本地退回值附带的原因，配对的业务回执没有这个字段。 */
export interface RequestFallback {
  /** 未取得回执的原因。 */
  fallback?: FallbackReason;
}

/** 写操作未取得回执时，只有无人接单能确定对方未执行。 */
export function isUnsure(reply: RequestFallback): reply is { fallback: Exclude<FallbackReason, 'unhandled'> } {
  return reply.fallback !== undefined && reply.fallback !== 'unhandled';
}

/** 需要回执或接单判定的请求信封。 */
export interface RequestEnvelope {
  /** 局部请求号：供回执按 requestId 精确配对；不等回执的通知式指令可省略。 */
  requestId?: string;
  /** 是否有监听方接单（监听方应在首个 await 前同步设为 true）。 */
  handled?: boolean;
}

/** 回执事件必须携带的信封字段。 */
export interface ResultEnvelope {
  /** 与请求事件的 requestId 一一对应。 */
  requestId: string;
}

/** 从联合请求类型中剥离信封字段（保持联合分支结构）。 */
export type StripEnvelope<T> = T extends unknown ? Omit<T, 'requestId' | 'handled'> : never;

/** 从联合回执类型中剥离 requestId（保持联合分支结构）。 */
export type StripResultId<T> = T extends unknown ? Omit<T, 'requestId'> : never;

/** 提取单参数事件的参数类型；非单参事件返回 never。 */
export type EventArg<K extends keyof cordis.Events> =
  Parameters<cordis.Events[K]> extends [infer Arg] ? Arg : never;

/** 调用 requestEvent 的参数选项。 */
export interface RequestEventOptions<Res> {
  /** requestId 前缀，如 'apr'、'dec'、'cat'；不给默认 'req'。 */
  prefix?: string;
  /** 最长等待毫秒数。 */
  timeoutMs: number;
  /** 退出前仍要等到超时结果时，让定时器保持进程运行。 */
  keepAlive?: boolean;
  /** 可选中止信号；触发后立即撤监听并退回 'aborted'。 */
  signal?: AbortSignal;
  /** 无人接单、超时、中止或监听器抛错时的退回值构造器。 */
  onFallback: (reason: FallbackReason, detail?: string) => Res;
}

/** 登记 onRequestEvent 服务端监听的可选配置。 */
export interface OnRequestEventOptions<Req extends RequestEnvelope, Res extends ResultEnvelope> {
  /** 可选前置过滤器；返回 false 时不置 handled，让后续监听者接单。 */
  filter?: (request: Req) => boolean;
  /** 同步处理完成时立即发出回执，保留原有同步应答的事件顺序。 */
  replySynchronously?: boolean;
  /** 业务处理抛错且存在 requestId 时，将异常转成结构化失败回执发出。 */
  onError?: (error: unknown, request: Req) => StripResultId<Res>;
}

/** 内部最小事件总线视图：避开 cordis.Context 的泛化方法签名限制。 */
interface InternalBus {
  on(name: string, listener: (payload: never) => unknown, options?: boolean | cordis.EventOptions): () => boolean;
  emit(name: string, payload: unknown): void;
  serial(name: string, payload: unknown): Promise<unknown>;
}


/**
 * 发出请求事件并按 requestId 等待回执事件。
 * @param ctx Cordis 上下文。
 * @param requestEventName 请求事件名（serial 投递）。
 * @param resultEventName 回执事件名（emit 回收）。
 * @param payload 不含 requestId 与 handled 的业务载荷。
 * @param options 前缀、超时、中止信号与退回策略。
 * @returns 正常收到的回执，或附带 fallback 原因的退回值。
 */
export async function requestEvent<
  ReqKey extends keyof cordis.Events,
  ResKey extends keyof cordis.Events,
>(
  ctx: cordis.Context,
  requestEventName: ReqKey,
  resultEventName: ResKey,
  payload: StripEnvelope<EventArg<ReqKey>>,
  options: RequestEventOptions<EventArg<ResKey>>,
): Promise<EventArg<ResKey> & RequestFallback> {
  //M 统一附上运输层原因，保留各调用方构造的退回正文。
  const getFallback = (reason: FallbackReason, detail?: string): EventArg<ResKey> & RequestFallback => {
    const result = options.onFallback(reason, detail);
    const metadata = { fallback: reason };
    return Object.assign({}, result, metadata);
  };

  //G 发起前已经被中止：直接按 aborted 退回，不再注册监听与定时器。
  if (options.signal?.aborted === true) return getFallback('aborted');

  const prefix = options.prefix ?? 'req';
  const requestId = `${prefix}_${crypto.randomUUID()}`;
  const fullRequest = { ...(payload as Record<string, unknown>), requestId } as unknown as RequestEnvelope;
  const bus = ctx as unknown as InternalBus;

  return await new Promise<EventArg<ResKey> & RequestFallback>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispose: () => boolean = () => false;

    const onAbort = (): void => {
      //M 外部信号中止时立即结束等待并清理监听。
      finishFallback('aborted');
    };

    const finish = (result: EventArg<ResKey> & RequestFallback): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      //M 退订回执事件监听，避免单次请求后残留监听器。
      dispose();
      resolve(result);
    };

    const finishFallback = (reason: FallbackReason, detail?: string): void => {
      //G 回执或中止已经结束等待时，迟到的失败不再构造第二份结果。
      if (settled) return;

      const result = getFallback(reason, detail);
      finish(result);
    };

    //M 先订回执事件再 serial 发请求，避免监听器同步 emit 回执时漏接。
    dispose = bus.on(String(resultEventName), (event: EventArg<ResKey> & ResultEnvelope) => {
      if (event.requestId !== requestId) return;

      //M 收到匹配当前 requestId 的回执，结束本次请求等待。
      finish(event);
    });

    timer = setTimeout(() => {
      //M 等待回执超时，调用退回构造器收尾。
      finishFallback('timeout');
    }, options.timeoutMs);
    if (options.keepAlive !== true) {
      timer.unref?.();
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });

    //M 串行通知全部请求监听者；全部跑完仍未接单时立即秒退，不傻等超时。
    void bus.serial(String(requestEventName), fullRequest).then(() => {
      if (settled || fullRequest.handled === true) return;

      //G 没有任何监听者置 handled = true：立即退回 unhandled。
      finishFallback('unhandled');
    }).catch((error: unknown) => {
      //M 监听器抛出未捕获异常，按 error 原因走统一退回逻辑。
      const detail = textModule.getErrorMessage(error);
      finishFallback('error', detail);
    });
  });
}


/**
 * 统一登记请求事件监听并回发配对回执。
 * @param ctx Cordis 上下文。
 * @param requestEventName 要监听的请求事件名。
 * @param resultEventName 要回发的回执事件名。
 * @param handler 业务处理函数，返回去掉 requestId 的回执体。
 * @param options 可选过滤器与异常转失败回执处理器。
 * @returns Cordis 注销监听的函数。
 */
export function onRequestEvent<
  ReqKey extends keyof cordis.Events,
  ResKey extends keyof cordis.Events,
>(
  ctx: cordis.Context,
  requestEventName: ReqKey,
  resultEventName: ResKey,
  handler: (request: EventArg<ReqKey>) => StripResultId<EventArg<ResKey>> | Promise<StripResultId<EventArg<ResKey>>>,
  options?: OnRequestEventOptions<EventArg<ReqKey> & RequestEnvelope, EventArg<ResKey> & ResultEnvelope>,
): () => boolean {
  const bus = ctx as unknown as InternalBus;
  //M 在目标上下文挂载请求监听器；命中后同步标记 handled = true。
  return bus.on(String(requestEventName), async (request: EventArg<ReqKey> & RequestEnvelope) => {
    //G 提供了 filter 且当前请求不归自己管时不标记 handled，留给后续监听者或 unhandled 秒退。
    if (options?.filter !== undefined && !options.filter(request)) return;

    request.handled = true;
    try {
      //M 执行业务处理器并收集不含 requestId 的结果正文。
      let body = handler(request);
      if (options?.replySynchronously !== true || body instanceof Promise) {
        body = await body;
      }
      if (request.requestId === undefined) return;

      //M 调用方要求等待回执（带了 requestId）：原样拼上 requestId 广播结果事件。
      bus.emit(String(resultEventName), { ...(body as Record<string, unknown>), requestId: request.requestId });
    } catch (error) {
      if (request.requestId === undefined || options?.onError === undefined) throw error;

      //M 若配置了结构化错误映射，则在原地发回错误回执，防止调用方干等到超时。
      const failed = options.onError(error, request);
      bus.emit(String(resultEventName), { ...(failed as Record<string, unknown>), requestId: request.requestId });
    }
  });
}
