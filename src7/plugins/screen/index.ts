/** 插件入口：注册 screen 的 HTTP 路由和安全事件，使用已有 HTTP 鉴权。 */

import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as streams from 'node:stream';
import * as requests from '../../utils/RequestEvent.ts';
import * as protocol from './Protocol.ts';
import * as runtime from './Screen.ts';

export const name = 'screen';
export const version = '0.3.0';
export const inject = ['resources', 'http'];

interface StatusRequest extends requests.RequestEnvelope {
  /** 基地进程标识；缺省时只查可用性。 */
  clientId?: string;
}

declare module 'cordis' {
  interface Events {
    /** 内部只读查询。 */
    'screen/status'(request: StatusRequest): void | Promise<void>;
    /** 可用性和租约摘要。 */
    'screen/status-result'(result: runtime.StatusResult & requests.ResultEnvelope): void;
    /** 内部状态更新。 */
    'screen/control'(request: protocol.StateInput & requests.RequestEnvelope): void | Promise<void>;
    /** 回传状态动作是否生效。 */
    'screen/control-result'(result: runtime.StateResult & requests.ResultEnvelope): void;
    /** 告知基地已经显示了当前点击的讲解。 */
    'screen/presented'(request: protocol.PresentedInput & requests.RequestEnvelope): void | Promise<void>;
    /** 回传呈现确认和播报状态，不带讲解文本。 */
    'screen/presented-result'(result: runtime.SpeechResult & requests.ResultEnvelope): void;
  }
}

/** 把 Fastify 的解析和容量错误转成固定码；禁止回显原请求或异常。 */
function getFault(error: unknown): protocol.ScreenError {
  if (error instanceof protocol.ScreenError) return error;

  const details = error as { code?: string; statusCode?: number };
  if (details?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    //G 超限交给基地固定 413 提示，避免 Fastify 错误携带输入。
    return new protocol.ScreenError('payload_too_large');
  }
  if (details?.statusCode === 400 || details?.statusCode === 415) {
    //G 解析失败统一按非法输入处理。
    return new protocol.ScreenError('invalid_request');
  }

  //G 拦住未知异常，只返回固定提示。
  return new protocol.ScreenError('model_failed');
}

/** 注册 HTTP 入口，截图和模型回答只经过本插件的私有请求路径。 */
function registerRoutes(scope: fastify.FastifyInstance, screen: runtime.Screen, config: protocol.ScreenConfig): void {
  //G 请求体超过 Fastify 上限或 JSON 无法解析时，不会进入路由处理器。
  scope.setErrorHandler((error, _request, reply) => {
    const issue = getFault(error);
    const body = { ok: false, errorCode: issue.code, message: issue.message };
    return reply.code(issue.status).send(body);
  });

  //M 状态可供未启用的基地查询；给出该客户端的内存租约。
  scope.get('/api/screen/status', async (request) => {
    const query = request.query as { clientId?: unknown };
    if (query.clientId === undefined) return screen.getStatus();

    //G 验证客户端身份，避免把普通查询值放进租约查找。
    const clientId = protocol.getId(query.clientId);
    return screen.getStatus(clientId);
  });

  //M 基地明确开启、心跳或暂停后，更新该客户端的租约。
  const stateOptions = { bodyLimit: protocol.STATE_LIMIT };
  scope.post('/api/screen/state', stateOptions, async (request, reply) => {
    //G 先完成协议和控制字段校验，失败不写租约。
    const input = protocol.getStateInput(request.body);
    try {
      return screen.setState(input);
    } catch (error) {
      //G 失败仍交回原会话和 epoch，方便基地确认哪次更新没生效。
      const issue = getFault(error);
      const body: runtime.StateResult = {
        ok: false,
        sessionId: input.sessionId,
        epoch: input.epoch,
        active: false,
        leaseMs: protocol.LEASE_MS,
        errorCode: issue.code,
      };
      //M 用固定错误码回复此状态动作的失败结果。
      return reply.code(issue.status).send(body);
    }
  });

  //M 有效点击走一次私有请求，并把讲解只交回当前 HTTP 响应。
  const clickOptions = { bodyLimit: protocol.CLICK_LIMIT };
  const receive = (
    run: (
      input: protocol.ClickInput,
      signal: AbortSignal,
      reply: fastify.FastifyReply,
    ) => Promise<unknown>,
    observe: boolean,
  ) => async (request: fastify.FastifyRequest, reply: fastify.FastifyReply) => {
    let identity: protocol.ClickIdentity | undefined;
    const controller = new AbortController();
    const disconnect = (): void => controller.abort();
    reply.raw.once('close', disconnect);
    try {
      //G 先取得可回显的身份，再检查功能开关和其余字段。
      const body = protocol.getRecord(request.body);
      identity = protocol.getClickIdentity(body);
      if (!config.enabled) {
        throw new protocol.ScreenError('disabled');
      }

      //G 功能开启后校验全部点击字段，私有请求只接验证后的输入。
      const click = protocol.getClickInput(body, identity, config, observe);

      //M 连接断开时中止等待并把控制权留给原始连接。
      const result = await run(click, controller.signal, reply);
      if (reply.sent) return reply;
      if (reply.raw.destroyed) return reply.hijack();

      return result;
    } catch (error) {
      if (reply.raw.destroyed) return reply.hijack();

      //G 回送固定中文提示，已解析身份时便于基地丢弃迟到的响应。
      const issue = getFault(error);
      const body = { ok: false, errorCode: issue.code, message: issue.message };
      if (identity !== undefined) {
        const failure = { protocolVersion: protocol.VERSION, ...identity, ...body };
        return reply.code(issue.status).send(failure);
      }

      //G 无法识别点击身份时只发固定错误体。
      return reply.code(issue.status).send(body);
    } finally {
      reply.raw.off('close', disconnect);
    }
  };
  //M 点击优先直接讲解，后台观察受文字裁定保护。
  const explain = (input: protocol.ClickInput, signal: AbortSignal) => screen.explain(input, signal);
  const click = receive(explain, false);
  const observation = receive(screen.observe.bind(screen), true);
  scope.post('/api/screen/click', clickOptions, click);
  scope.post('/api/screen/observe', clickOptions, observation);

  //M 流式入口共享点击校验，只把片段写回这一条响应。
  const streamClick = receive(async (input, signal, reply) => {
    const stream = new streams.PassThrough();
    reply.type('application/x-ndjson').header('cache-control', 'no-store');
    reply.send(stream);
    const send = (frame: Record<string, unknown>): void => {
      if (signal.aborted || stream.destroyed) return;

      //M 每一行都是可独立验签的片段或结束标记。
      const line = JSON.stringify(frame) + '\n';
      stream.write(line);
    };
    try {
      const preview = (result: runtime.ClickResult): void => {
        const frame = { phase: 'partial', ...result };
        send(frame);
      };
      //M 流里先写预览，随后用完整校验结果结束响应。
      const result = await screen.explain(input, signal, preview);
      const frame = { phase: 'done', ...result };
      //M 完成帧同时承载剩余讲解和终止状态。
      send(frame);
    } catch (error) {
      //G 流已经开始时用固定错误标记终止，避免输出供应商原文。
      const issue = getFault(error);
      const frame = { phase: 'error', errorCode: issue.code };
      //M 基地收到失败时撤回本点击的预览。
      send(frame);
    } finally {
      stream.end();
    }
    return reply;
  }, false);
  scope.post('/api/screen/click/stream', clickOptions, streamClick);

  //M 基地确认已经呈现后，按当前会话申请一次可选播报。
  scope.post('/api/screen/presented', stateOptions, async (request) => {
    const input = protocol.getPresentedInput(request.body);
    return await screen.presented(input);
  });
}

/**
 * 加载已授权配置，安装 HTTP 入口及内部事件。注销会释放临时内存并取消模型。
 * @param ctx 当前插件的 Cordis 上下文。
 */
export function apply(ctx: cordis.Context): void {
  //M 应用启用与默认值配置，创建仅路由和事件闭包能访问的运行时实例。
  const raw = ctx.resources.raw['screen'];
  const config = protocol.getConfig(raw);
  const screen = new runtime.Screen(ctx, config);

  //M 一个 Fastify 子作用域只给 screen 的入口应用解析错误格式。
  ctx.http.app.register(async (scope) => {
    registerRoutes(scope, screen, config);
  });

  //M 内部只读状态查询与 HTTP 共用同一个 lease 状态。
  requests.onRequestEvent(ctx, 'screen/status', 'screen/status-result', (request) => {
    return screen.getStatus(request.clientId);
  });

  //M 控制事件不包含任何点击正文，沿用状态入口的 lease 行为。
  requests.onRequestEvent(ctx, 'screen/control', 'screen/control-result', (request) => {
    try {
      return screen.setState(request);
    } catch (error) {
      const issue = getFault(error);
      return {
        ok: false,
        sessionId: request.sessionId,
        epoch: request.epoch,
        active: false,
        leaseMs: protocol.LEASE_MS,
        errorCode: issue.code,
      };
    }
  });

  //M 呈现确认只接点击身份；讲话文本只能从当前短期回执取。
  requests.onRequestEvent(ctx, 'screen/presented', 'screen/presented-result', async (request) => {
    try {
      return await screen.presented(request);
    } catch (error) {
      const issue = getFault(error);
      return { ok: false, errorCode: issue.code };
    }
  });

  //M 插件卸载时取消模型请求和清掉短时回执。
  ctx.effect(() => () => {
    screen.dispose();
  });
}
