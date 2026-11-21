/**
 * 通用请求-回执事件工具（#113 插件解耦底座）：
 *   1. requestEvent：先挂回执监听，再 serial 派发请求；没人接单立即退回，接单后按需报警，调用方可用 signal 中止；
 *   2. onRequestEvent：统一在进入异步逻辑前标 handled = true，完成后仅当存在 requestId 时回发配对回执。
 * 说明：供插件之间一问一答，复用请求与回执的等待逻辑。渠道协议见 src7/plugins/channels/。
 * 等多久由处理方定（比如飞书每个接口限 60 秒）；提问方自己要限时，就传 AbortSignal.timeout(...)。
 */
import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import * as textModule from './Text.ts';


/** 请求没拿到业务回执的原因：没人接单、调用方中止（含自己设的时限到了）、处理方抛错。 */
export type FallbackReason = 'unhandled' | 'aborted' | 'error';

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

/** requestEvent 的等待选项。 */
interface RequestWaitOptions {
  /** requestId 前缀，如 'apr'、'dec'、'cat'；不给默认 'req'。 */
  prefix?: string;
  /** 超过此毫秒数时写一条警告，继续等回执。 */
  warnAfterMs?: number;
  /** 可选中止信号；触发后立即撤监听并退回 'aborted'。要限时就传 AbortSignal.timeout(...)。 */
  signal?: AbortSignal;
}

/** 收到业务回执，或说明本次为何没有收到。 */
export type Asked<Res> =
  | { reply: Res; why?: undefined }
  | { reply?: undefined; why: FallbackReason; detail?: string };

/** 登记 onRequestEvent 服务端监听的可选配置。 */
export interface OnRequestEventOptions<Req extends RequestEnvelope, Res extends ResultEnvelope> {
  /** 可选前置过滤器；返回 false 时不置 handled，让后续监听者接单。 */
  filter?: (request: Req) => boolean;
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
 * @param options 前缀、报警时刻和中止信号。
 * @returns 收到回执交回 { reply }；没人接单、中止、处理方抛错交回 { why, detail? }。
 */
export async function requestEvent<
  ReqKey extends keyof cordis.Events,
  ResKey extends keyof cordis.Events,
>(
  ctx: cordis.Context,
  requestEventName: ReqKey,
  resultEventName: ResKey,
  payload: StripEnvelope<EventArg<ReqKey>>,
  options: RequestWaitOptions = {},
): Promise<Asked<EventArg<ResKey>>> {
  type Answer = Asked<EventArg<ResKey>>;

  //G 发起前已经被中止：直接按 aborted 退回，不再注册监听与定时器。
  if (options.signal?.aborted === true) return { why: 'aborted' };

  const prefix = options.prefix ?? 'req';
  const requestId = `${prefix}_${crypto.randomUUID()}`;
  const requestName = String(requestEventName);
  const fullRequest = { ...(payload as Record<string, unknown>), requestId } as unknown as RequestEnvelope;
  const bus = ctx as unknown as InternalBus;

  return await new Promise<Answer>((resolve) => {
    let settled = false;
    let warning: ReturnType<typeof setTimeout> | undefined;
    let dispose: () => boolean = () => false;

    const onAbort = (): void => {
      //M 外部信号中止（含调用方自己设的时限到了）时立即结束等待并清理监听。
      finish({ why: 'aborted' });
    };

    const finish = (result: Answer): void => {
      //G 回执、中止、出错谁先到算谁，迟到的不再交第二份结果。
      if (settled) return;

      settled = true;
      clearTimeout(warning);
      options.signal?.removeEventListener('abort', onAbort);
      //M 退订回执事件监听，避免单次请求后残留监听器。
      dispose();
      resolve(result);
    };

    //M 先订回执事件再 serial 发请求，避免监听器同步 emit 回执时漏接。
    dispose = bus.on(String(resultEventName), (event: EventArg<ResKey> & ResultEnvelope) => {
      if (event.requestId !== requestId) return;

      //M 收到匹配当前 requestId 的回执，结束本次请求等待。
      finish({ reply: event });
    });

    //M 报警只写一行，回执监听继续保留。
    const waitedMs = options.warnAfterMs;
    if (waitedMs !== undefined) {
      warning = setTimeout(() => {
        console.warn(`等待事件 ${requestName} 回执已达 ${String(waitedMs)} 毫秒（${requestId}），继续等待`);
      }, waitedMs);
      warning.unref?.();
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });

    //M 串行通知全部请求监听者；全部跑完仍未接单时立即秒退，不傻等。
    void bus.serial(requestName, fullRequest).then(() => {
      if (fullRequest.handled === true) return;

      //G 没有任何监听者置 handled = true：立即退回 unhandled。
      finish({ why: 'unhandled' });
    }).catch((error: unknown) => {
      //M 监听器抛出未捕获异常：退回 error，带上异常文字。
      const detail = textModule.getErrorMessage(error);
      finish({ why: 'error', detail });
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
      const body = await handler(request);
      if (request.requestId === undefined) return;

      //M 调用方要求等待回执（带了 requestId）：原样拼上 requestId 广播结果事件。
      bus.emit(String(resultEventName), { ...(body as Record<string, unknown>), requestId: request.requestId });
    } catch (error) {
      if (request.requestId === undefined || options?.onError === undefined) throw error;

      //M 若配置了结构化错误映射，则在原地发回错误回执，防止调用方干等。
      const failed = options.onError(error, request);
      bus.emit(String(resultEventName), { ...(failed as Record<string, unknown>), requestId: request.requestId });
    }
  });
}


/**
 * 这次请求的结果说不准：处理方抛了错，或者调用方中止了，事情可能已经做了一半。
 * 没人接单（unhandled）是确定没做，不算。
 */
export function isUncertain(
  asked: Asked<unknown>,
): asked is { reply?: undefined; why: 'aborted' | 'error'; detail?: string } {
  if (asked.why === 'aborted') return true;

  return asked.why === 'error';
}
